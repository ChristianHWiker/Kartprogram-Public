import { AssetManager, Renderer, Geometry } from './renderCore.js';

const editorState = {
    canvas: null,
    ctx: null,
    outline: [],
    transform: null,
    padding: 24,
    cosLat: 1,
    floors: {},
    activeFloor: null,
    drawing: false,
    currentStroke: null,
    strokeColor: "#ef4444",
    strokeWidth: 2,
    outlineColor: "#ef4444",
    outlineFill: "rgba(239,68,68,0.08)",
    mode: "draw",
    panelDragInitialized: false,
    resizeObserver: null,
    view: {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        rotation: 0
    },
    panState: null,
    imageOverlay: null,
    pixelRatio: 1,
    cssWidth: 0,
    cssHeight: 0,
    imageInteraction: null,
    assetsLoaded: false,
    activeBuildingId: null, // "global" or building key
    selectedStrokeId: null, // Track currently selected feature
    imageLocked: false,
    store: {}, // Key -> { floors: {...}, activeFloor: "..." }
    activePointers: new Map() // ID -> { x, y }
};

function loadAssets() {
    return AssetManager.loadAll().then(() => {
        editorState.assetsLoaded = true;
        redraw();
    });
}

function computeTransform() {
    if (!editorState.canvas || !editorState.outline.length) return;
    const minLng = Math.min(...editorState.outline.map((p) => p.lng));
    const maxLng = Math.max(...editorState.outline.map((p) => p.lng));
    const minLat = Math.min(...editorState.outline.map((p) => p.lat));
    const maxLat = Math.max(...editorState.outline.map((p) => p.lat));
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.max(Math.cos((midLat * Math.PI) / 180), 0.01);

    // Normalize longitude span by latitude to avoid 2.5D stretching
    const width = (maxLng - minLng) * cosLat || 1;
    const height = maxLat - minLat || 1;

    const widthPx = editorState.cssWidth || (editorState.canvas ? editorState.canvas.width / (editorState.pixelRatio || 1) : 0);
    const heightPx = editorState.cssHeight || (editorState.canvas ? editorState.canvas.height / (editorState.pixelRatio || 1) : 0);
    const viewW = widthPx - editorState.padding * 2;
    const viewH = heightPx - editorState.padding * 2;
    const scale = Math.min(viewW / width, viewH / height);

    editorState.transform = {
        minLng,
        maxLat,
        scale,
        cosLat
    };
}

function project(point) {
    if (!editorState.transform) return { x: 0, y: 0 };
    const base = baseProject(point);
    return applyView(base);
}

function baseProject(point) {
    if (!editorState.transform) return { x: 0, y: 0 };
    const { minLng, maxLat, scale, cosLat } = editorState.transform;
    return {
        x: (point.lng - minLng) * cosLat * scale + editorState.padding,
        y: (maxLat - point.lat) * scale + editorState.padding
    };
}

function unproject(x, y) {
    if (!editorState.transform) return { lng: 0, lat: 0 };
    const viewAdjusted = removeView({ x, y });
    x = viewAdjusted.x;
    y = viewAdjusted.y;
    const { minLng, maxLat, scale, cosLat } = editorState.transform;
    return {
        lng: (x - editorState.padding) / (scale * cosLat) + minLng,
        lat: maxLat - (y - editorState.padding) / scale
    };
}

function applyView(pt) {
    const s = editorState.view?.scale || 1;
    const ox = editorState.view?.offsetX || 0;
    const oy = editorState.view?.offsetY || 0;
    const rot = (editorState.view?.rotation || 0) * (Math.PI / 180);
    const { x: cx, y: cy } = getRotationCenter();
    // translate to rotation center, rotate, then scale/offset
    const tx = pt.x - cx;
    const ty = pt.y - cy;
    const rx = tx * Math.cos(rot) - ty * Math.sin(rot);
    const ry = tx * Math.sin(rot) + ty * Math.cos(rot);
    return {
        x: (rx + cx + ox) * s,
        y: (ry + cy + oy) * s
    };
}

function removeView(pt) {
    const s = editorState.view?.scale || 1;
    const ox = editorState.view?.offsetX || 0;
    const oy = editorState.view?.offsetY || 0;
    const rot = (editorState.view?.rotation || 0) * (Math.PI / 180);
    const { x: cx, y: cy } = getRotationCenter();
    return {
        x: (pt.x / s - ox - cx) * Math.cos(-rot) - (pt.y / s - oy - cy) * Math.sin(-rot) + cx,
        y: (pt.x / s - ox - cx) * Math.sin(-rot) + (pt.y / s - oy - cy) * Math.cos(-rot) + cy
    };
}

function getRotationCenter() {
    if (editorState.outline && editorState.outline.length && editorState.transform) {
        const pts = editorState.outline.map(baseProject);
        if (pts.length) {
            const sum = pts.reduce(
                (acc, p) => {
                    acc.x += p.x;
                    acc.y += p.y;
                    return acc;
                },
                { x: 0, y: 0 }
            );
            return { x: sum.x / pts.length, y: sum.y / pts.length };
        }
    }
    const cx = editorState.canvas ? editorState.canvas.width / 2 : 0;
    const cy = editorState.canvas ? editorState.canvas.height / 2 : 0;
    return { x: cx, y: cy };
}

function estimateOutlineAngle() {
    if (!editorState.outline || editorState.outline.length < 2) return 0;

    // Project outline to a local planar space (lng scaled by cos(lat))
    const latCenter =
        editorState.outline.reduce((sum, p) => sum + p.lat, 0) / editorState.outline.length;
    const cosLat = Math.max(Math.cos((latCenter * Math.PI) / 180), 0.01);
    const pts = editorState.outline.map((p) => ({
        x: p.lng * cosLat,
        y: p.lat
    }));

    // Compute covariance for PCA
    const n = pts.length;
    const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
    const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
    let varX = 0,
        varY = 0,
        covXY = 0;
    pts.forEach((p) => {
        const dx = p.x - meanX;
        const dy = p.y - meanY;
        varX += dx * dx;
        varY += dy * dy;
        covXY += dx * dy;
    });
    varX /= n;
    varY /= n;
    covXY /= n;

    const angle = 0.5 * Math.atan2(2 * covXY, varX - varY); // principal axis
    let deg = (angle * 180) / Math.PI;
    if (isNaN(deg)) deg = 0;
    return deg;
}

