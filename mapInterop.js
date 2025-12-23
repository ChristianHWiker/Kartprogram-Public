import { AssetManager, Renderer, Geometry } from './renderCore.js';

const state = {
    map: null,
    canvas: null,
    ctx: null,
    buildingCanvas: null,
    buildingCtx: null,
    drawing: false,
    lastPoint: null,
    startPoint: null,
    mode: "draw",
    strokeColor: "#ef4444",
    strokeWidth: 4,
    draft: null,
    features: [],
    activeGroupId: null, // "global" or building ID
    featureStore: { "global": [] }, // Partitioned storage
    interaction: null // { type, startPoint, startFeature, handle }
};

let maplibrePromise;
let lastOverpassFetch = 0;
let buildingListener = null;
let selectionListener = null;

function getNextZIndex() {
    if (!state.features.length) return 0;
    return (
        state.features.reduce((max, f) => {
            const z = typeof f.zIndex === "number" ? f.zIndex : 0;
            return Math.max(max, z);
        }, -1) + 1
    );
}

function withFeatureMetadata(feature, fallbackZ = 0) {
    if (!feature) return feature;
    // Mutate existing object to preserve references during interactions
    if (!feature.id) feature.id = crypto.randomUUID();
    if (typeof feature.zIndex !== "number") feature.zIndex = fallbackZ;
    if (feature.groupId === undefined) feature.groupId = null;
    return feature;
}

