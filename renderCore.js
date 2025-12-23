
// renderCore.js - Shared Rendering Logic

export const AssetManager = {
    assets: {
        trap: new Image(),
        bait: new Image(),
        flykiller: new Image(),
        insect_trap: new Image(),
        foam: new Image(),
        detector: new Image(),
        door: new Image(),
        window: new Image()
    },
    loaded: false,

    loadAll() {
        if (this.loaded) return Promise.resolve();

        const promises = Object.keys(this.assets).map(key => {
            return new Promise(resolve => {
                const img = this.assets[key];
                img.onload = resolve;
                img.onerror = resolve; // Continue on error
                img.src = `icons/${key}.svg`;
            });
        });

        return Promise.all(promises).then(() => {
            console.debug("[renderCore] All assets loaded");
            this.loaded = true;
        });
    },

    get(type) {
        return this.assets[type];
    }
};

export const Renderer = {
    drawIcon(ctx, type, x, y, width, rotation = 0) {
        const img = AssetManager.get(type);
        if (img && img.complete) {
            const scale = Math.max(width / 4, 0.8) * 1.5;
            const w = 24 * scale;
            const h = 24 * scale;

            ctx.save();
            ctx.translate(x, y);
            if (rotation) ctx.rotate(rotation * Math.PI / 180);
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.restore();
        } else {
            ctx.fillStyle = "#ef4444";
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    drawNote(ctx, text, x, y, color, width, rotation = 0) {
        ctx.save();
        ctx.translate(x, y);
        if (rotation) ctx.rotate(rotation * Math.PI / 180);

        const fontSize = Math.max(12, width * 3);
        ctx.font = `bold ${fontSize}px sans-serif`;

        ctx.strokeStyle = "white";
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.strokeText(text || "Note", 0, 0);

        ctx.fillStyle = color || "black";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text || "Note", 0, 0);

        ctx.restore();
    },

    drawGeometry(ctx, points, style = {}, shapeType) {
        if (!points || points.length < 1) return;
        const color = style.color || "#ef4444";
        const width = style.width || 2;
        const fill = style.fill;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();

        if (shapeType === "circle" && points.length >= 2) {
            const [a, b] = points;
            const radius = Math.hypot(b.x - a.x, b.y - a.y);
            ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
        } else if (shapeType === "point" || shapeType === "bait" || shapeType === "trap") {
            // Catch-all for simple points if icon isn't used
            const p = points[0];
            ctx.arc(p.x, p.y, width * 1.5 || 6, 0, Math.PI * 2);
        } else {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(points[i].x, points[i].y);
            }
            if (shapeType === "polygon" || shapeType === "rectangle" || (fill && points.length >= 3)) {
                ctx.closePath();
            }
        }

        ctx.stroke();
        if (fill) {
            ctx.fillStyle = style.fillColor || `${color}22`;
            ctx.fill();
        }
        ctx.restore();
    },

    drawSelectionOverlay(ctx, feature, screenPoints) {
        if (!screenPoints || !screenPoints.length) return;
        const color = "rgba(14,165,233,0.6)";
        const width = Math.max((feature.width || 2) + 2, 4);

        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        // OUTER GLOW (Dashed)
        ctx.strokeStyle = "rgba(14,165,233,0.22)";
        ctx.lineWidth = width + 6;
        ctx.setLineDash([10, 7]);
        this.strokeGeometryPath(ctx, screenPoints, feature.type);

        // INNER STROKE
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash([]);
        this.strokeGeometryPath(ctx, screenPoints, feature.type);

        // FILL if applicable
        if ((feature.type === "polygon" || feature.type === "rectangle") && screenPoints.length >= 3) {
            ctx.fillStyle = "rgba(14,165,233,0.08)";
            ctx.fill();
        }

        ctx.restore();

        // Transformation Handles
        const bounds = Geometry.getFeatureBounds(ctx, feature, screenPoints);
        if (bounds) {
            this.drawTransformHandles(ctx, bounds);
        }
    },

    strokeGeometryPath(ctx, points, type) {
        ctx.beginPath();
        if (type === "circle" && points.length >= 2) {
            const [a, b] = points;
            const radius = Math.hypot(b.x - a.x, b.y - a.y);
            ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
        } else if (type === "point" || type === "note" || AssetManager.get(type)) {
            const a = points[0];
            const radius = 14;
            ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
        } else {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
            if (type === "polygon" || type === "rectangle") ctx.closePath();
        }
        ctx.stroke();
    },

    drawTransformHandles(ctx, bounds) {
        ctx.save();
        ctx.strokeStyle = "rgba(59,130,246,0.8)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(bounds.tl.x, bounds.tl.y);
        ctx.lineTo(bounds.tr.x, bounds.tr.y);
        ctx.lineTo(bounds.br.x, bounds.br.y);
        ctx.lineTo(bounds.bl.x, bounds.bl.y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);

        const handleSize = 8;
        ctx.fillStyle = "rgba(59,130,246,1)";
        ctx.strokeStyle = "white";
        ctx.lineWidth = 1;

        // Corners
        [bounds.tl, bounds.tr, bounds.br, bounds.bl].forEach(p => {
            ctx.beginPath();
            ctx.rect(p.x - handleSize / 2, p.y - handleSize / 2, handleSize, handleSize);
            ctx.fill();
            ctx.stroke();
        });

        // Edges
        const edgePoints = [
            { x: (bounds.tl.x + bounds.tr.x) / 2, y: (bounds.tl.y + bounds.tr.y) / 2 },
            { x: (bounds.tr.x + bounds.br.x) / 2, y: (bounds.tr.y + bounds.br.y) / 2 },
            { x: (bounds.bl.x + bounds.br.x) / 2, y: (bounds.bl.y + bounds.br.y) / 2 },
            { x: (bounds.tl.x + bounds.bl.x) / 2, y: (bounds.tl.y + bounds.bl.y) / 2 }
        ];
        edgePoints.forEach(p => {
            ctx.beginPath();
            ctx.rect(p.x - handleSize / 2, p.y - handleSize / 2, handleSize, handleSize);
            ctx.fill();
            ctx.stroke();
        });

        // Rotation knob
        const rotationRad = (bounds.rotation || 0) * Math.PI / 180;
        const topCenter = { x: (bounds.tl.x + bounds.tr.x) / 2, y: (bounds.tl.y + bounds.tr.y) / 2 };
        const rotateHandle = {
            x: topCenter.x - 20 * Math.sin(rotationRad),
            y: topCenter.y - 20 * Math.cos(rotationRad)
        };

        ctx.beginPath();
        ctx.arc(rotateHandle.x, rotateHandle.y, handleSize / 2 + 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(topCenter.x, topCenter.y);
        ctx.lineTo(rotateHandle.x, rotateHandle.y);
        ctx.stroke();

        ctx.restore();
    }
};

export const Geometry = {
    pointToSegmentDistance(px, py, p1, p2) {
        const lx = p2.x - p1.x;
        const ly = p2.y - p1.y;
        const lenSq = lx * lx + ly * ly;
        if (lenSq === 0) return Math.hypot(px - p1.x, py - p1.y);
        let t = ((px - p1.x) * lx + (py - p1.y) * ly) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (p1.x + t * lx), py - (p1.y + t * ly));
    },

    getFeatureBounds(ctx, feature, screenPoints) {
        if (!screenPoints || !screenPoints.length) return null;

        const isPointBased = feature.type === "note" || feature.type === "point" || !!AssetManager.get(feature.type);

        if (isPointBased) {
            const a = screenPoints[0];
            let w = 24, h = 24;
            const scale = Math.max((feature.width || 4) / 4, 0.8);
            const rotation = (feature.rotation || 0) * Math.PI / 180;

            if (feature.type === "note") {
                const fontSize = Math.max(12, (feature.width || 4) * 3);
                ctx.save();
                ctx.font = `bold ${fontSize}px sans-serif`;
                const metrics = ctx.measureText(feature.text || "");
                ctx.restore();
                w = metrics.width + 12;
                h = fontSize + 8;
            } else if (AssetManager.get(feature.type)) {
                const iconScale = scale * 1.5;
                w = 24 * iconScale;
                h = 24 * iconScale;
            } else {
                const pointRadius = (feature.width || 4) * 1.2;
                w = pointRadius * 2;
                h = pointRadius * 2;
            }

            const rotate = (p) => ({
                x: a.x + (p.x - a.x) * Math.cos(rotation) - (p.y - a.y) * Math.sin(rotation),
                y: a.y + (p.x - a.x) * Math.sin(rotation) + (p.y - a.y) * Math.cos(rotation)
            });

            return {
                tl: rotate({ x: a.x - w / 2, y: a.y - h / 2 }),
                tr: rotate({ x: a.x + w / 2, y: a.y - h / 2 }),
                br: rotate({ x: a.x + w / 2, y: a.y + h / 2 }),
                bl: rotate({ x: a.x - w / 2, y: a.y + h / 2 }),
                center: a,
                width: w,
                height: h,
                rotation: feature.rotation || 0
            };
        } else {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            screenPoints.forEach(p => {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            });

            const pad = (feature.width || 2) / 2 + 4;
            minX -= pad; minY -= pad; maxX += pad; maxY += pad;

            if (feature.type === "circle" && screenPoints.length >= 2) {
                const [a, b] = screenPoints;
                const r = Math.hypot(b.x - a.x, b.y - a.y);
                minX = a.x - r - pad;
                maxX = a.x + r + pad;
                minY = a.y - r - pad;
                maxY = a.y + r + pad;
            }

            return {
                tl: { x: minX, y: minY },
                tr: { x: maxX, y: minY },
                br: { x: maxX, y: maxY },
                bl: { x: minX, y: maxY },
                center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
                width: maxX - minX,
                height: maxY - minY,
                rotation: 0
            };
        }
    },

    hitTestHandles(x, y, bounds) {
        if (!bounds) return null;
        const handleSize = 18;
        const hit = (p) => Math.abs(p.x - x) <= handleSize / 2 && Math.abs(p.y - y) <= handleSize / 2;

        if (hit(bounds.tl)) return { type: 'scale', handle: 'tl' };
        if (hit(bounds.tr)) return { type: 'scale', handle: 'tr' };
        if (hit(bounds.br)) return { type: 'scale', handle: 'br' };
        if (hit(bounds.bl)) return { type: 'scale', handle: 'bl' };

        // Rotate handle
        const rotationRad = (bounds.rotation || 0) * Math.PI / 180;
        const topCenter = { x: (bounds.tl.x + bounds.tr.x) / 2, y: (bounds.tl.y + bounds.tr.y) / 2 };
        const rotateHandle = {
            x: topCenter.x - 20 * Math.sin(rotationRad),
            y: topCenter.y - 20 * Math.cos(rotationRad)
        };
        if (hit(rotateHandle)) return { type: 'rotate', handle: 'rotate' };

        // Edges
        const edges = [
            { name: 'top', x: (bounds.tl.x + bounds.tr.x) / 2, y: (bounds.tl.y + bounds.tr.y) / 2 },
            { name: 'right', x: (bounds.tr.x + bounds.br.x) / 2, y: (bounds.tr.y + bounds.br.y) / 2 },
            { name: 'bottom', x: (bounds.bl.x + bounds.br.x) / 2, y: (bounds.bl.y + bounds.br.y) / 2 },
            { name: 'left', x: (bounds.tl.x + bounds.bl.x) / 2, y: (bounds.tl.y + bounds.bl.y) / 2 }
        ];
        for (const edge of edges) {
            if (hit(edge)) return { type: 'scale-axis', handle: edge.name };
        }
        return null;
    },

    pointInPolygon(p, ring) {
        const x = p.x ?? p.lng;
        const y = p.y ?? p.lat;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x ?? ring[i].lng;
            const yi = ring[i].y ?? ring[i].lat;
            const xj = ring[j].x ?? ring[j].lng;
            const yj = ring[j].y ?? ring[j].lat;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    },

    distanceToPolygon(p, ring) {
        const x = p.x ?? p.lng;
        const y = p.y ?? p.lat;
        let minDist = Infinity;
        for (let i = 0; i < ring.length - 1; i++) {
            const p1 = ring[i];
            const p2 = ring[i + 1];
            // Normalize points for distance function
            const a = { x: p1.x ?? p1.lng, y: p1.y ?? p1.lat };
            const b = { x: p2.x ?? p2.lng, y: p2.y ?? p2.lat };
            const d = this.pointToSegmentDistance(x, y, a, b);
            if (d < minDist) minDist = d;
        }
        return minDist;
    }
};
