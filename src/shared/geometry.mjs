// Coordinate helpers between screenshot (model) pixels and overlay CSS pixels, plus mark summaries.

const BOX_KINDS = new Set(["circle", "rect", "highlight", "underline", "spotlight", "board", "brace", "lens"]);
const POINT_KINDS = new Set(["label", "marker", "pointer", "write", "pulse", "check", "cross"]);
const SEGMENT_KINDS = new Set(["arrow", "line"]);
export const SHAPE_KINDS = [...BOX_KINDS, ...POINT_KINDS, ...SEGMENT_KINDS, "path", "callout", "diagram"];

// Size of the screenshot the model sees, capped so vision models keep accurate coordinates.
export function modelImageSize(pointWidth, pointHeight, maxEdge = 1568) {
    const scale = Math.min(1, maxEdge / Math.max(pointWidth, pointHeight));
    return { width: Math.round(pointWidth * scale), height: Math.round(pointHeight * scale), scale };
}

const finite = (...values) => values.every(Number.isFinite);
const isPoint = (p) => Array.isArray(p) && p.length === 2 && finite(p[0], p[1]);
export const isRegion = (r) => Boolean(r) && finite(r.x, r.y, r.w, r.h) && r.w > 0 && r.h > 0;

function validateDiagram({ nodes, edges = [] }) {
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 30) return "diagram needs 1 to 30 nodes";
    const ids = new Set();
    for (const node of nodes) {
        if (typeof node?.id !== "string" || !finite(node.x, node.y)) return "each diagram node needs an id and a centre x, y";
        ids.add(node.id);
    }
    if (!Array.isArray(edges) || edges.length > 60) return "diagram edges must be a list of at most 60";
    const broken = edges.find((edge) => !ids.has(edge?.from) || !ids.has(edge?.to));
    return broken ? `diagram edge ${JSON.stringify(broken?.from)} -> ${JSON.stringify(broken?.to)} refers to a missing node` : null;
}

export function validateShape(shape) {
    if (!shape || typeof shape !== "object") return "each shape must be an object";
    const { kind } = shape;
    if (BOX_KINDS.has(kind)) return isRegion(shape) ? null : `${kind} needs x, y, w and h`;
    if (kind === "write" && !String(shape.text ?? "").trim()) return "write needs text";
    if (POINT_KINDS.has(kind)) return finite(shape.x, shape.y) ? null : `${kind} needs x and y`;
    if (SEGMENT_KINDS.has(kind)) return isPoint(shape.from) && isPoint(shape.to) ? null : `${kind} needs from and to as [x, y]`;
    if (kind === "path") return Array.isArray(shape.points) && shape.points.length >= 2 && shape.points.every(isPoint) ? null : "path needs at least two [x, y] points";
    if (kind === "callout") return finite(shape.x, shape.y) && String(shape.text ?? "").trim() ? null : "callout needs the target x, y and text";
    if (kind === "diagram") return validateDiagram(shape);
    return `unknown shape kind "${kind}"`;
}

// Maps a shape from screenshot pixels to overlay CSS pixels.
export function shapeToOverlay(shape, scale) {
    const k = 1 / scale;
    const out = { ...shape };
    for (const key of ["x", "y", "w", "h", "size"]) if (Number.isFinite(shape[key])) out[key] = shape[key] * k;
    for (const key of ["from", "to", "at"]) if (isPoint(shape[key])) out[key] = [shape[key][0] * k, shape[key][1] * k];
    if (Array.isArray(shape.points)) out.points = shape.points.filter(isPoint).map(([x, y]) => [x * k, y * k]);
    if (Array.isArray(shape.nodes)) {
        out.nodes = shape.nodes.map((node) => {
            const mapped = { ...node };
            for (const key of ["x", "y", "w", "h"]) if (Number.isFinite(node[key])) mapped[key] = node[key] * k;
            return mapped;
        });
    }
    return out;
}

// Overlay rect for a panel: exactly over a region, or wherever x, y, width and height place it.
export function panelRect(placement, over, scale) {
    if (over) return { x: over.x / scale, y: over.y / scale, width: over.w / scale, height: over.h / scale };
    const rect = {};
    for (const key of ["x", "y", "width", "height"]) if (Number.isFinite(placement[key])) rect[key] = placement[key] / scale;
    return rect;
}