function ensureCanvasSize() {
    if (!editorState.canvas) return;
    const rect = editorState.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    if (editorState.canvas.width !== cssW * dpr || editorState.canvas.height !== cssH * dpr || editorState.pixelRatio !== dpr) {
        editorState.pixelRatio = dpr;
        editorState.cssWidth = cssW;
        editorState.cssHeight = cssH;
        editorState.canvas.width = cssW * dpr;
        editorState.canvas.height = cssH * dpr;
        if (editorState.ctx) {
            editorState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        computeTransform();
        redraw();
    }
}

const angleDiff = (a, b) => {
    let d = Math.abs(a - b) % 180;
    if (d > 90) d = 180 - d;
    return d;
};

// Rebuilt to prefer "Snap to Angle"
function estimateEdgeAngle(currentRotation) {
    if (!editorState.outline || editorState.outline.length < 2) return 0;
    const pts = editorState.outline;
    const cosLat = editorState.transform?.cosLat || 1;
    const edges = [];

    // build edges
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (!a || !b) continue;
        const dx = (b.lng - a.lng) * cosLat;
        const dy = b.lat - a.lat;
        const len = Math.hypot(dx, dy);
        if (len <= 0) continue;
        // Angle in degrees -180 to 180
        if (len <= 0) continue;
        // Angle in degrees -180 to 180
        // Fix: Negate dy because Screen Y increases Down, while Lat increases Up.
        // We want the angle in Screen Space to match Image Rotation (Clockwise)
        const angle = Math.atan2(-dy, dx) * (180 / Math.PI);
        edges.push({ len, angle });
    }

    if (!edges.length) return currentRotation || 0;

    const maxLen = Math.max(...edges.map((e) => e.len));
    const minLen = maxLen * 0.1; // ignore tiny segments
    // Filter noise
    const candidates = edges.filter((e) => e.len >= minLen);

    const target = (currentRotation || 0);

    let bestAngle = target;
    let minDiff = Infinity;

    candidates.forEach(e => {

        const wallAng = e.angle;

        [0, 90, 180, -90].forEach(offset => {
            const testAng = wallAng + offset;
            const diff = angleDiff(testAng, target); // 0..90

            if (diff < minDiff) {
                minDiff = diff;
                bestAngle = testAng;
            }
        });
    });

    return bestAngle;
}

function screenToLocal(center, rotationDeg, point) {
    const rad = (-rotationDeg * Math.PI) / 180;
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: dx * Math.cos(rad) - dy * Math.sin(rad),
        y: dx * Math.sin(rad) + dy * Math.cos(rad)
    };
}

function getImageScreenCenter(frame) {
    return project(frame.center);
}

function hitTestImage(x, y) {
    if (editorState.imageLocked) return null;
    const overlay = getActiveOverlay();
    if (!overlay?.frame) return null;
    const frame = overlay.frame;
    const corners = getImageScreenFrame(frame);
    const pts = [corners.tl, corners.tr, corners.br, corners.bl];
    const handleSize = 10;
    const edgeHandleSize = 12;

    const hitHandle = (pt) => Math.abs(pt.x - x) <= handleSize && Math.abs(pt.y - y) <= handleSize;
    if (hitHandle(corners.tl)) return { type: "scale", handle: "tl" };
    if (hitHandle(corners.tr)) return { type: "scale", handle: "tr" };
    if (hitHandle(corners.br)) return { type: "scale", handle: "br" };
    if (hitHandle(corners.bl)) return { type: "scale", handle: "bl" };

    const rotateHandle = { x: (corners.tl.x + corners.tr.x) / 2, y: (corners.tl.y + corners.tr.y) / 2 - 18 };
    if (hitHandle(rotateHandle)) return { type: "rotate", handle: "rotate" };

    // Edge handles for axis-only scaling
    const edges = [
        { name: "top", x: (corners.tl.x + corners.tr.x) / 2, y: (corners.tl.y + corners.tr.y) / 2 },
        { name: "right", x: (corners.tr.x + corners.br.x) / 2, y: (corners.tr.y + corners.br.y) / 2 },
        { name: "bottom", x: (corners.bl.x + corners.br.x) / 2, y: (corners.bl.y + corners.br.y) / 2 },
        { name: "left", x: (corners.tl.x + corners.bl.x) / 2, y: (corners.tl.y + corners.bl.y) / 2 }
    ];
    const hitEdge = (pt) =>
        Math.abs(pt.x - x) <= edgeHandleSize / 2 && Math.abs(pt.y - y) <= edgeHandleSize / 2;
    for (const edge of edges) {
        if (hitEdge(edge)) {
            return { type: "scale-axis", handle: edge.name };
        }
    }

    // hit test inside polygon
    if (pointInQuad({ x, y }, pts)) {
        return { type: "drag", handle: "move" };
    }
    return null;
}