function sortByZIndex(features) {
    return [...features].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

function ensureFeatureMetadata() {
    state.features.forEach((f, idx) => withFeatureMetadata(f, idx));
}

function normalizeZFromOrder() {
    ensureFeatureMetadata();
    state.features.forEach((f, i) => {
        f.zIndex = i;
    });
}

function normalizeAndSortZ() {
    ensureFeatureMetadata();
    state.features = sortByZIndex(state.features);
    normalizeZFromOrder();
}

function ensureHistory() {
    if (!state.history || !Array.isArray(state.history.past) || !Array.isArray(state.history.future)) {
        state.history = { past: [], future: [] };
    }
}

function cloneFeature(f) {
    return {
        ...f,
        points: Array.isArray(f.points) ? f.points.map((p) => ({ ...p })) : []
    };
}

function snapshotState() {
    ensureHistory();
    return {
        features: state.features.map(cloneFeature),
        selectedFeatureId: state.selectedFeatureId || null
    };
}

function pushHistory() {
    ensureHistory();
    const snap = snapshotState();
    state.history.past.push(snap);
    if (state.history.past.length > 100) {
        state.history.past.shift();
    }
    state.history.future = [];
}

function applySnapshot(snap) {
    if (!snap) return;
    ensureHistory();
    state.features = snap.features.map(cloneFeature);
    state.selectedFeatureId = snap.selectedFeatureId || null;
    redraw();
}

function ensureCanvasSize(container, canvas) {
    if (!container || !canvas) return;
    const { width, height } = container.getBoundingClientRect();
    if (width === canvas.width && height === canvas.height) return;
    canvas.width = width;
    canvas.height = height;
    canvas.style.zIndex = "2";
}

function ensureBuildingCanvasSize(container, canvas) {
    if (!container || !canvas) return;
    const { width, height } = container.getBoundingClientRect();
    if (width === canvas.width && height === canvas.height) return;
    canvas.width = width;
    canvas.height = height;
    canvas.style.zIndex = "3";
}


function ensureMapLibre() {
    if (window.maplibregl) {
        return Promise.resolve(window.maplibregl);
    }
    if (maplibrePromise) return maplibrePromise;

    maplibrePromise = new Promise((resolve, reject) => {
        // Try local path if not loaded
        const script = document.createElement("script");
        script.src = "lib/maplibre/maplibre-gl.js";
        script.async = true;
        script.onload = () => resolve(window.maplibregl);
        script.onerror = () => {
            // Fallback to CDN? Or just reject.
            console.warn("Local MapLibre failed, trying CDN...");
            const cdnScript = document.createElement("script");
            cdnScript.src = "https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js";
            cdnScript.async = true;
            cdnScript.onload = () => resolve(window.maplibregl);
            cdnScript.onerror = () => reject(new Error("Failed to load maplibre-gl from Local and CDN"));
            document.head.appendChild(cdnScript);
        };
        document.head.appendChild(script);
    });

    return maplibrePromise;
}

function setPointerMode() {
    if (!state.map || !state.canvas) return;
    if (state.mode === "pan") {
        state.canvas.style.pointerEvents = "none";
        state.map.dragPan.enable();
        state.map.scrollZoom.enable();
        state.map.boxZoom.enable();
        state.map.getCanvas().style.pointerEvents = "auto";
        state.canvas.style.cursor = "grab";
        state.map.getCanvas().style.cursor = "grab";
    } else if (state.mode === "building") {
        state.canvas.style.pointerEvents = "none";
        state.map.dragPan.disable();
        state.map.scrollZoom.enable();
        state.map.boxZoom.disable();
        state.map.getCanvas().style.pointerEvents = "auto";
        state.map.getCanvas().style.cursor = "pointer";
        state.canvas.style.cursor = "pointer";
    } else if (state.mode === "select") {
        state.canvas.style.pointerEvents = "auto";
        state.map.dragPan.disable();
        state.map.scrollZoom.enable();
        state.map.boxZoom.disable();
        state.map.getCanvas().style.pointerEvents = "none";
        state.map.getCanvas().style.cursor = "default";
        state.canvas.style.cursor = "default";
    }
    else {
        state.canvas.style.pointerEvents = "auto";
        state.map.dragPan.disable();
        state.map.scrollZoom.disable();
        state.map.boxZoom.disable();
        state.map.getCanvas().style.pointerEvents = "none";
        state.canvas.style.cursor = "crosshair";
        state.map.getCanvas().style.cursor = "crosshair";
    }
    state.map.touchZoomRotate.disableRotation();
    state.map.setPitch(0);
    state.map.setBearing(0);
    if (state.map.getZoom() < 1.5) state.map.setZoom(1.5);
}

function beginDrawing(e) {
    if (!state.ctx || state.mode === "pan" || state.mode === "building") return;

    const { offsetX, offsetY } = e;

    if (state.mode === "select") {
        e.preventDefault();
        e.stopPropagation();
        state.canvas.setPointerCapture(e.pointerId);

        // 1. Try hitting handles of current selection
        if (state.selectedFeatureId) {
            const feature = state.features.find(f => f.id === state.selectedFeatureId);
            if (feature) {
                const pts = feature.points.map(projectPoint);
                const bounds = Geometry.getFeatureBounds(state.ctx, feature, pts);
                const handle = Geometry.hitTestHandles(offsetX, offsetY, bounds);
                if (handle) {
                    state.interaction = {
                        type: handle.type,
                        handle: handle.handle,
                        startPoint: { x: offsetX, y: offsetY },
                        feature: feature,
                        startCenter: bounds.center,
                        startRotation: feature.rotation || 0,
                        startWidth: feature.width || 4,
                        startPoints: feature.points.map(p => ({ ...p })),
                        startWorldPoint: state.map.unproject([offsetX, offsetY])
                    };
                    state.drawing = true;
                    state.lastPoint = { x: offsetX, y: offsetY };
                    return;
                }
            }
        }

        // 2. Try selecting (or dragging) a feature
        const clickResult = findFeatureAt(offsetX, offsetY);
        if (clickResult.feature) {
            state.selectedFeatureId = clickResult.feature.id;
            notifySelection(clickResult.feature);

            const pts = clickResult.feature.points.map(projectPoint);
            const bounds = Geometry.getFeatureBounds(state.ctx, clickResult.feature, pts);

            // Start drag interaction immediately
            state.interaction = {
                type: 'drag',
                handle: 'move',
                startPoint: { x: offsetX, y: offsetY },
                feature: clickResult.feature,
                startPoints: clickResult.feature.points.map(p => ({ ...p })),
                startCenter: bounds.center,
                startWorldPoint: state.map.unproject([offsetX, offsetY])
            };
            state.drawing = true;
            state.lastPoint = { x: offsetX, y: offsetY };
        } else {
            state.selectedFeatureId = null;
            notifySelection(null);
        }
        redraw();
        return;
    }

    if (state.mode === "polygon") {
        handlePolygonClick(e);
        return;
    }

    if (state.mode === "erase") {
        eraseAt(offsetX, offsetY);
        return;
    }

    const lngLat = state.map.unproject([offsetX, offsetY]);
    state.drawing = true;
    state.lastPoint = { x: offsetX, y: offsetY };
    state.startPoint = { x: offsetX, y: offsetY };
    state.draft = {
        type: state.mode,
        color: state.strokeColor,
        width: state.strokeWidth,
        points: [{ lng: lngLat.lng, lat: lngLat.lat }],
        id: crypto.randomUUID(),
        zIndex: getNextZIndex(),
        groupId: state.activeGroupId // Assign active group
    };

    if (state.mode === "point" || state.mode === "trap" || state.mode === "bait" || state.mode === "flykiller" ||
        state.mode === "insect_trap" || state.mode === "foam" || state.mode === "detector" || state.mode === "note" ||
        state.mode === "door" || state.mode === "window") {

        if (state.mode === "note") {
            const text = prompt("Enter note text:");
            if (!text) return;
            state.draft.text = text;
        }

        pushHistory();
        state.features.push(state.draft);
        state.draft = null;
        state.drawing = false;
        state.startPoint = null;
        redraw();
    }
}

function draw(e) {
    if (!state.drawing || !state.ctx || !state.lastPoint || state.mode === "erase") return;
    const { offsetX, offsetY } = e;

    if (state.mode === "select" && state.interaction) {
        updateTransform(e);
        return;
    }

    if (state.mode === "select") return;

    const lngLat = state.map.unproject([offsetX, offsetY]);

    if (state.mode === "polygon") {
        state.polygonHover = { lng: lngLat.lng, lat: lngLat.lat };
        redraw();
        return;
    }

    if (state.mode === "draw") {
        state.draft.points.push({ lng: lngLat.lng, lat: lngLat.lat });
        redraw();
        state.lastPoint = { x: offsetX, y: offsetY };
    } else {
        state.draft.points[1] = { lng: lngLat.lng, lat: lngLat.lat };
        redraw();
    }
}

function endDrawing(e) {
    if (state.mode === "select") {
        if (state.interaction) {
            pushHistory();
            state.interaction = null;
            state.drawing = false;
            redraw();
        }
        return;
    }

    if (state.mode === "polygon") {
        return;
    }

    if (!state.drawing || !state.ctx || !state.startPoint) {
        state.drawing = false;
        state.lastPoint = null;
        state.startPoint = null;
        return;
    }

    const lngLat = state.map.unproject([e.offsetX, e.offsetY]);
    if (state.mode !== "draw" && state.mode !== "point" && state.mode !== "trap" && state.mode !== "bait" &&
        state.mode !== "flykiller" && state.mode !== "insect_trap" && state.mode !== "foam" &&
        state.mode !== "detector" && state.mode !== "note" && state.mode !== "door" && state.mode !== "window") {
        state.draft.points[1] = { lng: lngLat.lng, lat: lngLat.lat };
    }

    if (state.draft) {
        pushHistory();
        state.features.push(state.draft);
    }
    redraw();

    if (state.canvas && e.pointerId !== undefined) {
        try { state.canvas.releasePointerCapture(e.pointerId); } catch (e) { }
    }

    state.drawing = false;
    state.lastPoint = null;
    state.startPoint = null;
    state.draft = null;
}

function projectPoint(pt) {
    if (!state.map) return { x: 0, y: 0 };
    const p = state.map.project([pt.lng, pt.lat]);
    return { x: p.x, y: p.y };
}





function redraw() {
    if (!state.ctx || !state.canvas || !state.map) return;
    state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    ensureFeatureMetadata();

    const toScreenPoints = (pts) => pts.map(projectPoint);

    const drawFeature = (feature) => {
        const color = feature.color;
        const width = feature.width;
        state.ctx.strokeStyle = color;
        state.ctx.fillStyle = color;
        state.ctx.lineWidth = width;
        switch (feature.type) {
            case "draw": {
                const pts = toScreenPoints(feature.points);
                if (pts.length < 2) return;
                Renderer.drawGeometry(state.ctx, pts, { color, width, fill: false }, "polyline");
                break;
            }
            case "line": {
                if (feature.points.length < 2) return;
                const [a, b] = toScreenPoints(feature.points);
                Renderer.drawGeometry(state.ctx, [a, b], { color, width, fill: false }, "line");
                break;
            }
            case "rectangle": {
                if (feature.points.length < 2) return;
                const [a, b] = toScreenPoints(feature.points);
                Renderer.drawGeometry(state.ctx, [a, b], { color, width, fill: false }, "rectangle");
                break;
            }
            case "circle": {
                if (feature.points.length < 2) return;
                const [c1, c2] = toScreenPoints(feature.points);
                Renderer.drawGeometry(state.ctx, [c1, c2], { color, width, fill: true }, "circle");
                break;
            }
            case "point": {
                const [p] = toScreenPoints(feature.points);
                Renderer.drawGeometry(state.ctx, [p], { color, width, fill: true }, "point");
                break;
            }
            case "note": {
                const [p] = toScreenPoints(feature.points);
                Renderer.drawNote(state.ctx, feature.text, p.x, p.y, color, width, feature.rotation);
                break;
            }
            default: {
                if (AssetManager.get(feature.type)) {
                    const [iconPt] = toScreenPoints(feature.points);
                    Renderer.drawIcon(state.ctx, feature.type, iconPt.x, iconPt.y, width, feature.rotation);
                }
                break;
            }
        }
    };

    // Filter features based on activeGroupId for isolation
    // Simplified Redraw: state.features is ALREADY isolated.
    // No filtering needed.
    const ordered = sortByZIndex(state.features);
    ordered.forEach(drawFeature);

    if (state.selectedFeatureId) {
        const selected = ordered.find((f) => f.id === state.selectedFeatureId);
        if (selected) {
            const pts = selected.points.map(projectPoint);
            Renderer.drawSelectionOverlay(state.ctx, selected, pts);
        }
    }

    if (state.draft) {
        if (state.draft.type === "polygon" && state.polygonHover) {
            const hoverFeature = {
                ...state.draft,
                points: [...state.draft.points, state.polygonHover]
            };
            drawFeature(hoverFeature);
        } else {
            drawFeature(state.draft);
        }
    }

    redrawBuilding();
}

function loadAssets() {
    return AssetManager.loadAll().then(() => {
        redraw();
    });
}











function updateTransform(e) {
    const inter = state.interaction;
    if (!inter || !inter.feature) return;

    const { offsetX, offsetY } = e;
    const center = inter.startCenter;

    if (inter.type === "drag") {
        const currentWorld = state.map.unproject([offsetX, offsetY]);
        const dxWorld = currentWorld.lng - inter.startWorldPoint.lng;
        const dyWorld = currentWorld.lat - inter.startWorldPoint.lat;

        inter.feature.points = inter.startPoints.map(p => ({
            lng: p.lng + dxWorld,
            lat: p.lat + dyWorld
        }));
    } else if (inter.type === "rotate") {
        const startRad = Math.atan2(inter.startPoint.y - center.y, inter.startPoint.x - center.x);
        const currRad = Math.atan2(offsetY - center.y, offsetX - center.x);
        const deltaDeg = (currRad - startRad) * 180 / Math.PI;

        const isPointBased = inter.feature.type === "point" || inter.feature.type === "note" || AssetManager.get(inter.feature.type);

        if (isPointBased) {
            inter.feature.rotation = inter.startRotation + deltaDeg;
        } else {
            const rad = deltaDeg * Math.PI / 180;
            inter.feature.points = inter.startPoints.map(p => {
                const screen = projectPoint(p);
                const dx = screen.x - center.x;
                const dy = screen.y - center.y;
                const nx = dx * Math.cos(rad) - dy * Math.sin(rad);
                const ny = dx * Math.sin(rad) + dy * Math.cos(rad);
                const rotated = state.map.unproject([center.x + nx, center.y + ny]);
                return { lng: rotated.lng, lat: rotated.lat };
            });
        }
    } else if (inter.type === "scale" || inter.type === "scale-axis") {
        const isPointBased = inter.feature.type === "point" || inter.feature.type === "note" || AssetManager.get(inter.feature.type);

        if (inter.type === "scale") {
            const startDist = Math.hypot(inter.startPoint.x - center.x, inter.startPoint.y - center.y);
            const currDist = Math.hypot(offsetX - center.x, offsetY - center.y);

            // Prevent division by zero or negative scale
            if (startDist < 1) return;
            const scale = currDist / startDist;

            if (isPointBased) {
                inter.feature.width = Math.round(Math.max(1, inter.startWidth * scale));
            } else {
                inter.feature.points = inter.startPoints.map(p => {
                    const screen = projectPoint(p);
                    const dx = screen.x - center.x;
                    const dy = screen.y - center.y;
                    const nx = dx * scale;
                    const ny = dy * scale;
                    const scaled = state.map.unproject([center.x + nx, center.y + ny]);
                    return { lng: scaled.lng, lat: scaled.lat };
                });
            }
        } else {
            // axis scaling
            let sx = 1, sy = 1;
            const dx = Math.abs(offsetX - center.x);
            const dy = Math.abs(offsetY - center.y);
            const sdx = Math.abs(inter.startPoint.x - center.x);
            const sdy = Math.abs(inter.startPoint.y - center.y);

            if (inter.handle === "left" || inter.handle === "right") {
                if (sdx < 1) return;
                sx = dx / sdx;
            }
            if (inter.handle === "top" || inter.handle === "bottom") {
                if (sdy < 1) return;
                sy = dy / sdy;
            }

            if (isPointBased) {
                const scale = (inter.handle === "left" || inter.handle === "right") ? sx : sy;
                inter.feature.width = Math.round(Math.max(1, inter.startWidth * scale));
            } else {
                inter.feature.points = inter.startPoints.map(p => {
                    const screen = projectPoint(p);
                    const sdx_p = screen.x - center.x;
                    const sdy_p = screen.y - center.y;
                    const nx = sdx_p * sx;
                    const ny = sdy_p * sy;
                    const scaled = state.map.unproject([center.x + nx, center.y + ny]);
                    return { lng: scaled.lng, lat: scaled.lat };
                });
            }
        }
    }

    redraw();
}

function eraseAt(x, y) {
    if (!state.map || state.features.length === 0) return;
    const threshold = 20;
    let bestIndex = -1;
    let bestDistance = Infinity;

    const distanceToFeature = (feature) => {
        const pts = feature.points.map(projectPoint);
        if (!pts.length) return Infinity;
        if (pts.length === 1) {
            return Math.hypot(pts[0].x - x, pts[0].y - y);
        }

        let min = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
            min = Math.min(min, pointToSegmentDistance(x, y, pts[i], pts[i + 1]));
        }
        return min;
    };

    state.features.forEach((f, i) => {
        const d = distanceToFeature(f);
        if (d < bestDistance) {
            bestDistance = d;
            bestIndex = i;
        }
    });

    if (bestIndex >= 0 && bestDistance <= threshold) {
        const removed = state.features[bestIndex];
        pushHistory();
        state.features.splice(bestIndex, 1);
        if (removed && removed.id && state.selectedFeatureId === removed.id) {
            state.selectedFeatureId = null;
        }
        normalizeZFromOrder();
        redraw();
    }
}

