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
    if (isRegion(shape.target)) out.target = { x: shape.target.x * k, y: shape.target.y * k, w: shape.target.w * k, h: shape.target.h * k };
    return out;
}

// Marks that pick out one thing on screen snap onto the real element there, when one plausibly is what they meant.
const SNAP_BOXES = new Set(["circle", "rect", "highlight", "underline", "spotlight"]);
// Marks that end up beside a control get an outline around it, so it is clear which one is meant.
const FRAMED = new Set(["arrow", "callout", "marker"]);
const FRAME_MAX = { w: 240, h: 100 };
export const CONTROLS = new Set(["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXTab", "AXSlider", "AXMenuItem", "AXMenuBarItem", "AXDisclosureTriangle", "AXIncrementor", "AXSwitch", "AXToggle"]);
// Points and arrow tips land only on a control, or failing that a bit of text or an image, never on a container.
const LEAVES = new Set(["AXStaticText", "AXImage"]);
const CONTROL_MAX = { w: 480, h: 160 };
const GAP = 3;

// The point whose element a shape is about, or null for shapes that never snap.
export function snapPoint(shape) {
    if (SNAP_BOXES.has(shape.kind) && isRegion(shape)) return [shape.x + shape.w / 2, shape.y + shape.h / 2];
    if (["pulse", "pointer", "callout", "marker"].includes(shape.kind) && finite(shape.x, shape.y)) return [shape.x, shape.y];
    if (shape.kind === "arrow" && isPoint(shape.to)) return shape.to;
    return null;
}

const union = (a, b) => a.w * a.h + b.w * b.h - overlapArea(a, [b]);

// Where the line from `from` to the box's centre leaves the box, just outside it.
export function edgeToward(from, box) {
    const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
    const [dx, dy] = [from[0] - cx, from[1] - cy];
    if (Math.abs(dx) <= box.w / 2 && Math.abs(dy) <= box.h / 2) return [cx, cy];
    const t = Math.min(dx ? (box.w / 2 + GAP) / Math.abs(dx) : Infinity, dy ? (box.h / 2 + GAP) / Math.abs(dy) : Infinity);
    return [cx + dx * t, cy + dy * t];
}