function pointInQuad(p, quad) {
    // quad ordered tl, tr, br, bl
    let inside = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
        const xi = quad[i].x, yi = quad[i].y;
        const xj = quad[j].x, yj = quad[j].y;
        const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function startImageInteraction(hit, e) {
    const overlay = getActiveOverlay();
    const frame = overlay?.frame;
    if (!frame) return;
    const corners = getImageScreenFrame(frame);
    const halfW =
        Math.max(1, Math.hypot(corners.tr.x - corners.tl.x, corners.tr.y - corners.tl.y) / 2);
    const halfH =
        Math.max(1, Math.hypot(corners.br.x - corners.tr.x, corners.br.y - corners.tr.y) / 2);
    const centerScreen = getImageScreenCenter(frame);
    const startLocal = screenToLocal(centerScreen, frame.rotation || 0, {
        x: e.offsetX,
        y: e.offsetY
    });

    editorState.imageInteraction = {
        type: hit.type,
        handle: hit.handle,
        startWorld: unproject(e.offsetX, e.offsetY),
        startFrame: { ...frame },
        halfW,
        halfH,
        startLocal,
        startAngle: Math.atan2(startLocal.y, startLocal.x),
        startPointer: { x: e.offsetX, y: e.offsetY }
    };
}

function updateImageInteraction(e) {
    const inter = editorState.imageInteraction;
    if (!inter) return;

    if (inter.target === 'stroke') {
        const stroke = inter.stroke;
        const center = inter.startCenter;

        if (inter.type === "drag") {
            const currentWorld = unproject(e.offsetX, e.offsetY);
            const dxWorld = currentWorld.lng - inter.startWorld.lng;
            const dyWorld = currentWorld.lat - inter.startWorld.lat;

            stroke.points = inter.startPoints.map(p => ({
                lng: p.lng + dxWorld,
                lat: p.lat + dyWorld
            }));
        } else if (inter.type === "rotate") {
            const angleNow = Math.atan2(e.offsetY - center.y, e.offsetX - center.x);
            const startAngle = Math.atan2(inter.startPoint.y - center.y, inter.startPoint.x - center.x);
            const deltaDeg = (angleNow - startAngle) * 180 / Math.PI;

            const isPointBased = stroke.type === "note" || stroke.type === "point" || AssetManager.get(stroke.type);
            if (isPointBased) {
                stroke.rotation = inter.startRotation + deltaDeg;
            } else {
                const rad = deltaDeg * Math.PI / 180;
                stroke.points = inter.startPoints.map(p => {
                    const sc = project(p);
                    const dx = sc.x - center.x;
                    const dy = sc.y - center.y;
                    const nx = dx * Math.cos(rad) - dy * Math.sin(rad);
                    const ny = dx * Math.sin(rad) + dy * Math.cos(rad);
                    return unproject(center.x + nx, center.y + ny);
                });
            }
        } else if (inter.type === "scale" || inter.type === "scale-axis") {
            const isPointBased = stroke.type === "note" || stroke.type === "point" || AssetManager.get(stroke.type);

            if (inter.type === "scale") {
                const startDist = Math.hypot(inter.startPoint.x - center.x, inter.startPoint.y - center.y);
                const currDist = Math.hypot(e.offsetX - center.x, e.offsetY - center.y);
                if (startDist < 1) return;
                const scale = currDist / startDist;

                if (isPointBased) {
                    stroke.width = Math.max(1, Math.round(inter.startWidth * scale));
                } else {
                    stroke.points = inter.startPoints.map(p => {
                        const sc = project(p);
                        const dx = (sc.x - center.x) * scale;
                        const dy = (sc.y - center.y) * scale;
                        return unproject(center.x + dx, center.y + dy);
                    });
                }
            } else {
                // axis scaling
                let sx = 1, sy = 1;
                const sdx = Math.abs(inter.startPoint.x - center.x);
                const sdy = Math.abs(inter.startPoint.y - center.y);
                const dx = Math.abs(e.offsetX - center.x);
                const dy = Math.abs(e.offsetY - center.y);

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
                    stroke.width = Math.max(1, Math.round(inter.startWidth * scale));
                } else {
                    stroke.points = inter.startPoints.map(p => {
                        const sc = project(p);
                        const nx = (sc.x - center.x) * sx;
                        const ny = (sc.y - center.y) * sy;
                        return unproject(center.x + nx, center.y + ny);
                    });
                }
            }
        }
        redraw();
        return;
    }

    const overlay = getActiveOverlay();
    if (!overlay?.frame) return;
    const frame = overlay.frame;

    if (inter.type === "drag") {
        const current = unproject(e.offsetX, e.offsetY);
        const dx = current.lng - inter.startWorld.lng;
        const dy = current.lat - inter.startWorld.lat;
        frame.center = {
            lng: inter.startFrame.center.lng + dx,
            lat: inter.startFrame.center.lat + dy
        };
        redraw();
        return;
    }

    const centerScreen = getImageScreenCenter(inter.startFrame);
    const currentLocal = screenToLocal(centerScreen, inter.startFrame.rotation || 0, {
        x: e.offsetX,
        y: e.offsetY
    });

    if (inter.type === "scale") {
        const sx = Math.max(0.1, Math.abs(currentLocal.x) / Math.max(1, inter.halfW));
        const sy = Math.max(0.1, Math.abs(currentLocal.y) / Math.max(1, inter.halfH));
        const scale = Math.max(sx, sy);
        frame.widthLng = Math.max(0.00001, inter.startFrame.widthLng * scale);
        frame.heightLat = Math.max(0.00001, inter.startFrame.heightLat * scale);
        redraw();
        return;
    }

    if (inter.type === "scale-axis") {
        const minHalfPx = 4;
        const rotateBack = (pt) => {
            const rad = (inter.startFrame.rotation || 0) * (Math.PI / 180);
            return {
                x: pt.x * Math.cos(rad) - pt.y * Math.sin(rad),
                y: pt.x * Math.sin(rad) + pt.y * Math.cos(rad)
            };
        };
        const centerScreen = getImageScreenCenter(inter.startFrame);
        let newHalfW = inter.halfW;
        let newHalfH = inter.halfH;
        let shiftLocal = { x: 0, y: 0 };

        switch (inter.handle) {
            case "left": {
                newHalfW = Math.max(minHalfPx, (inter.halfW - currentLocal.x) / 2);
                shiftLocal.x = (currentLocal.x + inter.halfW) / 2;
                break;
            }
            case "right": {
                newHalfW = Math.max(minHalfPx, (currentLocal.x + inter.halfW) / 2);
                shiftLocal.x = (currentLocal.x - inter.halfW) / 2;
                break;
            }
            case "top": {
                newHalfH = Math.max(minHalfPx, (inter.halfH - currentLocal.y) / 2);
                shiftLocal.y = (currentLocal.y + inter.halfH) / 2;
                break;
            }
            case "bottom": {
                newHalfH = Math.max(minHalfPx, (currentLocal.y + inter.halfH) / 2);
                shiftLocal.y = (currentLocal.y - inter.halfH) / 2;
                break;
            }
            default:
                break;
        }

        // update size based on ratio to starting half sizes
        frame.widthLng = Math.max(0.00001, inter.startFrame.widthLng * (newHalfW / inter.halfW));
        frame.heightLat = Math.max(0.00001, inter.startFrame.heightLat * (newHalfH / inter.halfH));

        // shift center accordingly
        const shiftScreen = rotateBack(shiftLocal);
        const newCenterScreen = {
            x: centerScreen.x + shiftScreen.x,
            y: centerScreen.y + shiftScreen.y
        };
        const newCenter = unproject(newCenterScreen.x, newCenterScreen.y);
        frame.center = newCenter;

        redraw();
        return;
    }

    if (inter.type === "rotate") {
        const angleNow = Math.atan2(currentLocal.y, currentLocal.x);
        const delta = angleNow - inter.startAngle;
        // clockwise mouse motion rotates clockwise
        frame.rotation = inter.startFrame.rotation + (delta * 180) / Math.PI;
        redraw();
    }
}

function endImageInteraction() {
    editorState.imageInteraction = null;
}