function redrawBuilding() {
    if (!state.buildingCtx || !state.buildingCanvas) return;
    state.buildingCtx.clearRect(0, 0, state.buildingCanvas.width, state.buildingCanvas.height);
    if (!state.buildingFeatures.length || !state.map) return;

    state.buildingCtx.strokeStyle = "#dc2626";
    state.buildingCtx.fillStyle = "rgba(220,38,38,0.12)";
    state.buildingCtx.lineWidth = 2;
    state.buildingCtx.setLineDash([6, 6]);

    state.buildingFeatures.forEach((ring) => {
        const pts = ring.map(projectPoint);
        if (pts.length < 3) return;
        state.buildingCtx.beginPath();
        state.buildingCtx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            state.buildingCtx.lineTo(pts[i].x, pts[i].y);
        }
        state.buildingCtx.closePath();
        state.buildingCtx.fill();
        state.buildingCtx.stroke();
    });

    state.buildingCtx.setLineDash([]);
}

function extractBuildingFromFeature(feature) {
    if (!feature || !feature.geometry) return null;
    const geom = feature.geometry;
    if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
        return geom.coordinates[0].map(([lng, lat]) => ({ lng, lat }));
    }
    if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
        return geom.coordinates[0][0].map(([lng, lat]) => ({ lng, lat }));
    }
    return null;
}

