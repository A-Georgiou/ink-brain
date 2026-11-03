const inside = (p, r, pad = 0) => {
    if (r.shape === "circle") {
        const rx = r.w / 2 + pad;
        const ry = r.h / 2 + pad;
        return ((p[0] - r.x - r.w / 2) / rx) ** 2 + ((p[1] - r.y - r.h / 2) / ry) ** 2 <= 1;
    }
    return p[0] >= r.x - pad && p[0] <= r.x + r.w + pad && p[1] >= r.y - pad && p[1] <= r.y + r.h + pad;
};

const contains = (outer, inner, pad = 0) =>
    inner.x >= outer.x - pad && inner.y >= outer.y - pad && inner.x + inner.w <= outer.x + outer.w + pad && inner.y + inner.h <= outer.y + outer.h + pad;

function nodeOverlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    const nested = (outer, inner) => outer.w * outer.h > 1.5 * inner.w * inner.h && contains(outer, inner);
    if (w <= 3 || h <= 3 || nested(a, b) || nested(b, a)) return false;
    if (a.shape === "circle" && b.shape === "circle") {
        return ((a.x + a.w / 2 - b.x - b.w / 2) / ((a.w + b.w) / 2)) ** 2 + ((a.y + a.h / 2 - b.y - b.h / 2) / ((a.h + b.h) / 2)) ** 2 < 1;
    }
    if (a.shape === "circle" || b.shape === "circle") {
        const [c, r] = a.shape === "circle" ? [a, b] : [b, a];
        const x = Math.max(r.x, Math.min(c.x + c.w / 2, r.x + r.w));
        const y = Math.max(r.y, Math.min(c.y + c.h / 2, r.y + r.h));
        return inside([x, y], c, -2);
    }
    return true;
}

function crosses(a, b, rect) {
    if (rect.shape === "circle") {
        const rx = rect.w / 2 - 2;
        const ry = rect.h / 2 - 2;
        if (rx <= 0 || ry <= 0) return false;
        const p = [(a[0] - rect.x - rect.w / 2) / rx, (a[1] - rect.y - rect.h / 2) / ry];
        const d = [(b[0] - a[0]) / rx, (b[1] - a[1]) / ry];
        const t = Math.max(0, Math.min(1, -(p[0] * d[0] + p[1] * d[1]) / (d[0] ** 2 + d[1] ** 2 || 1)));
        return (p[0] + t * d[0]) ** 2 + (p[1] + t * d[1]) ** 2 < 1;
    }
    let lo = 0;
    let hi = 1;
    for (const [p, q, min, max] of [[a[0], b[0], rect.x + 2, rect.x + rect.w - 2], [a[1], b[1], rect.y + 2, rect.y + rect.h - 2]]) {
        if (min >= max) return false;
        if (Math.abs(q - p) < 1e-8) {
            if (p <= min || p >= max) return false;
        } else {
            const [t1, t2] = [(min - p) / (q - p), (max - p) / (q - p)].sort((x, y) => x - y);
            lo = Math.max(lo, t1);
            hi = Math.min(hi, t2);
            if (lo >= hi) return false;
        }
    }
    return true;
}

// Only report intersections that change what the reader can follow, not a link's own endpoints or nested frames.
export function auditBoard({ nodes = [], texts = [], edges = [] }) {
    const nodeOverlaps = [];
    for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) if (nodeOverlap(a, b)) nodeOverlaps.push(`${a.id} x ${b.id}`);
    const boxTextOverflow = texts.filter((text) => {
        const box = nodes.find((node) => node.id === text.id && node.shape === "box");
        return box && !contains(box, text, 4);
    }).map((text) => text.id);
    const edgeNodeCrossings = [];
    const edgeTextCrossings = [];
    for (const edge of edges) {
        if (edge.points.length < 2) continue;
        const ends = [edge.points[0], edge.points.at(-1)];
        const hits = (rect) => edge.points.slice(1).some((point, i) => crosses(edge.points[i], point, rect));
        for (const node of nodes) {
            if ([edge.from, edge.to].includes(node.id) || ends.some((p) => inside(p, node, 6))) continue;
            if (hits(node)) edgeNodeCrossings.push(`${edge.id} x ${node.id}`);
        }
        for (const text of texts) {
            if ([edge.from, edge.to].includes(text.id) || ends.some((p) => inside(p, text, 3))) continue;
            if (nodes.some((node) => node.id === text.id && contains(node, text, 4))) continue;
            if (hits(text)) edgeTextCrossings.push(`${edge.id} x ${text.id}`);
        }
    }
    return { nodeOverlaps, boxTextOverflow, edgeNodeCrossings, edgeTextCrossings };
}