function drawOutline() {
    if (!editorState.ctx || !editorState.outline.length || !editorState.transform) return;
    const pts = editorState.outline.map(project);
    if (pts.length < 2) return;
    editorState.ctx.save();
    editorState.ctx.fillStyle = editorState.outlineFill || "rgba(239,68,68,0.08)";
    editorState.ctx.beginPath();
    editorState.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        editorState.ctx.lineTo(pts[i].x, pts[i].y);
    }
    editorState.ctx.closePath();
    editorState.ctx.fill();

    editorState.ctx.strokeStyle = editorState.outlineColor || "#dc2626";
    editorState.ctx.lineWidth = 2;
    editorState.ctx.setLineDash([6, 6]);
    editorState.ctx.beginPath();
    editorState.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        editorState.ctx.lineTo(pts[i].x, pts[i].y);
    }
    editorState.ctx.closePath();
    editorState.ctx.stroke();
    editorState.ctx.setLineDash([]);
    editorState.ctx.restore();
}

function drawImageOverlay() {
    const overlay = getActiveOverlay();
    if (!editorState.ctx || !overlay || !overlay.img || !editorState.transform) return;
    const frame = overlay.frame;
    if (!frame) return;
    const img = overlay.img;
    if (!img.complete) return;

    const corners = getImageScreenFrame(frame);
    const tl = corners.tl;
    const tr = corners.tr;
    const bl = corners.bl;
    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;

    const a = (tr.x - tl.x) / imgW;
    const b = (tr.y - tl.y) / imgW;
    const c = (bl.x - tl.x) / imgH;
    const d = (bl.y - tl.y) / imgH;
    const e = tl.x;
    const f = tl.y;
    const pr = editorState.pixelRatio || 1;

    editorState.ctx.save();
    // reset to pixel ratio then apply mapping from image space to screen space
    editorState.ctx.setTransform(a * pr, b * pr, c * pr, d * pr, e * pr, f * pr);
    editorState.ctx.globalAlpha = overlay.opacity ?? 0.6;
    editorState.ctx.drawImage(img, 0, 0);
    editorState.ctx.restore();

    if (editorState.mode === "select") {
        drawImageControls();
    }
}

function redraw() {
    if (!editorState.ctx || !editorState.canvas) return;
    editorState.ctx.clearRect(0, 0, editorState.canvas.width, editorState.canvas.height);
    drawOutline();
    drawImageOverlay();

    if (!editorState.activeFloor) return;
    const floor = editorState.floors[editorState.activeFloor];
    if (!floor) return;

    editorState.ctx.save();
    editorState.ctx.lineCap = "round";

    floor.strokes.forEach((stroke) => {
        if (!stroke || !stroke.points || !stroke.points.length) return;

        if (stroke.type === "note") {
            const pt = project(stroke.points[0]);
            const width = stroke.width || 4;
            const rotation = stroke.rotation || 0;
            const color = stroke.color || editorState.strokeColor || "#ef4444";
            Renderer.drawNote(editorState.ctx, stroke.text, pt.x, pt.y, color, width, rotation);
            return;
        }

        // Generic icon handler
        if (AssetManager.get(stroke.type)) {
            const pt = project(stroke.points[0]);
            const rotation = stroke.rotation || 0;
            const width = stroke.width || 4;
            Renderer.drawIcon(editorState.ctx, stroke.type, pt.x, pt.y, width, rotation);
            return;
        }

        const color = stroke.color || editorState.strokeColor || "#ef4444";
        const width = stroke.width || editorState.strokeWidth || 2;
        const shouldFill = !!stroke.fill && stroke.points.length >= 3;

        const pts = stroke.points.map(project);

        // Pass to generic renderer too? Or keep local shape logic?
        // Let's use Renderer for consistency
        Renderer.drawGeometry(editorState.ctx, pts, { color, width, fill: shouldFill }, stroke.type);

    });

    // Draw selection handles for selected stroke
    if (editorState.selectedStrokeId !== null && editorState.mode === "select") {
        const selected = floor.strokes.find(s => (s.id || floor.strokes.indexOf(s)) === editorState.selectedStrokeId);
        if (selected) {
            const pts = selected.points.map(project);
            Renderer.drawSelectionOverlay(editorState.ctx, selected, pts);
        }
    }

    // Draw current in-progress stroke
    if (editorState.drawing && editorState.currentStroke && editorState.currentStroke.points.length) {
        const pts = editorState.currentStroke.points.map(project);
        Renderer.drawGeometry(editorState.ctx, pts, {
            color: editorState.currentStroke.color || editorState.strokeColor || "#ef4444",
            width: editorState.currentStroke.width || editorState.strokeWidth || 2,
            fill: !!editorState.currentStroke.fill && editorState.currentStroke.points.length >= 3
        }, editorState.currentStroke.type);
    }
    editorState.ctx.restore();
    // Log current state for debugging
    console.debug("[building-editor] redraw", {
        strokeColor: editorState.strokeColor,
        strokeWidth: editorState.strokeWidth,
        mode: editorState.mode,
        strokes: floor ? floor.strokes.length : 0
    });
}



function findStrokeAt(x, y) {
    if (!editorState.activeFloor) return null;
    const floor = editorState.floors[editorState.activeFloor];
    if (!floor || !floor.strokes.length) return null;

    const threshold = 18;
    let best = null;
    let bestDist = Infinity;

    const distanceToStroke = (stroke) => {
        const pts = stroke.points.map(project);
        if (!pts.length) return Infinity;

        if (stroke.type === "note" || stroke.type === "point" || AssetManager.get(stroke.type)) {
            return Math.hypot(pts[0].x - x, pts[0].y - y);
        }

        let min = Infinity;
        if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y);

        for (let i = 0; i < pts.length - 1; i++) {
            min = Math.min(min, Geometry.pointToSegmentDistance(x, y, pts[i], pts[i + 1]));
        }
        return min;
    };

    floor.strokes.forEach((s) => {
        const d = distanceToStroke(s);
        if (d < bestDist) {
            bestDist = d;
            best = s;
        }
    });

    if (best && bestDist <= threshold) return best;
    return null;
}

function eraseAt(x, y) {
    if (!editorState.activeFloor) return;
    const floor = editorState.floors[editorState.activeFloor];
    if (!floor || !floor.strokes.length) return;

    const stroke = findStrokeAt(x, y);
    if (stroke) {
        const idx = floor.strokes.indexOf(stroke);
        if (idx >= 0) {
            floor.strokes.splice(idx, 1);
            if (editorState.selectedStrokeId === (stroke.id || idx)) {
                editorState.selectedStrokeId = null;
            }
            redraw();
        }
    }
}