function closeRing(ring) {
    if (!ring.length) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first.lng !== last.lng || first.lat !== last.lat) {
        ring.push({ ...first });
    }
    return ring;
}

function pointInPolygon(lng, lat, ring) {
    return Geometry.pointInPolygon({ x: lng, y: lat }, ring);
}

function distanceToPolygon(lng, lat, ring) {
    let minDist = Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        // Use Geometry names (lng->x, lat->y)
        const p1 = { x: a.lng, y: a.lat };
        const p2 = { x: b.lng, y: b.lat };
        const dist = Geometry.pointToSegmentDistance(lng, lat, p1, p2);
        if (dist < minDist) minDist = dist;
    }
    return minDist;
}



function findClosestBuilding(lng, lat, rings) {
    // First check if click is inside any building
    for (const ring of rings) {
        if (pointInPolygon(lng, lat, ring)) {
            return ring;
        }
    }
    // Otherwise find the nearest building
    let closest = null;
    let minDist = Infinity;
    for (const ring of rings) {
        const dist = distanceToPolygon(lng, lat, ring);
        if (dist < minDist) {
            minDist = dist;
            closest = ring;
        }
    }
    return closest;
}

function selectNearbyBuildings(lng, lat, rings) {
    const thresholdDeg = 0.0018; // ~200m at mid-latitudes
    const scored = rings.map((ring) => {
        const inside = pointInPolygon(lng, lat, ring);
        const dist = inside ? 0 : distanceToPolygon(lng, lat, ring);
        return { ring, dist };
    });

    const nearby = scored
        .filter((s) => s.dist <= thresholdDeg)
        .sort((a, b) => a.dist - b.dist)
        .map((s) => s.ring);

    if (nearby.length) {
        return nearby.slice(0, 10);
    }

    // fallback: closest few if none within threshold
    return scored
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5)
        .map((s) => s.ring);
}