export function boundsOfPoints(points) {
    if (!points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Total area of box covered by the rects ({ x, y, w, h } or DOMRect-like { x, y, width, height }).
export function overlapArea(box, rects) {
    let total = 0;
    for (const r of rects) {
        const w = Math.min(box.x + box.w, r.x + (r.w ?? r.width)) - Math.max(box.x, r.x);
        const h = Math.min(box.y + box.h, r.y + (r.h ?? r.height)) - Math.max(box.y, r.y);
        total += Math.max(0, w) * Math.max(0, h);
    }
    return total;
}

// Where the w x h answer bubble goes: near the user's marks without covering them, drawings or panels.
export function bubbleSpot({ w, h, view, bottomInset, anchor = null, drawn = [], current = null }) {
    const m = 16;
    const gap = 44;
    const bottom = view.height - h - bottomInset;
    const spots = {
        bottom: [(view.width - w) / 2, bottom],
        "bottom-right": [view.width - w - 28, bottom],
        "bottom-left": [28, bottom],
        top: [(view.width - w) / 2, 64],
        "top-right": [view.width - w - 28, 64],
        "top-left": [28, 64],
        right: [view.width - w - 28, (view.height - h) / 2],
        left: [28, (view.height - h) / 2],
    };
    if (anchor) {
        Object.assign(spots, {
            "beside-right": [anchor.x + anchor.w + gap, anchor.y],
            "beside-left": [anchor.x - w - gap, anchor.y],
            below: [anchor.x + anchor.w / 2 - w / 2, anchor.y + anchor.h + gap],
            above: [anchor.x + anchor.w / 2 - w / 2, anchor.y - h - gap],
        });
    }
    const near = anchor && { x: anchor.x - 40, y: anchor.y - 40, w: anchor.w + 80, h: anchor.h + 80 };
    const [hx, hy] = anchor ? [anchor.x + anchor.w / 2, anchor.y + anchor.h / 2] : [view.width / 2, bottom + h / 2];
    const scored = Object.entries(spots).map(([name, [x, y]]) => {
        const box = { x: Math.min(Math.max(x, m), view.width - w - m), y: Math.min(Math.max(y, m + 24), view.height - h - m), w, h };
        let cost = overlapArea(box, drawn) * 20 + (Math.abs(box.x - x) + Math.abs(box.y - y)) * 300 + Math.hypot(box.x + w / 2 - hx, box.y + h / 2 - hy) * 40;
        if (anchor) cost += overlapArea(box, [anchor]) * 60 + overlapArea(box, [near]) * 6;
        return { name, box, cost };
    });
    const best = scored.reduce((a, b) => (b.cost < a.cost ? b : a));
    // Stay unless another spot is clearly better, so the bubble does not wander as the answer streams.
    const stay = scored.find((spot) => spot.name === current);
    return stay && stay.cost <= best.cost * 1.15 + 8000 ? stay : best;
}

// Marks are user ink in overlay CSS pixels: { type: "stroke", points } or { type: "pin", x, y }.
export function boundsOfMarks(marks) {
    const points = marks.flatMap((mark) => (mark.type === "pin" ? [[mark.x, mark.y]] : mark.points ?? []));
    return boundsOfPoints(points);
}

// Region to zoom into around the user's marks, clamped to the display.
export function cropAround(bounds, displayWidth, displayHeight, { pad = 48, min = 260 } = {}) {
    const w = Math.min(displayWidth, Math.max(bounds.w + pad * 2, min));
    const h = Math.min(displayHeight, Math.max(bounds.h + pad * 2, min));
    const x = Math.min(Math.max(0, bounds.x + bounds.w / 2 - w / 2), displayWidth - w);
    const y = Math.min(Math.max(0, bounds.y + bounds.h / 2 - h / 2), displayHeight - h);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

const boxText = (b, scale) => `x=${Math.round(b.x * scale)}, y=${Math.round(b.y * scale)}, w=${Math.round(b.w * scale)}, h=${Math.round(b.h * scale)}`;

// Human-readable description of the user's marks in screenshot pixels.
export function describeMarks(marks, scale) {
    return marks.map((mark) => {
        if (mark.type === "pin") return `pointed at (${Math.round(mark.x * scale)}, ${Math.round(mark.y * scale)})`;
        const points = mark.points ?? [];
        const bounds = boundsOfPoints(points);
        if (!bounds) return "drew a mark";
        const [sx, sy] = points[0];
        const [ex, ey] = points.at(-1);
        const closed = Math.hypot(ex - sx, ey - sy) < Math.max(28, 0.35 * Math.max(bounds.w, bounds.h));
        if (closed) return `circled the region ${boxText(bounds, scale)}`;
        if (bounds.h < 24 && bounds.w > 40) return `underlined the area ${boxText(bounds, scale)}`;
        return `drew from (${Math.round(sx * scale)}, ${Math.round(sy * scale)}) to (${Math.round(ex * scale)}, ${Math.round(ey * scale)}), covering ${boxText(bounds, scale)}`;
    });
}