function beginDraw(e) {
    if (editorState.canvas) {
        // Track pointer
        editorState.activePointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

        try {
            editorState.canvas.setPointerCapture(e.pointerId);
        } catch (err) { }
    }

    if (e.cancelable) e.preventDefault();
    if (!editorState.canvas || !editorState.transform) return;

    // PINCH ZOOM CHECK: If 2 pointers, we are pinching/panning, NOT drawing
    if (editorState.activePointers.size === 2) {
        editorState.drawing = false;
        editorState.currentStroke = null;
        editorState.pinchStartDist = getPinchDist();
        editorState.pinchStartScale = editorState.view.scale || 1;
        return;
    }

    // If > 2 pointers, ignore
    if (editorState.activePointers.size > 1) return;


    // Feature selection in building editor
    if (editorState.mode === "select" && editorState.activeFloor) {
        const floor = editorState.floors[editorState.activeFloor];
        if (floor) {
            // 1. Try hitting handles of current selection
            if (editorState.selectedStrokeId !== null) {
                const selected = floor.strokes.find(s => (s.id || floor.strokes.indexOf(s)) === editorState.selectedStrokeId);
                if (selected) {
                    const pts = selected.points.map(project);
                    const bounds = Geometry.getFeatureBounds(editorState.ctx, selected, pts);
                    const hit = Geometry.hitTestHandles(e.offsetX, e.offsetY, bounds);
                    if (hit) {
                        editorState.imageInteraction = {
                            type: hit.type,
                            handle: hit.handle,
                            target: 'stroke',
                            stroke: selected,
                            startWorld: unproject(e.offsetX, e.offsetY),
                            startPoints: selected.points.map(p => ({ ...p })),
                            startCenter: bounds.center,
                            startRotation: selected.rotation || 0,
                            startWidth: selected.width || 4,
                            startPoint: { x: e.offsetX, y: e.offsetY }
                        };
                        return;
                    }
                }
            }

            // 2. Try selecting a new stroke
            const found = findStrokeAt(e.offsetX, e.offsetY);
            if (found) {
                const idx = floor.strokes.indexOf(found);
                editorState.selectedStrokeId = found.id || idx;
                const pts = found.points.map(project);
                const bounds = Geometry.getFeatureBounds(editorState.ctx, found, pts);
                editorState.imageInteraction = {
                    type: 'drag',
                    handle: 'move',
                    target: 'stroke',
                    stroke: found,
                    startWorld: unproject(e.offsetX, e.offsetY),
                    startPoints: found.points.map(p => ({ ...p })),
                    startCenter: bounds.center,
                    startRotation: found.rotation || 0,
                    startWidth: found.width || 4,
                    startPoint: { x: e.offsetX, y: e.offsetY }
                };
                redraw();
                return;
            } else {
                editorState.selectedStrokeId = null;
                redraw();
            }

            // 3. Fallback to image manipulation if no features were hit
            const overlay = getActiveOverlay();
            if (overlay?.frame && !editorState.imageLocked) {
                const hit = hitTestImage(e.offsetX, e.offsetY);
                if (hit) {
                    startImageInteraction(hit, e);
                    return;
                }
            }
        }
        return;
    }

    if (!editorState.activeFloor) return;
    // Pan mode
    if (editorState.mode === "pan") {
        editorState.panState = {
            startX: e.offsetX,
            startY: e.offsetY,
            origOffsetX: editorState.view.offsetX,
            origOffsetY: editorState.view.offsetY
        };
        return;
    }
    // Skip drawing for building mode
    if (editorState.mode === "building") return;

    const { offsetX, offsetY } = e;

    // Handle erase mode
    if (editorState.mode === "erase") {
        eraseAt(offsetX, offsetY);
        return;
    }

    editorState.drawing = true;
    const first = unproject(offsetX, offsetY);
    const baseColor = editorState.strokeColor || "#ef4444";
    const baseWidth = editorState.strokeWidth || 2;
    console.debug("[building-editor] beginDraw", {
        mode: editorState.mode,
        color: baseColor,
        width: baseWidth
    });

    if (editorState.mode === "note") {
        const text = prompt("Enter note text:");
        if (!text) return;
        const stroke = {
            id: Date.now() + Math.random(),
            points: [first],
            color: baseColor,
            width: baseWidth,
            fill: false,
            type: "note",
            text: text,
            rotation: 0
        };
        const floor = editorState.floors[editorState.activeFloor];
        if (floor) floor.strokes.push(stroke);
        redraw();
        return;
    }

    if (AssetManager.get(editorState.mode) || editorState.mode === "point") {
        // Point/Icon mode: draw immediately
        const stroke = {
            id: Date.now() + Math.random(),
            points: [first],
            color: baseColor,
            width: baseWidth,
            fill: false,
            type: editorState.mode, // Store the type!
            rotation: 0
        };
        const floor = editorState.floors[editorState.activeFloor];
        if (floor) {
            floor.strokes.push(stroke);
        }
        redraw();
        editorState.drawing = false;
        return;
    }

    editorState.currentStroke = {
        points: [first],
        color: baseColor,
        width: baseWidth,
        fill: ["rectangle", "circle", "polygon"].includes(editorState.mode),
        type: editorState.mode
    };
    redraw();
}

function moveDraw(e) {
    if (e.cancelable) e.preventDefault();

    // Update pointer position
    if (editorState.activePointers.has(e.pointerId)) {
        editorState.activePointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    }

    // PINCH ZOOM LOGIC
    if (editorState.activePointers.size === 2) {
        const dist = getPinchDist();
        if (editorState.pinchStartDist > 0) {
            const scaleChange = dist / editorState.pinchStartDist;
            const newScale = Math.min(5, Math.max(0.5, editorState.pinchStartScale * scaleChange));

            // Simple center zoom for now (could improve to pinch-center)
            // We reuse handleWheel logic logic effectively
            const center = getPinchCenter();
            const worldBefore = unproject(center.x, center.y);

            const prevOffsetX = editorState.view.offsetX || 0;
            const prevOffsetY = editorState.view.offsetY || 0;
            editorState.view.scale = newScale;

            const base = {
                x: (worldBefore.lng - editorState.transform.minLng) * editorState.transform.cosLat * editorState.transform.scale + editorState.padding,
                y: (editorState.transform.maxLat - worldBefore.lat) * editorState.transform.scale + editorState.padding
            };
            const screenPos = applyView(base);
            const dx = center.x - screenPos.x;
            const dy = center.y - screenPos.y;
            editorState.view.offsetX = prevOffsetX + dx / newScale;
            editorState.view.offsetY = prevOffsetY + dy / newScale;

            redraw();
        }
        return;
    }

    if (editorState.activePointers.size > 1) return; // Ignore multi-touch if not 2 (e.g. 3 fingers)

    if (editorState.mode === "select") {
        if (editorState.imageInteraction) {
            updateImageInteraction(e);
        }
        return;
    }

    if (editorState.mode === "pan" && editorState.panState) {
        const dx = e.offsetX - editorState.panState.startX;
        const dy = e.offsetY - editorState.panState.startY;
        const scale = editorState.view.scale || 1;
        editorState.view.offsetX = editorState.panState.origOffsetX + dx / scale;
        editorState.view.offsetY = editorState.panState.origOffsetY + dy / scale;
        redraw();
        return;
    }

    if (!editorState.drawing || !editorState.currentStroke || !editorState.transform) return;
    const { offsetX, offsetY } = e;
    const next = unproject(offsetX, offsetY);
    const pts = editorState.currentStroke.points;

    switch (editorState.mode) {
        case "draw":
            pts.push(next);
            break;
        case "line":
        case "rectangle":
        case "circle":
        case "polygon": {
            pts[1] = next;
            break;
        }
        default:
            pts.push(next);
            break;
    }
    redraw();
}