function parseOverpassBuildings(json) {
    if (!json || !Array.isArray(json.elements)) return [];
    const rings = [];
    for (const el of json.elements) {
        if (Array.isArray(el.geometry) && el.geometry.length >= 3) {
            const ring = closeRing(el.geometry.map((g) => ({ lng: g.lon, lat: g.lat })));
            if (ring.length >= 4) {
                rings.push(ring);
            }
        }
    }
    return rings;
}

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://z.overpass-api.de/api/interpreter"
];
let lastGoodOverpass = OVERPASS_ENDPOINTS[0];

async function fetchBuildingsFromOverpass(lng, lat) {
    const now = Date.now();
    if (now - lastOverpassFetch < 2500) {
        return [];
    }
    lastOverpassFetch = now;

    const latDelta = 0.003; // ~330m radius
    const lonDelta = 0.003 / Math.max(Math.cos((lat * Math.PI) / 180), 0.3);
    const south = lat - latDelta;
    const north = lat + latDelta;
    const west = lng - lonDelta;
    const east = lng + lonDelta;

    const query = `
        [out:json][timeout:25];
        (
            way["building"](${south},${west},${north},${east});
            relation["building"](${south},${west},${north},${east});
        );
        out body geom;
    `;
    const orderedEndpoints = [lastGoodOverpass, ...OVERPASS_ENDPOINTS.filter((e) => e !== lastGoodOverpass)];
    for (const endpoint of orderedEndpoints) {
        try {
            const resp = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json"
                },
                body: `data=${encodeURIComponent(query)}`
            });
            if (!resp.ok) {
                if (resp.status === 429 || resp.status === 504 || resp.status === 503) continue;
                continue;
            }
            const json = await resp.json();
            const rings = parseOverpassBuildings(json);
            if (rings.length) {
                lastGoodOverpass = endpoint;
                return rings;
            }
        } catch (err) {
            // move to next endpoint
            continue;
        }
    }
    console.warn("Overpass unavailable or returned no buildings for this area.");
    return [];
}

