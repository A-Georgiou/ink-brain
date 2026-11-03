// Quiet places on a screenshot: where little is drawn, so a note laid there covers nothing.
import { edgeToward, isRegion, overlapArea } from "./geometry.mjs";

const CELL = 8;
const EDGE = 30;
const INKED = 0.08;

// Which 8px cells of a bitmap hold something (enough of their pixels sit on an edge), with running sums for quick box counts.
export function inkGrid({ width, height, data }) {
    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    const edges = new Uint16Array(cols * rows);
    const light = (i) => (data[i] + data[i + 1] + data[i + 2]) / 3;
    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const i = (y * width + x) * 4;
            if (Math.abs(light(i) - light(i + 4)) + Math.abs(light(i) - light(i + width * 4)) >= EDGE) edges[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]++;
        }
    }
    const sums = new Uint32Array((cols + 1) * (rows + 1));
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const inked = edges[r * cols + c] >= INKED * CELL * CELL ? 1 : 0;
            sums[(r + 1) * (cols + 1) + c + 1] = inked + sums[r * (cols + 1) + c + 1] + sums[(r + 1) * (cols + 1) + c] - sums[r * (cols + 1) + c];
        }
    }
    return { cols, rows, sums };
}

// How many cells with something in them a box touches.
export function inkIn({ cols, rows, sums }, { x, y, w, h }) {
    const [c0, r0] = [Math.max(0, Math.floor(x / CELL)), Math.max(0, Math.floor(y / CELL))];
    const [c1, r1] = [Math.min(cols, Math.ceil((x + w) / CELL)), Math.min(rows, Math.ceil((y + h) / CELL))];
    if (c1 <= c0 || r1 <= r0) return 0;
    const at = (r, c) => sums[r * (cols + 1) + c];
    return at(r1, c1) - at(r0, c1) - at(r1, c0) + at(r0, c0);
}

// Where a note wanted at box should go: there when it and its line to via (a point, or a function of the note's centre) cover next to nothing, else the nearest spot that is clearly quieter and keeps off avoid.
export function quietSpot(grid, box, { view, avoid = [], via = null, skip = 24, reach = 300, step = 12, margin = 12 }) {
    const weigh = (spot) => {
        const centre = [spot.x + spot.w / 2, spot.y + spot.h / 2];
        return inkIn(grid, spot) + (via ? 2 * inkAlong(grid, typeof via === "function" ? via(centre) : via, centre, skip) : 0);
    };
    const here = weigh(box);
    if (here < 3) return box;
    let best = null;
    for (let dy = -reach; dy <= reach; dy += step) {
        for (let dx = -reach; dx <= reach; dx += step) {
            const spot = { ...box, x: box.x + dx, y: box.y + dy };
            if (spot.x < margin || spot.y < margin || spot.x + spot.w > view.width - margin || spot.y + spot.h > view.height - margin || overlapArea(spot, avoid) > 0) continue;
            const ink = weigh(spot);
            const cost = ink * 40 + Math.hypot(dx, dy);
            if (!best || cost < best.cost) best = { spot, ink, cost };
        }
    }
    return best && (best.ink <= 1 || best.ink * 4 <= here) ? best.spot : box;
}

const isCallout = (shape) => shape.kind === "callout" && String(shape.text ?? "").trim() && Number.isFinite(shape.x) && Number.isFinite(shape.y);
const isArrow = (shape) => shape.kind === "arrow" && shape.style !== "both" && [shape.from, shape.to].every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));

export const needsSettling = (shapes) => shapes.some((shape) => isCallout(shape) || isArrow(shape) || (shape.kind === "marker" && shape.target));

// Where a callout's handwriting goes, as the overlay places it: wrapped at 360 pixels, at `at` or up and aside of the target.
function calloutBox(shape, view) {
    const text = String(shape.text).trim();
    const size = shape.size ?? 24;
    const lines = text.split("\n").map((line) => ({ line, rows: Math.max(1, Math.ceil((line.length * size * 0.52) / 360)) }));
    const w = Math.min(360, Math.max(...lines.map(({ line }) => line.length)) * size * 0.52) + 12;
    const h = lines.reduce((sum, { rows }) => sum + rows, 0) * size * 1.25 + 8;
    const [ax, ay] = Array.isArray(shape.at) ? shape.at : [shape.x + 150 + w / 2 < view.width - 20 ? shape.x + 150 : shape.x - 150, shape.y > 140 ? shape.y - 110 : shape.y + 110];
    return { x: ax - w / 2, y: ay - h / 2, w, h };
}

