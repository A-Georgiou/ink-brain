// Quiet places on a screenshot: where little is drawn, so a note laid there covers nothing.
import { isRegion, overlapArea } from "./geometry.mjs";

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

// Where a note wanted at box should go: there when it covers next to nothing, else the nearest spot that is clearly quieter and keeps off avoid.
export function quietSpot(grid, box, { view, avoid = [], reach = 300, step = 12, margin = 12 }) {
    const here = inkIn(grid, box);
    if (here < 3) return box;
    let best = null;
    for (let dy = -reach; dy <= reach; dy += step) {
        for (let dx = -reach; dx <= reach; dx += step) {
            const spot = { ...box, x: box.x + dx, y: box.y + dy };
            if (spot.x < margin || spot.y < margin || spot.x + spot.w > view.width - margin || spot.y + spot.h > view.height - margin || overlapArea(spot, avoid) > 0) continue;
            const ink = inkIn(grid, spot);
            const cost = ink * 40 + Math.hypot(dx, dy);
            if (!best || cost < best.cost) best = { spot, ink, cost };
        }
    }
    return best && (best.ink <= 1 || best.ink * 4 <= here) ? best.spot : box;
}

const isCallout = (shape) => shape.kind === "callout" && String(shape.text ?? "").trim() && Number.isFinite(shape.x) && Number.isFinite(shape.y);

export const hasCallouts = (shapes) => shapes.some(isCallout);

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

// Moves each callout's handwriting off busy parts of the screen onto a quiet one nearby; its arrow still leads to the target.
export function settleCallouts(shapes, grid, view) {
    const avoid = shapes.flatMap(keepClear);
    return shapes.map((shape) => {
        if (!isCallout(shape)) return shape;
        const box = calloutBox(shape, view);
        const spot = quietSpot(grid, box, { view, avoid });
        avoid.push(spot);
        return spot === box ? shape : { ...shape, at: [spot.x + spot.w / 2, spot.y + spot.h / 2] };
    });
}