async function handleMapClick(e) {
    if (!state.map) return;

    if (state.mode === "select") {
        handleSelectClick(e);
        return;
    }

    if (state.mode !== "building") return;

    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;
    const forceOverpass = !!(e.originalEvent && e.originalEvent.shiftKey);
    console.debug("[building] map click", {
        lng,
        lat,
        hasBuildings: state.buildingFeatures.length,
        forceOverpass
    });

    console.debug("[building] querying Overpass for buildings");
    const rings = await fetchBuildingsFromOverpass(lng, lat);
    if (!rings.length) {
        console.debug("[building] Overpass returned no buildings");
        state.buildingFeatures = [];
        redrawBuilding();
        notifyBuildingSelection(null);
        return;
    }

    state.buildingFeatures = selectNearbyBuildings(lng, lat, rings);
    // primary ring for editor: closest
    const primary = findClosestBuilding(lng, lat, rings);
    redrawBuilding();
    if (primary) {
        console.debug("[building] notifying selection from Overpass result");
        notifyBuildingSelection(primary);
    }
}

function notifyBuildingSelection(primaryRing) {
    console.debug("[building] notifyBuildingSelection", {
        hasListener: !!buildingListener,
        ringPoints: Array.isArray(primaryRing) ? primaryRing.length : "none"
    });
    if (buildingListener) {
        try {
            buildingListener.invokeMethodAsync("OnBuildingsSelected", primaryRing && Array.isArray(primaryRing) ? primaryRing : null);
        } catch (err) {
            console.warn("Failed to notify building selection", err);
        }
    }
}

function findFeatureAt(x, y) {
    if (!state.map || !state.features.length) return { feature: null, dist: Infinity };
    ensureFeatureMetadata();
    const clickPoint = { x, y };
    let best = null;
    let bestDist = Infinity;
    const thresholdPx = 18;

    const pointDist = (feature) => {
        const pts = feature.points || [];
        if (!pts.length) return Infinity;
        const screenPts = pts.map(p => projectPoint(p));
        if (screenPts.length === 1) {
            return Math.hypot(screenPts[0].x - clickPoint.x, screenPts[0].y - clickPoint.y);
        }
        let min = Infinity;
        for (let i = 0; i < screenPts.length - 1; i++) {
            min = Math.min(min, Geometry.pointToSegmentDistance(clickPoint.x, clickPoint.y, screenPts[i], screenPts[i + 1]));
        }
        return min;
    };

    state.features.forEach((f) => {
        const d = pointDist(f);
        if (d < bestDist) {
            bestDist = d;
            best = f;
        }
    });

    if (best && bestDist <= thresholdPx) {
        return { feature: best, dist: bestDist };
    }
    return { feature: null, dist: Infinity };
}

function handleSelectClick(e) {
    if (state.mode === "select") return; // Handled by canvas beginDrawing

    // This is now mostly fallback logic if selection fails or for specific map-layer items
    const { offsetX, offsetY } = e.originalEvent || {};
    if (offsetX === undefined) return;
    const result = findFeatureAt(offsetX, offsetY);
    if (result.feature) {
        state.selectedFeatureId = result.feature.id;
        notifySelection(result.feature);
    } else {
        state.selectedFeatureId = null;
        notifySelection(null);
    }
    redraw();
}

function notifySelection(feature) {
    if (selectionListener) {
        try {
            selectionListener.invokeMethodAsync("OnFeatureSelected", feature);
        } catch (err) {
            console.warn("Failed to notify selection", err);
        }
    }
}