// elements are the ones under the shape's snap point, innermost first, as { role, x, y, w, h } in screenshot pixels.
export function snapShape(shape, elements = []) {
    if (!elements.length) return shape;
    if (SNAP_BOXES.has(shape.kind)) {
        const [best, fit] = elements.map((e) => [e, overlapArea(shape, [e]) / union(shape, e)]).reduce((a, b) => (b[1] > a[1] ? b : a));
        return fit >= 0.35 ? { ...shape, x: best.x, y: best.y, w: best.w, h: best.h } : shape;
    }
    const small = elements.filter((e) => e.w >= 4 && e.h >= 4 && e.w <= CONTROL_MAX.w && e.h <= CONTROL_MAX.h);
    const target = small.find((e) => CONTROLS.has(e.role)) ?? small.find((e) => LEAVES.has(e.role));
    if (!target) return shape;
    const framed = FRAMED.has(shape.kind) && target.w <= FRAME_MAX.w && target.h <= FRAME_MAX.h ? { target: { x: target.x, y: target.y, w: target.w, h: target.h } } : {};
    if (shape.kind === "arrow") return { ...shape, to: edgeToward(shape.from, target), ...framed };
    const [x, y] = shape.kind === "callout" && isPoint(shape.at) ? edgeToward(shape.at, target) : [target.x + target.w / 2, target.y + target.h / 2];
    return { ...shape, x, y, ...framed };
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

// The biggest stage near the target; defaults allow only a small corner and keep its centre clear.
export function stageSpot({ target, view, max, min, others = [], ink = null, top = 52, margin = 24, step = 16, targetCover = 0.05, middleCover = 0, aspects = [[0.75, 1], [0.62, 1], [0.9, 1], [1.1, 0.9], [1.35, 0.8]] }) {
    const t = { x: target.x, y: target.y, w: target.w ?? target.width, h: target.h ?? target.height };
    const middle = { x: t.x + t.w / 4, y: t.y + t.h / 4, w: t.w / 2, h: t.h / 2 };
    const reading = { x: t.x, y: Math.max(top, t.y - 40), w: Math.max(t.w, 360), h: t.h + 260 };
    const bottom = view.height - 16;
    let best = null;
    for (let w = max[0]; w >= min[0]; w -= 40) {
        // Wide stages suit most models; tall ones only when nothing wider fits.
        for (const [aspect, weight] of aspects) {
            const h = Math.round(Math.min(max[1], Math.max(min[1], w * aspect)));
            const value = w * h * weight;
            if (h > bottom - top || (best && value <= best.value)) continue;
            for (let y = top; y + h <= bottom; y += step) {
                for (let x = margin; x + w <= view.width - margin; x += step) {
                    const spot = { x, y, w, h };
                    if (overlapArea(spot, [middle]) > middle.w * middle.h * middleCover || overlapArea(spot, [t]) > t.w * t.h * targetCover || overlapArea(spot, others) > w * h * 0.05) continue;
                    const away = ink
                        ? ink(spot) * 2 + overlapArea(spot, [reading]) * 0.05 + Math.hypot(x + w / 2 - t.x - t.w / 2, y + h / 2 - t.y - t.h / 2) * 0.15
                        : Math.hypot(x + w / 2 - t.x - t.w / 2, y + h / 2 - t.y - t.h / 2);
                    if (!best || value > best.value || (value === best.value && away < best.away)) best = { ...spot, value, away };
                }
            }
        }
    }
    return best && { x: best.x, y: best.y, w: best.w, h: best.h };
}

const boxOf = (r) => ({ x: r.x, y: r.y, w: r.w ?? r.width, h: r.h ?? r.height });

// Whether a note at spot would hide the middle of the circled thing, more than the share allow of it, or a twentieth of its own size under others.
export function crowds(spot, target, others = [], allow = 0.05) {
    const [s, t] = [boxOf(spot), boxOf(target)];
    return overlapArea(s, [{ x: t.x + t.w / 4, y: t.y + t.h / 4, w: t.w / 2, h: t.h / 2 }]) > 0 || overlapArea(s, [t]) > t.w * t.h * allow || overlapArea(s, others) > s.w * s.h * 0.05;
}

// Where a note goes, given the sizes it could take (each shows all of it): off the circled thing and the other panels, on the ground with the least on it, near the circled thing; null when nothing fits.
export function noteSpot({ target, view, sizes, others = [], soft = [], ink = null, allow = 0.05, top = 52, margin = 24, step = 16 }) {
    const t = boxOf(target);
    const bottom = view.height - 16;
    let best = null;
    for (const [w, h] of sizes) {
        if (h > bottom - top) continue;
        for (let y = top; y + h <= bottom; y += step) {
            for (let x = margin; x + w <= view.width - margin; x += step) {
                const spot = { x, y, w, h };
                if (crowds(spot, t, others, allow)) continue;
                const cost = (ink ? ink(spot) * 100 : 0) + overlapArea(spot, soft) * 0.5 + Math.hypot(x + w / 2 - t.x - t.w / 2, y + h / 2 - t.y - t.h / 2) * 0.25;
                if (!best || cost < best.cost) best = { ...spot, cost };
            }
        }
    }
    return best && { x: best.x, y: best.y, w: best.w, h: best.h };
}

// Where the w x h answer bubble goes: near the user's marks without covering them, drawings or panels, and where the screen is quiet when ink counts the cells with something in them under a box.
export function bubbleSpot({ w, h, view, bottomInset, anchor = null, drawn = [], current = null, ink = null }) {
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
    if (ink) {
        for (let y = 64; y + h <= view.height - m; y += 16) for (let x = m; x + w <= view.width - m; x += 16) spots[`quiet-${x}-${y}`] = [x, y];
    }
    const near = anchor && { x: anchor.x - 40, y: anchor.y - 40, w: anchor.w + 80, h: anchor.h + 80 };
    const [hx, hy] = anchor ? [anchor.x + anchor.w / 2, anchor.y + anchor.h / 2] : [view.width / 2, bottom + h / 2];
    const scored = Object.entries(spots).map(([name, [x, y]]) => {
        const box = { x: Math.min(Math.max(x, m), view.width - w - m), y: Math.min(Math.max(y, m + 24), view.height - h - m), w, h };
        let cost = overlapArea(box, drawn) * 20 + (Math.abs(box.x - x) + Math.abs(box.y - y)) * 300 + Math.hypot(box.x + w / 2 - hx, box.y + h / 2 - hy) * 40;
        if (anchor) cost += overlapArea(box, [anchor]) * 60 + overlapArea(box, [near]) * 6;
        if (ink) cost += ink(box) * 360;
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