function endDraw(e) {
    if (e && e.cancelable) e.preventDefault();
    if (editorState.canvas) {
        try {
            // editorState.canvas.releasePointerCapture(e.pointerId); // Implicit usually
        } catch (err) { }
        editorState.activePointers.delete(e.pointerId);
    }

    if (editorState.activePointers.size > 0) {
        
        editorState.pinchStartDist = 0;
        return;
    }

    if (editorState.mode === "select") {
        if (editorState.imageInteraction) {
            endImageInteraction();
        }
        return;
    }

    if (editorState.mode === "pan") {
        editorState.panState = null;
        return;
    }

    if (!editorState.drawing || !editorState.currentStroke || !editorState.activeFloor) {
        editorState.drawing = false;
        editorState.currentStroke = null;
        return;
    }
    const floor = editorState.floors[editorState.activeFloor];
    if (floor) {
        const finalized = finalizeStroke(editorState.currentStroke);
        if (finalized && finalized.points.length) {
            floor.strokes.push(finalized);
        }
    }
    editorState.drawing = false;
    editorState.currentStroke = null;
    redraw();
}

function ensureFloor(name) {
    if (!editorState.floors[name]) {
        editorState.floors[name] = { strokes: [], imageOverlay: null };
    }
    if (!editorState.activeFloor) {
        editorState.activeFloor = name;
    }
}

export function setOutlineStyle(color, fill) {
    editorState.outlineColor = color;
    editorState.outlineFill = fill;
    redraw();
}

export function init(canvas, outline, strokeColor = "#ef4444", strokeWidth = 2) {
    editorState.canvas = canvas;
    editorState.ctx = canvas.getContext("2d");
    editorState.outline = outline || [];
    editorState.strokeColor = strokeColor || editorState.strokeColor;
    editorState.strokeWidth = strokeWidth || editorState.strokeWidth;

    editorState.mode = "draw"; // Default to draw mode
    loadAssets();
    ensureCanvasSize();
    computeTransform();
    ensureFloor("Floor 1");

    canvas.onpointerdown = beginDraw;
    canvas.onpointermove = moveDraw;
    canvas.onpointerup = endDraw;
    canvas.onpointerleave = endDraw;
    canvas.onpointercancel = endDraw; // Handle cancellation
    canvas.style.touchAction = "none"; // CRITICAL: Disable browser gestures
    canvas.style.cursor = "crosshair";
    canvas.onwheel = handleWheel;

    window.addEventListener("resize", () => {
        ensureCanvasSize();
        redraw();
    });

    if (typeof ResizeObserver !== "undefined" && !editorState.resizeObserver) {
        editorState.resizeObserver = new ResizeObserver(() => {
            ensureCanvasSize();
            redraw();
        });
        editorState.resizeObserver.observe(canvas.parentElement || canvas);
    }

    redraw();
}

function finalizeStroke(stroke) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return null;
    const pts = stroke.points.slice();
    const color = stroke.color || editorState.strokeColor || "#ef4444";
    const width = stroke.width || editorState.strokeWidth || 2;
    let fill = !!stroke.fill;

    const shapeFromTwoPoints = (buildFn) => {
        if (pts.length < 2) return null;
        return {
            id: Date.now() + Math.random(),
            points: buildFn(pts[0], pts[1]),
            color,
            width,
            fill: true
        };
    };

    switch (editorState.mode) {
        case "line":
            if (pts.length < 2) return null;
            return { id: Date.now() + Math.random(), points: [pts[0], pts[pts.length - 1]], color, width, fill: false };
        case "rectangle":
            return shapeFromTwoPoints(buildRectangle);
        case "circle":
            return shapeFromTwoPoints(buildCircle);
        case "polygon":
            return shapeFromTwoPoints(buildHexagon);
        case "draw":
        default:
            if (pts.length < 2) return null;
            return { id: Date.now() + Math.random(), points: pts, color, width, fill };
    }
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

function buildRectangle(a, b) {
    return closeRing([
        { lng: a.lng, lat: a.lat },
        { lng: b.lng, lat: a.lat },
        { lng: b.lng, lat: b.lat },
        { lng: a.lng, lat: b.lat }
    ]);
}

function buildCircle(a, b) {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const r = Math.sqrt(dx * dx + dy * dy);
    const segments = 32;
    const pts = [];
    for (let i = 0; i < segments; i++) {
        const ang = (i / segments) * Math.PI * 2;
        pts.push({
            lng: a.lng + r * Math.cos(ang),
            lat: a.lat + r * Math.sin(ang)
        });
    }
    return closeRing(pts);
}

function buildHexagon(a, b) {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const r = Math.sqrt(dx * dx + dy * dy);
    const sides = 6;
    const pts = [];
    for (let i = 0; i < sides; i++) {
        const ang = (i / sides) * Math.PI * 2;
        pts.push({
            lng: a.lng + r * Math.cos(ang),
            lat: a.lat + r * Math.sin(ang)
        });
    }
    return closeRing(pts);
}

export function setOutline(outline) {
    editorState.outline = outline || [];
    editorState.panState = null;
    computeTransform();
    redraw();
}