export async function init(mapElement, canvasElement, buildingCanvas = null) {
    const maplibre = await ensureMapLibre();
    loadAssets();

    // Reset state for new map session (fixes SPA persistence issue)
    state.features = [];
    state.featureStore = { "global": [] };
    state.activeGroupId = null;
    state.selectedFeatureId = null;
    state.buildingFeatures = [];
    state.history = { past: [], future: [] };

    const style = {
        version: 8,
        sources: {
            "osm-tiles": {
                type: "raster",
                tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                tileSize: 256,
                attribution: "© OpenStreetMap contributors"
            }
        },
        layers: [
            {
                id: "osm-tiles",
                type: "raster",
                source: "osm-tiles",
                minzoom: 0,
                maxzoom: 19
            }
        ]
    };

    const container = mapElement;
    const canvas = canvasElement;
    if (!container || !canvas) {
        return;
    }

    ensureCanvasSize(container, canvas);
    state.canvas = canvas;
    state.ctx = canvas.getContext("2d");
    canvas.style.touchAction = "none";

    // DIAGNOSTIC: Check WebGL Support (Safely)
    try {
        if (maplibre && typeof maplibre.supported === 'function') {
            if (!maplibre.supported()) {
                console.error("WebGL not supported");
                // We won't alert here to avoid spamming if it returns false incorrectly on some emulators
            }
        }
    } catch (e) {
        console.warn("Error checking WebGL support:", e);
    }

    if (buildingCanvas) {
        ensureBuildingCanvasSize(container, buildingCanvas);
        state.buildingCanvas = buildingCanvas;
        state.buildingCtx = buildingCanvas.getContext("2d");
        buildingCanvas.style.pointerEvents = "none";
    }

    canvas.addEventListener("pointerdown", beginDrawing);
    canvas.addEventListener("pointermove", draw);
    canvas.addEventListener("pointerup", endDrawing);
    canvas.addEventListener("pointerleave", endDrawing);
    canvas.addEventListener("dblclick", (e) => {
        if (state.mode === "polygon") {
            e.preventDefault();
            finalizePolygonDraft();
        }
    });

    state.map = new maplibre.Map({
        container,
        style,
        center: [14, 65],
        zoom: 4,
        minZoom: 1.5,
        maxZoom: 18,
        pitch: 0,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false
    });

    state.map.touchZoomRotate.disableRotation();
    state.map.doubleClickZoom.disable();
    state.map.addControl(new maplibre.NavigationControl({ showCompass: false }), "bottom-right");
    state.map.on("click", handleMapClick);

    // DIAGNOSTIC: Report Map Errors (Tiles)
    state.map.on("error", (e) => {
        console.error("MapLibre Error:", e);
        if (e && e.error && e.error.message && (e.error.message.includes("Failed to fetch") || e.error.status === 404)) {
            // Only alert once to avoid spam
            if (!state.hasAlertedError) {
                alert("Network Error: Cannot load map tiles. Check Emulator Internet.");
                state.hasAlertedError = true;
            }
        }
    });

    // Initial canvas sizing
    ensureCanvasSize(container, canvas);
    if (buildingCanvas) ensureBuildingCanvasSize(container, buildingCanvas);

    ensureHistory();
    if (!state.history.past.length && !state.features.length) {
        pushHistory();
    }

    setPointerMode();
    state.map.on("move", redraw);
    state.map.on("zoom", redraw);
    // Standard resize handler
    state.map.on("resize", () => {
        ensureCanvasSize(container, canvas);
        if (buildingCanvas) ensureBuildingCanvasSize(container, buildingCanvas);
        redraw();
    });

    redraw();

    state.map.on('style.load', () => console.log("MapLibre: Style Loaded"));
    state.map.on('load', () => {
        console.log("MapLibre: Map Fully Loaded");
        state.map.resize(); // Force resize once loaded
    });
    state.map.on('data', (e) => {
        if (e.dataType === 'source' && e.isSourceLoaded) console.log("MapLibre: Source Loaded");
    });
    state.map.on('dataloading', (e) => console.log("MapLibre: Data Loading...", e.dataType));

    // ResizeObserver to handle layout shifts (e.g. mobile toolbar wrapping)
    const resizeObserver = new ResizeObserver(() => {
        ensureCanvasSize(container, canvas);
        if (buildingCanvas) ensureBuildingCanvasSize(container, buildingCanvas);
        if (state.map) state.map.resize();
        redraw();
    });
    resizeObserver.observe(container);
}

function handlePolygonClick(e) {
    if (!state.map || !state.ctx) return;
    const { offsetX, offsetY, detail } = e;
    const lngLat = state.map.unproject([offsetX, offsetY]);
    const pt = { lng: lngLat.lng, lat: lngLat.lat };

    if (!state.draft || state.draft.type !== "polygon") {
        state.draft = {
            type: "polygon",
            color: state.strokeColor,
            width: state.strokeWidth,
            points: [pt],
            id: crypto.randomUUID(),
            zIndex: getNextZIndex(),
            groupId: state.activeGroupId
        };
    } else {
        state.draft.points.push(pt);
    }

    // Double-click (detail >= 2) closes polygon if we have 3+ points
    if (detail >= 2) {
        finalizePolygonDraft();
    }

    redraw();
}

function finalizePolygonDraft() {
    if (!state.draft || state.draft.type !== "polygon" || !state.draft.points || state.draft.points.length < 3) {
        return;
    }
    const closed = closeRing([...state.draft.points]);
    pushHistory();
    state.features.push({
        type: "polygon",
        color: state.draft.color,
        width: state.draft.width,
        points: closed,
        id: state.draft.id || crypto.randomUUID(),
        zIndex: typeof state.draft.zIndex === "number" ? state.draft.zIndex : getNextZIndex(),
        groupId: state.draft.groupId
    });
    state.draft = null;
    state.polygonHover = null;
    redraw();
}

export function clearCanvas() {
    if (!state.canvas || !state.ctx) return;
    pushHistory();

    if (state.activeGroupId) {
        // Only clear features belonging to the active group (current partition)
        state.features = [];
    } else {
        // Global clear
        state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        state.features = [];
        // Optional: Should global clear wipe ALL buildings? 
        // User asked for "Isolated", so probably NOT. Global clear wipes 'global'.
    }

    state.selectedFeatureId = null;
    if (state.buildingCtx && state.buildingCanvas) {
        state.buildingCtx.clearRect(0, 0, state.buildingCanvas.width, state.buildingCanvas.height);
        state.buildingFeatures = [];
    }
    redraw();
}

