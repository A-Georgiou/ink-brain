// Traces the silhouette of the thing in a picture against its background, so lofts and bases can take their true shape from the user's own picture.
const STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Douglas-Peucker on an open polyline: the fewest points within tolerance of it.
function simplify(points, tolerance) {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [[ax, ay], [bx, by]] = [points[a], points[b]];
        const length = Math.hypot(bx - ax, by - ay) || 1;
        let [far, index] = [0, -1];
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            const away = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
            if (away > far) [far, index] = [away, i];
        }
        if (far > tolerance) {
            keep[index] = 1;
            stack.push([a, index], [index, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

// The outline of the biggest thing that stands out from the picture's border colour, as [x, y] fractions of the picture, or null when nothing does.
// image is { width, height, data } with RGBA bytes, ideally a couple of hundred pixels across.
export function traceOutline({ width, height, data }, { tolerance = 40, most = 96 } = {}) {
    const size = width * height;
    if (width < 8 || height < 8) return null;
    const border = [];
    for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
    for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
    const median = (k) => border.map((i) => data[i * 4 + k]).sort((a, b) => a - b)[border.length >> 1];
    const background = [median(0), median(1), median(2)];
    const plain = (i) => Math.abs(data[i * 4] - background[0]) + Math.abs(data[i * 4 + 1] - background[1]) + Math.abs(data[i * 4 + 2] - background[2]) < tolerance;
    const around = (i) => {
        const x = i % width;
        return [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i < size - width ? i + width : -1];
    };
    // Background is the plain colour reachable from the border; the rest is the thing.
    const thing = new Uint8Array(size).fill(1);
    const queue = border.filter(plain);
    for (const i of queue) thing[i] = 0;
    for (let q = 0; q < queue.length; q++) {
        for (const j of around(queue[q])) {
            if (j < 0 || !thing[j] || !plain(j)) continue;
            thing[j] = 0;
            queue.push(j);
        }
    }
    // Opening (erode, then dilate) drops leader lines and text that touch it.
    const eroded = thing.map((v, i) => v && around(i).every((j) => j >= 0 && thing[j]));
    const solid = eroded.map((v, i) => v || around(i).some((j) => j >= 0 && eroded[j]));
    const label = new Int32Array(size);
    let [best, biggest, count] = [0, 0, 0];
    for (let s = 0; s < size; s++) {
        if (!solid[s] || label[s]) continue;
        const stack = [s];
        label[s] = ++count;
        let n = 0;
        while (stack.length) {
            n++;
            for (const j of around(stack.pop())) {
                if (j < 0 || !solid[j] || label[j]) continue;
                label[j] = count;
                stack.push(j);
            }
        }
        if (n > biggest) [best, biggest] = [count, n];
    }
    if (biggest < size * 0.04 || biggest > size * 0.97) return null;
    // Walks its edge clockwise from its top-left pixel (Moore neighbourhood).
    const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && label[y * width + x] === best;
    const start = label.indexOf(best);
    let [x, y, back] = [start % width, Math.floor(start / width), 4];
    const edge = [];
    for (let guard = 0; guard < size * 2; guard++) {
        edge.push([x, y]);
        let moved = false;
        for (let k = 1; k <= 8 && !moved; k++) {
            const d = (back + k) % 8;
            if (inside(x + STEPS[d][0], y + STEPS[d][1])) {
                [x, y, back, moved] = [x + STEPS[d][0], y + STEPS[d][1], (d + 4) % 8, true];
            }
        }
        if (!moved || (x === edge[0][0] && y === edge[0][1])) break;
    }
    if (edge.length < 8) return null;
    // Splits the loop at its farthest point from the start, so both halves simplify as open lines.
    const far = edge.reduce((f, p, i) => (Math.hypot(p[0] - edge[0][0], p[1] - edge[0][1]) > Math.hypot(edge[f][0] - edge[0][0], edge[f][1] - edge[0][1]) ? i : f), 0);
    let outline = [];
    for (let slack = 0.6; slack < Math.max(width, height); slack *= 1.4) {
        outline = [...simplify(edge.slice(0, far + 1), slack), ...simplify([...edge.slice(far), edge[0]], slack).slice(1, -1)];
        if (outline.length <= most) break;
    }
    return outline.map(([px, py]) => [(px + 0.5) / width, (py + 0.5) / height]);
}