export function setStyle(color, width) {
    if (color) editorState.strokeColor = color;
    if (width) editorState.strokeWidth = width;
    if (editorState.drawing && editorState.currentStroke) {
        editorState.currentStroke.color = editorState.strokeColor;
        editorState.currentStroke.width = editorState.strokeWidth;
    }
    console.debug("[building-editor] setStyle", {
        color: editorState.strokeColor,
        width: editorState.strokeWidth
    });
    redraw();
}

export function setMode(mode) {
    if (mode) {
        // In the building editor, "building" mode should act as "draw" since we're already editing a building
        editorState.mode = mode === "building" ? "draw" : mode;
    }
    editorState.currentStroke = null;
    editorState.drawing = false;
    editorState.panState = null;
    editorState.imageInteraction = null;
    console.debug("[building-editor] setMode", { mode: editorState.mode });

    // Update cursor based on mode
    if (editorState.canvas) {
        switch (editorState.mode) {
            case "pan":
                editorState.canvas.style.cursor = "grab";
                break;
            case "erase":
                editorState.canvas.style.cursor = "not-allowed";
                break;
            case "select":
                editorState.canvas.style.cursor = "default";
                break;
            default:
                editorState.canvas.style.cursor = "crosshair";
                break;
        }
    }
}

function handleWheel(e) {
    e.preventDefault();
    if (!editorState.transform) return;

    const delta = e.deltaY;
    const factor = delta < 0 ? 1.1 : 0.9;
    const newScale = Math.min(5, Math.max(0.5, (editorState.view.scale || 1) * factor));

    const mouseX = e.offsetX;
    const mouseY = e.offsetY;
    const worldBefore = unproject(mouseX, mouseY);

    // Apply new scale, then adjust offsets to keep the cursor anchored to the same world point
    const prevOffsetX = editorState.view.offsetX || 0;
    const prevOffsetY = editorState.view.offsetY || 0;
    editorState.view.scale = newScale;

    const base = {
        x: (worldBefore.lng - editorState.transform.minLng) * editorState.transform.cosLat * editorState.transform.scale + editorState.padding,
        y: (editorState.transform.maxLat - worldBefore.lat) * editorState.transform.scale + editorState.padding
    };

    // Compute where that world point would render with current offsets/rotation/scale
    const screenPos = applyView(base);
    const dx = mouseX - screenPos.x;
    const dy = mouseY - screenPos.y;
    editorState.view.offsetX = prevOffsetX + dx / newScale;
    editorState.view.offsetY = prevOffsetY + dy / newScale;

    redraw();
}

export function setRotation(degrees) {
    const clamped = Math.max(-3600, Math.min(3600, degrees || 0));
    editorState.view.rotation = clamped;
    redraw();
}

function getImageScreenFrame(frame) {
    if (!editorState.transform) return { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } };
    const { cosLat, scale } = editorState.transform;
    const baseCenter = baseProject(frame.center); // screen coords before view pan/zoom/rot
    const halfW = (frame.widthLng * cosLat * scale) / 2;
    const halfH = (frame.heightLat * scale) / 2;
    const rad = (frame.rotation || 0) * (Math.PI / 180);

    const rotate2D = (x, y) => ({
        x: x * Math.cos(rad) - y * Math.sin(rad),
        y: x * Math.sin(rad) + y * Math.cos(rad)
    });

    const local = [
        rotate2D(-halfW, -halfH),
        rotate2D(halfW, -halfH),
        rotate2D(halfW, halfH),
        rotate2D(-halfW, halfH)
    ];

    const toView = (pt) => applyView({ x: baseCenter.x + pt.x, y: baseCenter.y + pt.y });
    return {
        tl: toView(local[0]),
        tr: toView(local[1]),
        br: toView(local[2]),
        bl: toView(local[3])
    };
}

function drawImageControls() {
    const overlay = getActiveOverlay();
    if (!editorState.ctx || !overlay?.frame) return;
    const frame = overlay.frame;
    const corners = getImageScreenFrame(frame);
    const ctx = editorState.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.8)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(corners.tl.x, corners.tl.y);
    ctx.lineTo(corners.tr.x, corners.tr.y);
    ctx.lineTo(corners.br.x, corners.br.y);
    ctx.lineTo(corners.bl.x, corners.bl.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    const handleSize = 8;
    ctx.fillStyle = "rgba(59,130,246,0.95)";
    // Corner handles
    [corners.tl, corners.tr, corners.br, corners.bl].forEach((h) => {
        ctx.beginPath();
        ctx.rect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
        ctx.fill();
    });
    // Edge handles
    const edges = [
        { x: (corners.tl.x + corners.tr.x) / 2, y: (corners.tl.y + corners.tr.y) / 2 },
        { x: (corners.tr.x + corners.br.x) / 2, y: (corners.tr.y + corners.br.y) / 2 },
        { x: (corners.bl.x + corners.br.x) / 2, y: (corners.bl.y + corners.br.y) / 2 },
        { x: (corners.tl.x + corners.bl.x) / 2, y: (corners.tl.y + corners.bl.y) / 2 }
    ];
    edges.forEach((h) => {
        ctx.beginPath();
        ctx.rect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
        ctx.fill();
    });
    // Rotate handle (circle to differentiate)
    const rotateHandle = { x: (corners.tl.x + corners.tr.x) / 2, y: (corners.tl.y + corners.tr.y) / 2 - 18 };
    ctx.beginPath();
    ctx.arc(rotateHandle.x, rotateHandle.y, handleSize / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

export function getRotation() {
    return editorState.view.rotation || 0;
}

export function addFloor(name) {
    ensureFloor(name);
    editorState.activeFloor = name;
    redraw();
}

export function setActiveFloor(name) {
    if (!editorState.floors[name]) return;
    editorState.activeFloor = name;
    redraw();
}

export function clearActiveFloor() {
    if (!editorState.activeFloor) return;
    const floor = editorState.floors[editorState.activeFloor];
    if (floor) {
        floor.strokes = [];
        redraw();
    }
}

export function setImageOverlay(src) {
    const floor = getActiveFloorState();
    if (!floor) return;
    if (!src) {
        floor.imageOverlay = null;
        redraw();
        return;
    }
    const img = new Image();
    img.onload = () => {
        const angle = estimateOutlineAngle();
        if (editorState.outline && editorState.outline.length) {
            const minLng = Math.min(...editorState.outline.map((p) => p.lng));
            const maxLng = Math.max(...editorState.outline.map((p) => p.lng));
            const minLat = Math.min(...editorState.outline.map((p) => p.lat));
            const maxLat = Math.max(...editorState.outline.map((p) => p.lat));
            const widthLng = Math.max(0.00001, maxLng - minLng);
            const heightLat = Math.max(0.00001, maxLat - minLat);
            const center = { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 };
            floor.imageOverlay = {
                img,
                src,
                opacity: floor.imageOverlay?.opacity ?? 0.6,
                frame: {
                    center,
                    widthLng,
                    heightLat,
                    rotation: angle
                }
            };
        } else {
            floor.imageOverlay = {
                img,
                src,
                opacity: floor.imageOverlay?.opacity ?? 0.6,
                frame: null
            };
        }
        redraw();
    };
    img.src = src;
}

export function alignImageRotationToOutline() {
    const overlay = getActiveOverlay();
    if (!overlay?.frame) return;
    const angle = estimateOutlineAngle();
    overlay.frame.rotation = angle;
    redraw();
}

// Redundant, removed to simplify
export function alignImageRotationToLongestEdge() {
    // Legacy support if needed, redirects to smart alignment
    alignImageRotationToNearestEdge();
}

export function rotateImage90() {
    const overlay = getActiveOverlay();
    if (!overlay?.frame) return;
    overlay.frame.rotation = (overlay.frame.rotation || 0) + 90;
    redraw();
}

export function alignImageRotationToNearestEdge() {
    const overlay = getActiveOverlay();
    if (!overlay?.frame) return;
    const current = overlay.frame.rotation;
    // Pass current rotation to find "nearest angular match"
    const angle = estimateEdgeAngle(current);
    overlay.frame.rotation = angle;
    redraw();
}

export function setImageLocked(locked) {
    editorState.imageLocked = !!locked;
    redraw();
}

export function isImageLocked() {
    return editorState.imageLocked;
}

export function setImageOpacity(opacity) {
    const overlay = getActiveOverlay();
    if (!overlay) return;
    const value = typeof opacity === "number" ? opacity : 60;
    const clamped = Math.max(0, Math.min(100, value)) / 100;
    overlay.opacity = clamped;
    redraw();
}


export function clearImageOverlay() {
    const floor = getActiveFloorState();
    if (!floor) return;
    floor.imageOverlay = null;
    redraw();
}

export function getImageOpacity() {
    const overlay = getActiveOverlay();
    if (!overlay) return 60;
    return (overlay.opacity ?? 0.6) * 100;
}

function getActiveFloorState() {
    if (!editorState.activeFloor) return null;
    ensureFloor(editorState.activeFloor);
    return editorState.floors[editorState.activeFloor];
}

function getActiveOverlay() {
    const floor = getActiveFloorState();
    return floor?.imageOverlay || null;
}

export function exportFloor(name) {
    const floor = editorState.floors[name];
    if (!floor) return [];
    return (floor.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || editorState.strokeColor,
        width: s.width || editorState.strokeWidth
    }));
}