export function setActiveGroupId(id) {
    const newGroupId = id || "global"; // Default to 'global' if null/empty
    const currentGroupId = state.activeGroupId || "global";

    if (newGroupId === currentGroupId) return;

    // 1. Save current features to store
    state.featureStore[currentGroupId] = state.features;

    // 2. Load new features from store (or init empty)
    if (!state.featureStore[newGroupId]) {
        state.featureStore[newGroupId] = [];
    }
    state.features = state.featureStore[newGroupId];

    // 3. Update active ID
    state.activeGroupId = id || null;

    // 4. Reset selection
    state.selectedFeatureId = null;

    // 5. Redraw (state.features is now purely the isolated set)
    redraw();
}

export function setMode(mode) {
    state.mode = mode;
    if (mode !== "select" && state.selectedFeatureId) {
        state.selectedFeatureId = null;
        notifySelection(null);
        redraw();
    }
    setPointerMode();
}

export function setStyle(color, width) {
    state.strokeColor = color;
    state.strokeWidth = width;
}

export function registerBuildingListener(dotNetRef) {
    buildingListener = dotNetRef;
}

export function registerSelectionListener(dotNetRef) {
    selectionListener = dotNetRef;
}

// State helpers for persistence
// State helpers for persistence
export function exportFeatures() {
    // 1. Sync current features back to store
    const currentGroup = state.activeGroupId || "global";
    state.featureStore[currentGroup] = state.features;

    // 2. Flatten all partitions
    let allFeatures = [];
    for (const key in state.featureStore) {
        allFeatures = allFeatures.concat(state.featureStore[key]);
    }

    // 3. Sort/Normalize
    // We can't rely on global z-index sorting across groups easily, 
    // but export should probably just return the list.
    return allFeatures;
}

export function importFeatures(features) {
    if (!Array.isArray(features)) return;

    // 1. Reset Store
    state.featureStore = { "global": [] };

    // 2. Distribute features
    features.forEach(f => {
        const gid = f.groupId || "global";
        if (!state.featureStore[gid]) {
            state.featureStore[gid] = [];
        }
        state.featureStore[gid].push(f);
    });

    // 3. Load into current view
    const currentGroup = state.activeGroupId || "global";
    state.features = state.featureStore[currentGroup] || [];

    redraw();
}



export function getView() {
    if (!state.map) return null;
    const center = state.map.getCenter();
    return {
        lng: center.lng,
        lat: center.lat,
        zoom: state.map.getZoom()
    };
}

export function setView(view) {
    if (!state.map || !view) return;
    if (typeof view.lng === "number" && typeof view.lat === "number") {
        state.map.setCenter([view.lng, view.lat]);
    }
    if (typeof view.zoom === "number") {
        state.map.setZoom(view.zoom);
    }
}

export function downloadJson(filename, content) {
    try {
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || "map.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.warn("downloadJson failed", err);
    }
}

export function deleteSelected() {
    if (!state.selectedFeatureId) return;
    const idx = state.features.findIndex((f) => f.id === state.selectedFeatureId);
    if (idx >= 0) {
        pushHistory();
        state.features.splice(idx, 1);
        state.selectedFeatureId = null;
        normalizeZFromOrder();
        redraw();
    }
}

export function bringToFront() {
    shiftSelected(1);
}

export function sendToBack() {
    shiftSelected(-1);
}

export function getSelectedId() {
    return state.selectedFeatureId;
}

export function clearBuildingSelection() {
    state.buildingFeatures = [];
    if (state.buildingCtx && state.buildingCanvas) {
        state.buildingCtx.clearRect(0, 0, state.buildingCanvas.width, state.buildingCanvas.height);
    }
    notifyBuildingSelection(null);
}

function shiftSelected(delta) {
    if (!state.selectedFeatureId) return;
    ensureFeatureMetadata();
    state.features = sortByZIndex(state.features);
    const idx = state.features.findIndex((f) => f.id === state.selectedFeatureId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= state.features.length) return;
    pushHistory();
    const [item] = state.features.splice(idx, 1);
    state.features.splice(target, 0, item);
    normalizeZFromOrder();
    redraw();
}

export function undo() {
    return undoInternal();
}

export function redo() {
    return redoInternal();
}

function undoInternal() {
    ensureHistory();
    if (!state.history.past.length) return state.selectedFeatureId;
    const current = snapshotState();
    const prev = state.history.past.pop();
    state.history.future.push(current);
    applySnapshot(prev);
    return state.selectedFeatureId;
}

function redoInternal() {
    ensureHistory();
    if (!state.history.future.length) return state.selectedFeatureId;
    const current = snapshotState();
    const next = state.history.future.pop();
    state.history.past.push(current);
    applySnapshot(next);
    return state.selectedFeatureId;
}

export function rotateSelectedFeature(angle) {
    if (!state.selectedFeatureId) return;
    const feature = state.features.find(f => f.id === state.selectedFeatureId);
    if (feature) {
        feature.rotation = angle;
        redraw();
    }
}