// What a shape points at, which notes must not cover.
function keepClear(shape) {
    if (shape.target) return [shape.target];
    if (shape.kind === "arrow" && Array.isArray(shape.to)) return [{ x: shape.to[0] - 20, y: shape.to[1] - 20, w: 40, h: 40 }];
    if (["circle", "rect", "highlight", "underline", "spotlight"].includes(shape.kind) && isRegion(shape)) return [shape];
    return ["pulse", "pointer", "callout", "marker", "check", "cross"].includes(shape.kind) && Number.isFinite(shape.x) && Number.isFinite(shape.y) ? [{ x: shape.x - 20, y: shape.y - 20, w: 40, h: 40 }] : [];
}

// Cells with something in them along the line from a to b, leaving out the first skip pixels around the tip.
function inkAlong(grid, [x0, y0], [x1, y1], skip = 30) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const cells = new Set();
    for (let d = skip; d <= length; d += 6) {
        const [x, y] = [x0 + ((x1 - x0) * d) / length, y0 + ((y1 - y0) * d) / length];
        if (inkIn(grid, { x, y, w: 1, h: 1 })) cells.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
    }
    return cells.size;
}

// Where a pointing arrow starts: moved to a nearby direction and length that cross next to nothing, unless it joins other marks.
function settleTail(shape, grid, view, aims) {
    const [[fx, fy], [tx, ty]] = [shape.from, shape.to];
    const length = Math.hypot(fx - tx, fy - ty);
    if (length < 50 || aims.some((box) => overlapArea({ x: fx - 12, y: fy - 12, w: 24, h: 24 }, [box]) > 0)) return shape;
    const inkOf = ([x, y]) => inkAlong(grid, [tx, ty], [x, y]) * 3 + inkIn(grid, { x: x - 12, y: y - 12, w: 24, h: 24 });
    const here = inkOf(shape.from);
    if (here < 6) return shape;
    const angle = Math.atan2(fy - ty, fx - tx);
    let best = null;
    for (let turn = -70; turn <= 70; turn += 14) {
        for (const reach of [0.6, 0.8, 1, 1.25, 1.6]) {
            const radius = Math.min(260, Math.max(70, length * reach));
            const point = [tx + radius * Math.cos(angle + (turn * Math.PI) / 180), ty + radius * Math.sin(angle + (turn * Math.PI) / 180)];
            if (point[0] < 12 || point[1] < 12 || point[0] > view.width - 12 || point[1] > view.height - 12) continue;
            const ink = inkOf(point);
            const cost = ink * 10 + Math.abs(turn) * 0.8 + Math.abs(radius - length) * 0.3;
            if (!best || cost < best.cost) best = { point, ink, cost };
        }
    }
    return best && best.ink * 2 <= here ? { ...shape, from: best.point } : shape;
}

// Which corner of a framed control a number badge sits on: the one with the least drawn under it.
function quietCorner(grid, target, view) {
    const corners = { tl: [target.x - 2, target.y - 2], tr: [target.x + target.w + 2, target.y - 2], bl: [target.x - 2, target.y + target.h + 2], br: [target.x + target.w + 2, target.y + target.h + 2] };
    const fits = ([x, y]) => x >= 14 && y >= 14 && x <= view.width - 14 && y <= view.height - 14;
    const ink = ([x, y]) => inkIn(grid, { x: x - 14, y: y - 14, w: 28, h: 28 });
    return Object.entries(corners).filter(([, point]) => fits(point)).reduce((best, entry) => (ink(entry[1]) < ink(best[1]) ? entry : best), ["tl", corners.tl])[0];
}

// Moves callout handwriting, arrow tails and number badges off busy parts of the screen onto quiet ones nearby; they still lead to what they point at.
export function settleMarks(shapes, grid, view) {
    const aims = shapes.flatMap(keepClear);
    return shapes.map((shape) => {
        if (isArrow(shape)) return settleTail(shape, grid, view, aims);
        if (shape.kind === "marker" && shape.target) return { ...shape, corner: quietCorner(grid, shape.target, view) };
        if (!isCallout(shape)) return shape;
        const box = calloutBox(shape, view);
        const { target } = shape;
        const spot = quietSpot(grid, box, { view, avoid: aims, via: target ? (centre) => edgeToward(centre, target) : [shape.x, shape.y], skip: target ? 8 : 24 });
        aims.push(spot);
        if (spot === box) return shape;
        const centre = [spot.x + spot.w / 2, spot.y + spot.h / 2];
        const [x, y] = target ? edgeToward(centre, target) : [shape.x, shape.y];
        return { ...shape, x, y, at: centre };
    });
}