export function exportAll() {
    const result = {};
    Object.keys(editorState.floors).forEach((name) => {
        const floor = editorState.floors[name];
        result[name] = (floor?.strokes || []).map((s) => ({
            points: s.points || [],
            color: s.color || editorState.strokeColor,
            width: s.width || editorState.strokeWidth,
            type: s.type || "draw",
            fill: s.fill,
            text: s.text,
            rotation: s.rotation
        }));
    });
    return result;
}

export function importAll(data) {
    if (!data || typeof data !== "object") return;
    editorState.selectedStrokeId = null;
    editorState.floors = {};
    Object.keys(data).forEach((name) => {
        const strokes = data[name] || [];
        editorState.floors[name] = {
            strokes: strokes.map((s) => ({
                id: s.id || (Date.now() + Math.random()),
                points: Array.isArray(s.points) ? s.points : [],
                color: s.color || editorState.strokeColor,
                width: s.width || editorState.strokeWidth,
                fill: s.fill, // Persist fill state
                type: s.type || "draw",
                text: s.text,
                rotation: s.rotation
            })),
            imageOverlay: null
        };
    });
    const floorNames = Object.keys(editorState.floors);
    if (floorNames.length) {
        editorState.activeFloor = floorNames[floorNames.length - 1];
    } else {
        ensureFloor("Floor 1");
    }
    redraw();
}

export function exportImages() {
    const images = {};
    Object.keys(editorState.floors).forEach((name) => {
        const overlay = editorState.floors[name]?.imageOverlay;
        if (overlay && overlay.frame && overlay.src) {
            images[name] = {
                src: overlay.src,
                opacity: overlay.opacity ?? 0.6,
                frame: overlay.frame
            };
        }
    });
    return images;
}

export function importImages(data) {
    if (!data || typeof data !== "object") return;
    Object.keys(data).forEach((name) => {
        ensureFloor(name);
        const floor = editorState.floors[name];
        const payload = data[name];
        if (!payload || !payload.src || !payload.frame) {
            floor.imageOverlay = null;
            return;
        }
        const img = new Image();
        img.onload = () => {
            floor.imageOverlay = {
                img,
                src: payload.src,
                opacity: payload.opacity ?? 0.6,
                frame: payload.frame
            };
            redraw();
        };
        img.src = payload.src;
    });
}

// Panel helpers
export function enablePanelDrag(panel) {
    // Drag disabled; panel is static in overlay mode.
}

export function getFloors() {
    return Object.keys(editorState.floors);
}



export function setContext(buildingId) {
    const newId = buildingId || "global";
    const currentId = editorState.activeBuildingId || "global";

    if (newId === currentId) {
        // Even if same ID, ensure floors exist (first run)
        if (!editorState.floors || Object.keys(editorState.floors).length === 0) {
            ensureFloor("Floor 1");
        }
        return;
    }

    // 1. Save current state to store
    editorState.store[currentId] = {
        floors: editorState.floors,
        activeFloor: editorState.activeFloor
    };

    // 2. Load new state or init
    if (editorState.store[newId]) {
        editorState.floors = editorState.store[newId].floors;
        editorState.activeFloor = editorState.store[newId].activeFloor;
    } else {
        editorState.floors = {};
        editorState.activeFloor = null;
        ensureFloor("Floor 1");
    }

    editorState.activeBuildingId = newId;

    redraw();
}

// Helper for pinch
function getPinchDist() {
    if (editorState.activePointers.size !== 2) return 0;
    const [p1, p2] = [...editorState.activePointers.values()];
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

function getPinchCenter() {
    if (editorState.activePointers.size !== 2) return { x: 0, y: 0 };
    const [p1, p2] = [...editorState.activePointers.values()];
    return {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2
    };
}
