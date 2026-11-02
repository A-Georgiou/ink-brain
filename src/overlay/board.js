// 3Blue1Brown-style boards: typeset maths, graphs and diagrams that animate in time with narration.
import { compile } from "/shared/mathexpr.mjs";
import { BOARD_MARGIN, clearSpot, katexOptions, withValues } from "/shared/board.mjs";

// A 16 by 9 unit board of 100 px units, origin in the middle and y up: SVG shapes under KaTeX text.
const [W, H, UNIT] = [1600, 900, 100];
const NS = "http://www.w3.org/2000/svg";
// Manim's palette, so colours named by the model look right on the dark board.
const NAMED = { blue: "#58C4DD", teal: "#5CD0B3", green: "#83C167", yellow: "#FFE45E", gold: "#F0AC5F", orange: "#FF862F", red: "#FC6255", maroon: "#C55F73", purple: "#9A72AC", pink: "#D147BD", grey: "#888888", gray: "#888888", white: "#ECECEC" };
const CYCLE = ["#58C4DD", "#FFE45E", "#83C167", "#FC6255", "#9A72AC", "#F0AC5F"];
const TIME = { show: 1, hide: 0.6, move: 1, transform: 1.4, color: 0.6, highlight: 1, surround: 0.8, opacity: 0.6, set: 1.6, apply: 2, camera: 1.2 };
const TEXT_TYPES = new Set(["tex", "text"]);
// Written elements the layout keeps apart and on the board.
const MOVABLE = new Set(["tex", "text", "box"]);
const LEAF = /\b(frac-line|hide-tail|stretchy)\b/;
const STYLE = `
.board{position:absolute;inset:0;overflow:hidden}
.board-world,.board-cam,.board-html{position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0}
.board svg{position:absolute;left:0;top:0;overflow:visible}
.board-html{pointer-events:none}
.board-html>div{position:absolute;white-space:nowrap;color:#ECECEC;line-height:1.25;transform-origin:center}
.board-html .katex{font-size:1em}
.board-text{font-family:KaTeX_Main,"Times New Roman",serif}
.board-text.sans{font-family:-apple-system,system-ui,sans-serif}
.board-html>.board-text{white-space:pre}
.board-text.wrap{white-space:normal;text-align:center}
.board-html>.ghost{display:block;margin:0;overflow:hidden;white-space:nowrap}`;

const smooth = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const overshoot = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const isPair = (p) => Array.isArray(p) && p.length === 2;
const px = ([x, y]) => [W / 2 + x * UNIT, H / 2 - y * UNIT];
const paint = (value, fallback) => NAMED[String(value).toLowerCase()] ?? (typeof value === "string" && CSS.supports("color", value) ? value : fallback);
const mix = (from, to, k) => `color-mix(in srgb, ${to} ${(clamp01(k) * 100).toFixed(1)}%, ${from})`;
const union = (a, b) => (!a ? b : !b ? a : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
const centre = (box) => [box.x + box.w / 2, box.y + box.h / 2];
const unit = ([x, y]) => {
    const length = Math.hypot(x, y) || 1;
    return [x / length, y / length];
};

function element(tag, className, parent) {
    const node = document.createElement(tag);
    node.className = className;
    parent?.append(node);
    return node;
}

function svgNode(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined) node.setAttribute(key, value);
    parent?.append(node);
    return node;
}

let katexReady = null;
function loadKatex() {
    katexReady ??= (async () => {
        const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "app://live/vendor/katex/katex.min.css" });
        const loaded = new Promise((resolve, reject) => Object.assign(link, { onload: resolve, onerror: () => reject(new Error("Could not load the maths styles")) }));
        document.head.append(link, Object.assign(document.createElement("style"), { textContent: STYLE }));
        await loaded;
        const { default: katex } = await import("app://live/vendor/katex/katex.mjs");
        await Promise.all(["1em KaTeX_Main", "italic 1em KaTeX_Math", "1em KaTeX_Size1", "1em KaTeX_AMS"].map((font) => document.fonts.load(font)));
        return katex;
    })();
    return katexReady;
}

// Typeset pieces that write in and morph one by one: glyphs, fraction bars and root signs.
const leavesOf = (node) =>
    [...node.querySelectorAll("span, svg")].filter((el) => {
        if (LEAF.test(el.getAttribute("class") ?? "")) return true;
        if (el.closest(".hide-tail, .stretchy")) return false;
        return el.tagName === "svg" || [...el.childNodes].some((child) => child.nodeType === 3 && /[^\s\u200b]/.test(child.textContent));
    });

// Smooth curve through points (Catmull-Rom as cubic Béziers), or straight segments.
function through(points, smoothly, closed) {
    if (points.length < 2) return "";
    const at = (i) => points[closed ? (i + points.length) % points.length : Math.min(points.length - 1, Math.max(0, i))];
    let d = `M${points[0].join(",")}`;
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
        const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
        if (!smoothly) d += `L${p2.join(",")}`;
        else d += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2.join(",")}`;
    }
    return closed ? `${d}Z` : d;
}

// A curly brace from a to b whose point sticks out by depth to the right of a to b (y down).
function bracePath([x1, y1], [x2, y2], depth) {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [dx, dy] = [(x1 - x2) / length, (y1 - y2) / length];
    const at = (along, out) => [x1 - along * length * dx + out * depth * dy, y1 - along * length * dy - out * depth * dx].map((v) => v.toFixed(1)).join(",");
    return `M${x1},${y1}Q${at(0, 0.6)} ${at(0.25, 0.4)}T${at(0.5, 1)}M${x2},${y2}Q${at(1, 0.6)} ${at(0.75, 0.4)}T${at(0.5, 1)}`;
}

function build(spec, world, katex) {
    world.replaceChildren();
    const cam = element("div", "board-cam", world);
    const svg = svgNode("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, cam);
    const defs = svgNode("defs", {}, svg);
    const layer = element("div", "board-html", cam);
    const top = svgNode("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, cam);
    const items = new Map();
    const vars = { ...(spec.vars ?? {}) };
    const names = ["x", ...Object.keys(vars)];
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    // A variable that only ever holds whole numbers, such as a count, also shows whole numbers while it animates.
    const sets = steps.flat().filter((action) => action?.do === "set");
    const whole = new Set(Object.keys(vars).filter((name) => [vars[name], ...sets.filter((a) => a.vars && name in a.vars).map((a) => a.vars[name])].every(Number.isInteger)));
    const live = (source) => withValues(source, vars, whole);
    const tweens = [];
    const flows = new Map();
    const camera = { x: W / 2, y: H / 2, z: 1 };
    const compiled = new Map();
    let now = performance.now() / 1000;
    let played = -1;
    let made = 0;
    let revealed = 0;
    let settle = 2;
    let easing = false;
    let spots = [];

    const value = (v, x = 0) => {
        if (typeof v !== "string") return Number(v);
        if (!compiled.has(v)) compiled.set(v, compile(v, names));
        return compiled.get(v)({ ...vars, x });
    };
    const tween = (duration, delay, update, done) => {
        if (duration <= 0 && delay <= 0) {
            update(1);
            done?.();
        } else tweens.push({ start: now + delay, duration: Math.max(duration, 1e-4), update, done });
    };

    // Screen boxes of DOM nodes, mapped back into board pixels through the fit and camera transforms.
    const rectOf = (nodes) => {
        const frame = layer.getBoundingClientRect();
        const k = frame.width / W;
        let box = null;
        for (const node of nodes) {
            const r = node.getBoundingClientRect();
            if (r.width || r.height) box = union(box, { x: (r.left - frame.left) / k, y: (r.top - frame.top) / k, w: r.width / k, h: r.height / k });
        }
        return box;
    };
    const axesOf = (item) => {
        for (let node = item, hops = 0; node && hops < 3; node = items.get(node.def.on), hops++) if (node.map) return node;
        return null;
    };
    const shift = (item) => {
        const own = [item.offset[0] + item.nudge[0], item.offset[1] + item.nudge[1]];
        const axes = item.map ? null : axesOf(item);
        return axes ? [own[0] + axes.offset[0], own[1] + axes.offset[1]] : own;
    };
    const pointOf = (item, p) => {
        const axes = axesOf(item);
        const xy = [value(p[0]), value(p[1])];
        return axes ? axes.map(xy) : px(xy);
    };
    const atOf = (def) => px([value(def.at?.[0] ?? 0), value(def.at?.[1] ?? 0)]);
    const partNodes = (item, part) => [...(item.node?.querySelectorAll(`.p-${part}`) ?? [])];
    const boxOf = (target) => {
        const [id, part] = String(target).split(".");
        const item = items.get(id);
        if (!item) return null;
        if (part) return rectOf(partNodes(item, part));
        let box = rectOf(item.nodes);
        const [ox, oy] = shift(item);
        for (const node of item.g.querySelectorAll("path, circle, rect, text")) {
            const b = node.getBBox();
            if (b.width || b.height) box = union(box, { x: b.x + ox, y: b.y + oy, w: b.width, h: b.height });
        }
        return box;
    };

    const setTex = (node, source) => {
        katex.render(live(source), node, katexOptions());
        node.dataset.source = source;
        node.dataset.shown = live(source);
    };
    const setText = (node, source) => {
        node.replaceChildren(...String(live(source)).split(/(\s+)/).map((word) => (/^\s*$/.test(word) ? word : Object.assign(document.createElement("span"), { textContent: word }))));
        node.dataset.source = source;
        node.dataset.shown = live(source);
    };
    const stroke = (item, tag, attrs = {}) =>
        svgNode(tag, { fill: "none", stroke: "currentColor", "stroke-width": item.width, "stroke-linecap": "round", "stroke-linejoin": "round", ...(item.def.dashed ? { "stroke-dasharray": "14 11" } : { pathLength: 1 }), ...attrs }, item.g);
    const solid = (item, tag, attrs = {}) => svgNode(tag, { fill: "currentColor", class: "fade", ...attrs }, item.g);
    // A TeX label that rides along with an element; anchor says which side of the point it sits on.
    const label = (item, key, source, [x, y], anchor = "translate(-50%, -50%)") => {
        if (typeof source !== "string") return;
        item.labels ??= {};
        let node = item.labels[key];
        if (!node) {
            node = item.labels[key] = element("div", "board-tex", layer);
            node.style.fontSize = `${num(item.def.size, 0.42) * UNIT}px`;
            node.style.color = item.textColor ?? item.color;
            item.nodes.push(node);
        }
        if (node.dataset.source !== source || node.dataset.shown !== live(source)) setTex(node, source);
        Object.assign(node.style, { left: `${x}px`, top: `${y}px` });
        node.dataset.anchor = anchor;
    };
    // Steps a label down until it clears those placed this frame, as curve ends and points often meet.
    const free = (spot) => {
        while (spots.some(([x, y]) => Math.abs(x - spot[0]) < 170 && Math.abs(y - spot[1]) < 44)) spot[1] += 46;
        spots.push(spot);
        return spot;
    };
    const textNode = (item, source, tex, size) => {
        const wrap = item.def.width && item.def.type === "text";
        const node = element("div", tex ? "board-tex" : `board-text${item.def.font === "sans" ? " sans" : ""}${wrap ? " wrap" : ""}`, layer);
        node.style.fontSize = `${size * UNIT}px`;
        if (wrap) node.style.width = `${item.def.width * UNIT}px`;
        (tex ? setTex : setText)(node, source);
        if (!wrap) fitWidth(item, node);
        item.nodes.push(node);
        return node;
    };
    // Text too wide for the board is set smaller so that it fits.
    const fitWidth = (item, node) => {
        const room = W - 2 * BOARD_MARGIN - (item.def.type === "box" ? 56 : 0);
        if (node.offsetWidth > room) node.style.fontSize = `${parseFloat(node.style.fontSize) * Math.max(0.5, room / node.offsetWidth)}px`;
    };
    // A box is never smaller than its text, whatever size it was given.
    const sizeBox = (item) => {
        const [cx, cy] = atOf(item.def);
        const w = Math.max(num(item.def.width, 0) * UNIT, item.node ? item.node.offsetWidth + 56 : 240);
        const h = Math.max(num(item.def.height, 0) * UNIT, item.node ? item.node.offsetHeight + 40 : 110);
        const attrs = { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: Math.min(18, h / 4) };
        for (const [key, v] of Object.entries(attrs)) item.rect.setAttribute(key, v);
    };
    // An item's function of x: its own, else the plot it is on, else its fn expression.
    const fnOf = (item) => item.fn ?? items.get(item.def.on)?.fn ?? ((x) => value(item.def.fn, x));
    const refreshText = (item) => {
        const node = item.node;
        if (node && /\\val\{/.test(node.dataset.source) && node.dataset.shown !== live(node.dataset.source)) (item.def.type === "text" ? setText : setTex)(node, node.dataset.source);
    };
    // Text and boxes placed by expressions of vars follow them as set animates the vars.
    const follow = (item) => {
        if (!item.node || !Array.isArray(item.def.at) || !item.def.at.some((v) => typeof v === "string")) return;
        const [x, y] = TEXT_TYPES.has(item.def.type) ? pointOf(item, item.def.at) : atOf(item.def);
        Object.assign(item.node.style, { left: `${x}px`, top: `${y}px` });
        if (item.def.type === "box") sizeBox(item);
    };

    // Joins points or elements; an element end stops at its edge, facing the other end.
    const edge = (box, toward, gap) => {
        const [cx, cy] = centre(box);
        const [dx, dy] = [toward[0] - cx, toward[1] - cy];
        const s = Math.min(Math.abs((box.w / 2 + gap) / (dx || 1e-9)), Math.abs((box.h / 2 + gap) / (dy || 1e-9)), 1);
        return [cx + dx * s, cy + dy * s];
    };
    const drawLink = (item, from, to, tipped) => {
        const middle = (end) => (typeof end === "string" ? (boxOf(end) && centre(boxOf(end))) : pointOf(item, end));
        const [ca, cb] = [middle(from), middle(to)];
        if (!ca || !cb) return;
        const [ox, oy] = shift(item);
        const a = typeof from === "string" ? edge(boxOf(from), cb, 12) : ca;
        const b = typeof to === "string" ? edge(boxOf(to), ca, 12) : cb;
        if (typeof from === "string") [a[0], a[1]] = [a[0] - ox, a[1] - oy];
        if (typeof to === "string") [b[0], b[1]] = [b[0] - ox, b[1] - oy];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
        const bend = num(item.def.bend, 0) * length * 0.5;
        const control = [(a[0] + b[0]) / 2 + normal[0] * bend, (a[1] + b[1]) / 2 + normal[1] * bend];
        const tip = tipped ? Math.min(length * 0.45, 26 + item.width * 2) : 0;
        const dir = unit([b[0] - control[0], b[1] - control[1]]);
        const end = [b[0] - dir[0] * tip * 0.75, b[1] - dir[1] * tip * 0.75];
        item.path.setAttribute("d", bend ? `M${a.join(",")}Q${control.join(",")} ${end.join(",")}` : `M${a.join(",")}L${end.join(",")}`);
        if (tipped) {
            const [px1, py1] = [b[0] - dir[0] * tip, b[1] - dir[1] * tip];
            item.tip.setAttribute("d", `M${b.join(",")}L${px1 - dir[1] * tip * 0.42},${py1 + dir[0] * tip * 0.42}L${px1 + dir[1] * tip * 0.42},${py1 - dir[0] * tip * 0.42}Z`);
        }
        const side = bend < 0 ? -1 : 1;
        const spot = [(a[0] + b[0]) / 2 + normal[0] * (bend / 2 + side * 34), (a[1] + b[1]) / 2 + normal[1] * (bend / 2 + side * 34)];
        label(item, "label", item.def.label, isPair(item.def.to) && item.def.type === "vector" ? [b[0] + dir[0] * 30, b[1] + dir[1] * 30] : spot);
    };

    const BUILD = {
        tex(item) {
            item.node = textNode(item, item.def.tex, true, num(item.def.size, 0.6));
        },
        text(item) {
            item.node = textNode(item, item.def.text, false, num(item.def.size, 0.42));
        },
        box(item) {
            const content = item.def.tex ?? item.def.text;
            item.textColor = paint(item.def.text_color, "#ECECEC");
            if (typeof content === "string") item.node = textNode(item, content, typeof item.def.tex === "string", num(item.def.size, 0.36));
            const fill = item.def.fill === false ? 0 : 0.14;
            item.rect = stroke(item, "rect", { fill: "currentColor", "fill-opacity": fill, "data-fill": fill });
            sizeBox(item);
        },
        circle(item) {
            const [cx, cy] = pointOf(item, item.def.at ?? [0, 0]);
            const fill = item.def.fill ? 0.25 : 0;
            stroke(item, "circle", { cx, cy, r: num(item.def.r, 1) * UNIT, fill: "currentColor", "fill-opacity": fill, "data-fill": fill });
        },
        line(item) {
            item.path = stroke(item, "path");
            item.draw = () => drawLink(item, item.def.from, item.def.to, false);
        },
        arrow(item) {
            item.path = stroke(item, "path");
            item.tip = solid(item, "path");
            item.draw = () => drawLink(item, item.def.from, item.def.to, true);
        },
        vector(item) {
            BUILD.arrow(item);
            item.draw = () => drawLink(item, item.def.from ?? [0, 0], item.def.to, true);
        },
        path(item) {
            const fill = item.def.fill ? 0.22 : 0;
            item.path = stroke(item, "path", { fill: "currentColor", "fill-opacity": fill, "data-fill": fill });
            item.draw = () => item.path.setAttribute("d", through(item.def.points.map((p) => pointOf(item, p)), item.def.curve !== false, Boolean(item.def.closed)));
        },
        brace(item) {
            item.path = stroke(item, "path");
            const toward = { below: [0, 1], above: [0, -1], left: [-1, 0], right: [1, 0] }[item.def.side] ?? [0, 1];
            item.draw = () => {
                let a;
                let b;
                if (typeof item.def.of === "string") {
                    const box = boxOf(item.def.of);
                    if (!box) return;
                    const [ox, oy] = shift(item);
                    const [x0, y0, x1, y1] = [box.x - ox, box.y - oy, box.x + box.w - ox, box.y + box.h - oy];
                    [a, b] = { below: [[x0, y1 + 10], [x1, y1 + 10]], above: [[x1, y0 - 10], [x0, y0 - 10]], left: [[x0 - 10, y0], [x0 - 10, y1]], right: [[x1 + 10, y1], [x1 + 10, y0]] }[item.def.side] ?? [[x0, y1 + 10], [x1, y1 + 10]];
                } else {
                    [a, b] = [pointOf(item, item.def.from), pointOf(item, item.def.to)];
                    const out = unit([a[1] - b[1], b[0] - a[0]]);
                    if (out[0] * toward[0] + out[1] * toward[1] < 0) [a, b] = [b, a];
                }
                const depth = 24;
                item.path.setAttribute("d", bracePath(a, b, depth));
                const out = unit([a[1] - b[1], b[0] - a[0]]);
                const tip = [(a[0] + b[0]) / 2 + out[0] * (depth + 34), (a[1] + b[1]) / 2 + out[1] * (depth + 34)];
                label(item, "label", item.def.label, tip, out[0] > 0.5 ? "translate(0, -50%)" : out[0] < -0.5 ? "translate(-100%, -50%)" : "translate(-50%, -50%)");
            };
        },
        axes(item) {
            const d = item.def;
            const range = (r, fallback) => {
                const [lo, hi, step] = Array.isArray(r) && r.length >= 2 ? r : fallback;
                return [lo, hi, num(step, 0) > 0 ? step : 10 ** Math.floor(Math.log10((hi - lo) / 4))];
            };
            const [x0, x1, xs] = range(d.x, [-5, 5, 1]);
            const [y0, y1, ys] = range(d.y, [-3, 3, 1]);
            const [w, h] = [num(d.width, 8) * UNIT, num(d.height, 5) * UNIT];
            const [cx, cy] = atOf(d);
            item.range = { x0, x1, y0, y1 };
            item.matrix = [1, 0, 0, 1];
            item.map = ([mx, my]) => {
                const [a, b, c, e] = item.matrix;
                const [ux, uy] = [a * mx + b * my, c * mx + e * my];
                return [cx - w / 2 + ((ux - x0) / (x1 - x0)) * w, cy + h / 2 - ((uy - y0) / (y1 - y0)) * h];
            };
            const clip = svgNode("clipPath", { id: `clip-${d.id}` }, defs);
            svgNode("rect", { x: cx - w / 2 - 8, y: cy - h / 2 - 8, width: w + 16, height: h + 16 }, clip);
            const grid = d.grid ? svgNode("path", { stroke: "#58C4DD", "stroke-opacity": 0.32, "stroke-width": 2, fill: "none", pathLength: 1, "clip-path": `url(#clip-${d.id})` }, item.g) : null;
            item.width = 3.5;
            const axis = stroke(item, "path");
            const ticks = stroke(item, "path", { "stroke-width": 2.5 });
            const tips = solid(item, "path");
            const marks = (lo, hi, step) => {
                const list = [];
                for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 && list.length < 40; v += step) if (Math.abs(v) > step * 1e-6) list.push(Number(v.toFixed(6)));
                return list;
            };
            const numbers = d.numbers === false ? [] : [...marks(x0, x1, xs).map((v) => ["x", v]), ...marks(y0, y1, ys).map((v) => ["y", v])];
            const texts = numbers.map(([, v]) => Object.assign(svgNode("text", { "font-size": 30, "font-family": "KaTeX_Main, serif", fill: "#B8C0CC", class: "fade" }, item.g), { textContent: String(v).replace("-", "\u2212") }));
            item.draw = () => {
                const [ax, ay] = [x0 <= 0 && x1 >= 0 ? 0 : x0, y0 <= 0 && y1 >= 0 ? 0 : y0];
                const line = (p, q) => `M${item.map(p).join(",")}L${item.map(q).join(",")}`;
                if (grid) {
                    const [sx, sy] = [x1 - x0, y1 - y0];
                    const rows = [...marks(x0 - sx, x1 + sx, xs).map((v) => line([v, y0 - sy], [v, y1 + sy])), ...marks(y0 - sy, y1 + sy, ys).map((v) => line([x0 - sx, v], [x1 + sx, v]))];
                    grid.setAttribute("d", `${line([0, y0 - sy], [0, y1 + sy])}${line([x0 - sx, 0], [x1 + sx, 0])}${rows.join("")}`);
                }
                axis.setAttribute("d", `${line([x0, ay], [x1, ay])}${line([ax, y0], [ax, y1])}`);
                const tipAt = (from, to) => {
                    const [p, q] = [item.map(from), item.map(to)];
                    const dir = unit([q[0] - p[0], q[1] - p[1]]);
                    return `M${q[0] + dir[0] * 16},${q[1] + dir[1] * 16}L${q[0] - dir[1] * 9},${q[1] + dir[0] * 9}L${q[0] + dir[1] * 9},${q[1] - dir[0] * 9}Z`;
                };
                tips.setAttribute("d", `${tipAt([x0, ay], [x1, ay])}${tipAt([ax, y0], [ax, y1])}`);
                const tick = (p, along) => {
                    const [q, r] = [item.map(p), item.map([p[0] + along[0], p[1] + along[1]])];
                    const n = unit([r[1] - q[1], q[0] - r[0]]);
                    return `M${q[0] - n[0] * 8},${q[1] - n[1] * 8}L${q[0] + n[0] * 8},${q[1] + n[1] * 8}`;
                };
                ticks.setAttribute("d", [...marks(x0, x1, xs).map((v) => tick([v, ay], [1, 0])), ...marks(y0, y1, ys).map((v) => tick([ax, v], [0, 1]))].join(""));
                numbers.forEach(([axisName, v], i) => {
                    const [x, y] = item.map(axisName === "x" ? [v, ay] : [ax, v]);
                    const [dx, dy, anchor] = axisName === "x" ? [0, 34, "middle"] : [-16, 8, "end"];
                    Object.entries({ x: x + dx, y: y + dy, "text-anchor": anchor }).forEach(([key, val]) => texts[i].setAttribute(key, val));
                });
                const [xl, yl] = Array.isArray(d.labels) ? d.labels : [];
                const xe = item.map([x1, ay]);
                const ye = item.map([ax, y1]);
                label(item, "x", xl, [xe[0] + 16, xe[1] + 22], "translate(-100%, 0)");
                label(item, "y", yl, [ye[0], ye[1] - 30], "translate(-50%, -100%)");
            };
        },
        plot(item) {
            item.path = stroke(item, "path", { "clip-path": `url(#clip-${item.def.on})` });
            item.fn = (x) => value(item.def.fn, x);
            item.draw = () => {
                const axes = axesOf(item);
                const { x0, x1, y0, y1 } = axes.range;
                const [a, b] = isPair(item.def.domain) ? item.def.domain.map((v) => value(v)) : [x0, x1];
                const span = y1 - y0;
                let d = "";
                let pen = false;
                let last = null;
                for (let i = 0; i <= 320; i++) {
                    const x = a + ((b - a) * i) / 320;
                    const y = item.fn(x);
                    if (!Number.isFinite(y) || y < y0 - span || y > y1 + span) {
                        pen = false;
                        continue;
                    }
                    const p = axes.map([x, y]);
                    d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
                    pen = true;
                    if (y >= y0 && y <= y1) last = p;
                }
                item.path.setAttribute("d", d);
                if (last) label(item, "label", item.def.label, free([last[0] + 14, last[1] - 30]), "translate(0, -50%)");
            };
        },
        area(item) {
            const fill = 0.32;
            item.path = stroke(item, "path", { fill: "currentColor", "fill-opacity": fill, "data-fill": fill, "stroke-width": item.def.bars ? 2.5 : 0, "clip-path": `url(#clip-${axesOf(item)?.def.id})` });
            // It fills between fn (or the plot it is on) and lower: y = 0, an expression of x, or another plot.
            item.draw = () => {
                const axes = axesOf(item);
                const f = fnOf(item);
                const under = items.get(item.def.lower)?.fn ?? (item.def.lower === undefined ? () => 0 : (x) => value(item.def.lower, x));
                const [a, b] = item.def.domain.map((v) => value(v));
                const bars = Math.max(0, Math.round(value(item.def.bars ?? 0)));
                const ring = (points) => `M${points.map((p) => axes.map(p).map((v) => v.toFixed(1)).join(",")).join("L")}Z`;
                if (bars > 0) {
                    const step = (b - a) / bars;
                    item.path.setAttribute("d", Array.from({ length: Math.min(bars, 400) }, (_, i) => {
                        const [l, r] = [a + i * step, a + (i + 1) * step];
                        const [y, y0] = [f((l + r) / 2), under((l + r) / 2)];
                        return Number.isFinite(y) && Number.isFinite(y0) ? ring([[l, y0], [l, y], [r, y], [r, y0]]) : "";
                    }).join(""));
                } else {
                    const xs = Array.from({ length: 161 }, (_, i) => a + ((b - a) * i) / 160);
                    const edge = (g, list) => list.map((x) => [x, g(x)]).filter(([, y]) => Number.isFinite(y));
                    const points = [...edge(f, xs), ...edge(under, [...xs].reverse())];
                    item.path.setAttribute("d", points.length > 2 ? ring(points) : "");
                }
            };
        },
        dot(item) {
            item.circle = solid(item, "circle", { r: num(item.def.r, 0.09) * UNIT });
            item.draw = () => {
                const plot = items.get(item.def.on);
                const xy = plot?.fn ? axesOf(item).map([value(item.def.x), plot.fn(value(item.def.x))]) : pointOf(item, item.def.at);
                item.circle.setAttribute("cx", xy[0]);
                item.circle.setAttribute("cy", xy[1]);
                label(item, "label", item.def.label, free([xy[0] + 18, xy[1] - 18]), "translate(0, -100%)");
            };
        },
        tangent(item) {
            item.path = stroke(item, "path");
            item.circle = solid(item, "circle", { r: 9 });
            item.draw = () => {
                const plot = items.get(item.def.on);
                const axes = axesOf(item);
                const x = value(item.def.x);
                const h = (axes.range.x1 - axes.range.x0) * 1e-4;
                const [y, slope] = [plot.fn(x), (plot.fn(x + h) - plot.fn(x - h)) / (2 * h)];
                if (!Number.isFinite(y) || !Number.isFinite(slope)) return;
                const p = axes.map([x, y]);
                const q = axes.map([x + 1, y + slope]);
                const dir = unit([q[0] - p[0], q[1] - p[1]]);
                const half = (num(item.def.length, 3) * UNIT) / 2;
                item.path.setAttribute("d", `M${p[0] - dir[0] * half},${p[1] - dir[1] * half}L${p[0] + dir[0] * half},${p[1] + dir[1] * half}`);
                item.circle.setAttribute("cx", p[0]);
                item.circle.setAttribute("cy", p[1]);
                label(item, "label", item.def.label, [p[0] + dir[0] * half + 12, p[1] + dir[1] * half - 12], "translate(0, -100%)");
            };
        },
    };

    const itemOf = (def, color, width, opacity = 1) => ({ def, g: svgNode("g", { color }, svg), nodes: [], offset: [0, 0], nudge: [0, 0], push: [0, 0], pulse: 1, opacity, shown: false, color, width });
    const add = (def, index) => {
        const neutral = TEXT_TYPES.has(def.type) ? "#ECECEC" : ["axes", "line", "arrow", "brace"].includes(def.type) ? "#C9D1D9" : null;
        const color = paint(def.color, neutral ?? CYCLE[index % CYCLE.length]);
        const item = itemOf(def, color, num(def.stroke, 0.05) * UNIT, num(def.opacity, 1));
        items.set(def.id, item);
        BUILD[def.type](item);
        if (item.node) {
            item.node.style.color = item.textColor ?? color;
            if (TEXT_TYPES.has(def.type)) {
                const [x, y] = pointOf(item, def.at ?? [0, 0]);
                Object.assign(item.node.style, { left: `${x}px`, top: `${y}px` });
                item.node.dataset.anchor = { left: "translate(0, -50%)", right: "translate(-100%, -50%)" }[def.align] ?? "translate(-50%, -50%)";
            } else if (def.type === "box") {
                const [x, y] = atOf(def);
                Object.assign(item.node.style, { left: `${x}px`, top: `${y}px` });
            }
        }
        item.attached = ["line", "arrow", "brace"].includes(def.type) && [def.from, def.to, def.of].some((end) => typeof end === "string");
        item.draw?.();
        return item;
    };

    // Applies an item's movement, highlight pulse, fade and visibility to its SVG group and its text.
    const place = (item) => {
        const [ox, oy] = shift(item);
        const [cx, cy] = item.pivot ?? [0, 0];
        const p = item.pulse;
        item.g.setAttribute("transform", p === 1 ? `translate(${ox} ${oy})` : `translate(${ox + cx} ${oy + cy}) scale(${p}) translate(${-cx} ${-cy})`);
        const hidden = item.shown ? "" : "hidden";
        Object.assign(item.g.style, { opacity: item.opacity, visibility: hidden });
        for (const node of item.nodes) {
            const [nx, ny] = node.nudge ?? [0, 0];
            Object.assign(node.style, { opacity: item.opacity, visibility: node.dataset.held ? "hidden" : hidden });
            node.style.transform = `translate(${ox + nx}px, ${oy + ny}px) ${node.dataset.anchor ?? "translate(-50%, -50%)"} scale(${p})`;
        }
    };

    // Keeps written elements and labels apart: each steps aside from those written before it, and glides there.
    const declutter = () => {
        const entries = [];
        for (const item of items.values()) {
            if (!item.shown || item.leaving || item.opacity <= 0.05) continue;
            if (MOVABLE.has(item.def.type)) entries.push({ item, holder: item, box: () => boxOf(item.def.id) });
            else for (const node of Object.values(item.labels ?? {})) entries.push({ item, holder: node, box: () => rectOf([node]) });
        }
        const taken = [];
        let moving = false;
        for (const { item, holder, box: measure } of entries.sort((a, b) => a.item.order - b.item.order)) {
            const box = measure();
            if (!box || !Number.isFinite(box.x)) continue;
            holder.nudge ??= [0, 0];
            const home = { ...box, x: box.x - holder.nudge[0], y: box.y - holder.nudge[1], frame: item.def.type === "box" };
            // A morphing equation keeps its place until its glyphs have landed.
            if (!item.settle || !holder.push) holder.push = clearSpot(home, taken, W, H);
            taken.push({ ...home, x: home.x + holder.push[0], y: home.y + holder.push[1] });
            const k = holder.placed ? 0.2 : 1;
            holder.placed = true;
            const next = holder.nudge.map((v, i) => (Math.abs(holder.push[i] - v) < 0.5 ? holder.push[i] : v + (holder.push[i] - v) * k));
            if (next[0] === holder.nudge[0] && next[1] === holder.nudge[1]) continue;
            holder.nudge = next;
            place(item);
            moving ||= next[0] !== holder.push[0] || next[1] !== holder.push[1];
        }
        return moving;
    };

    // Writes an element in: strokes draw, fills fade up, glyphs and words appear in turn and dots pop.
    function show(item, duration, delay) {
        if (item.shown && !item.leaving) return;
        item.leaving = false;
        item.shown = true;
        item.order ??= ++revealed;
        item.opacity = num(item.def.opacity, 1);
        const lines = [...item.g.querySelectorAll("[pathLength]")];
        const fades = [...item.g.querySelectorAll(".fade, [data-fill]")];
        const leaves = item.nodes.flatMap(leavesOf);
        const pop = item.def.type === "dot";
        const set = (k) => {
            const e = smooth(k);
            for (const line of lines) Object.assign(line.style, { strokeDasharray: k < 1 ? "1 1" : "", strokeDashoffset: k < 1 ? 1 - e : "" });
            for (const node of fades) {
                const target = node.dataset.fill;
                if (target === undefined) node.style.opacity = clamp01((k - 0.4) / 0.6);
                else node.setAttribute("fill-opacity", Number(target) * clamp01((k - 0.4) / 0.6));
            }
            leaves.forEach((leaf, i) => {
                const t = clamp01((k * (leaves.length + 5) - i) / 6);
                Object.assign(leaf.style, { opacity: t < 1 ? t : "", filter: t < 1 ? `blur(${((1 - t) * 4).toFixed(1)}px)` : "" });
            });
            if (pop) item.pulse = overshoot(k);
        };
        set(0);
        tween(duration * (leaves.length > 12 ? 1.4 : 1), delay, set);
    }

    function hide(item, part, duration, delay) {
        if (part) return fadeNodes(partNodes(item, part), 0, duration, delay);
        const from = item.opacity;
        item.leaving = true;
        tween(duration, delay, (k) => (item.opacity = from * (1 - smooth(k))), () => {
            if (!item.leaving) return;
            item.shown = false;
            item.leaving = false;
            for (const holder of [item, ...Object.values(item.labels ?? {})]) holder.placed = false;
        });
    }

    const fadeNodes = (nodes, to, duration, delay) => {
        const from = nodes.map((node) => Number(node.style.opacity || 1));
        tween(duration, delay, (k) => nodes.forEach((node, i) => (node.style.opacity = lerp(from[i], to, smooth(k)))));
    };

    function recolor(item, part, to, duration, delay) {
        if (part) {
            const nodes = partNodes(item, part);
            const from = nodes.map((node) => getComputedStyle(node).color);
            return tween(duration, delay, (k) => nodes.forEach((node, i) => (node.style.color = k < 1 ? mix(from[i], to, smooth(k)) : to)));
        }
        const from = item.color;
        item.color = to;
        tween(duration, delay, (k) => {
            const c = k < 1 ? mix(from, to, smooth(k)) : to;
            item.g.setAttribute("color", c);
            for (const node of item.nodes) if (!item.textColor || node !== item.node) node.style.color = c;
        });
    }

    // Indicate: a quick swell and a flash of yellow, then back.
    function highlight(item, part, duration, delay) {
        const flash = NAMED.yellow;
        if (part) {
            const nodes = partNodes(item, part);
            const from = nodes.map((node) => getComputedStyle(node).color);
            return tween(duration, delay, (k) => nodes.forEach((node, i) => {
                const s = Math.sin(Math.PI * k);
                node.style.color = k < 1 ? mix(from[i], flash, s) : from[i];
                node.style.filter = k < 1 ? `drop-shadow(0 0 ${(s * 10).toFixed(1)}px ${flash})` : "";
            }));
        }
        const box = boxOf(item.def.id);
        item.pivot = box ? centre(box).map((v, i) => v - shift(item)[i]) : [0, 0];
        tween(duration, delay, (k) => {
            const s = Math.sin(Math.PI * k);
            item.pulse = 1 + 0.16 * s;
            item.g.setAttribute("color", k < 1 ? mix(item.color, flash, s * 0.85) : item.color);
            for (const node of item.nodes) node.style.color = k < 1 ? mix(item.textColor ?? item.color, flash, s * 0.85) : (item.textColor ?? item.color);
        });
    }

    function surround(action, target, duration, delay) {
        const box = boxOf(target);
        if (!box) return;
        const id = typeof action.id === "string" ? action.id : `surround-${++made}`;
        const def = { id, type: "surround", color: action.color ?? "yellow" };
        const item = itemOf(def, paint(def.color, NAMED.yellow), 4);
        stroke(item, "rect", { x: box.x - 14, y: box.y - 10, width: box.w + 28, height: box.h + 20, rx: 10 });
        items.set(id, item);
        show(item, duration, delay);
    }

    function move(item, action, duration, delay) {
        const from = [...item.offset];
        let to;
        if (isPair(action.by)) to = [from[0] + value(action.by[0]) * UNIT, from[1] - value(action.by[1]) * UNIT];
        else {
            const box = boxOf(item.def.id);
            const [cx, cy] = box ? centre({ ...box, x: box.x - item.nudge[0], y: box.y - item.nudge[1] }) : [W / 2, H / 2];
            const [tx, ty] = px([value(action.to[0]), value(action.to[1])]);
            to = [from[0] + tx - cx, from[1] + ty - cy];
        }
        tween(duration, delay, (k) => (item.offset = [lerp(from[0], to[0], smooth(k)), lerp(from[1], to[1], smooth(k))]));
    }

    // Like TransformMatchingTex: matching parts and symbols glide as ghosts, keeping KaTeX's layout intact.
    function morph(item, source, duration, delay) {
        item.settle?.();
        const old = item.node;
        const fresh = element("div", old.className, layer);
        fresh.style.cssText = old.style.cssText;
        if (old.dataset.anchor !== undefined) fresh.dataset.anchor = old.dataset.anchor;
        setTex(fresh, source);
        fitWidth(item, fresh);
        item.nodes.splice(item.nodes.indexOf(old), 1, fresh);
        item.node = fresh;
        if (!item.shown || (duration <= 0 && delay <= 0)) return old.remove();
        fresh.dataset.held = "1";
        let ghosts = null;
        let done = false;
        // A newer morph of the same equation finishes this one first, so glyphs never pile up.
        const finish = () => {
            if (done) return;
            done = true;
            ghosts?.forEach((g) => g.node.remove());
            old.remove();
            delete fresh.dataset.held;
            if (item.settle === finish) item.settle = null;
        };
        item.settle = finish;
        const glyphs = (node) => leavesOf(node).map((leaf) => {
            const cls = leaf.getAttribute("class") ?? "";
            const kind = cls.match(LEAF)?.[1];
            return { leaf, rect: rectOf([leaf]), text: kind ?? leaf.textContent.trim(), part: leaf.closest("[class^='p-'], [class*=' p-']")?.getAttribute("class").match(/(?:^| )p-([\w-]+)/)?.[1] ?? null };
        }).filter((g) => g.rect);
        const ghost = (glyph) => {
            const node = glyph.leaf.cloneNode(true);
            const cs = getComputedStyle(glyph.leaf);
            const r = glyph.rect;
            node.className = "ghost";
            node.removeAttribute("style");
            Object.assign(node.style, { position: "absolute", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, lineHeight: `${r.h}px`, fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontStyle: cs.fontStyle, fontWeight: cs.fontWeight, color: cs.color });
            if (glyph.text === "frac-line") Object.assign(node.style, { height: "0px", borderBottom: `${cs.borderBottomWidth} solid ${cs.color}` });
            layer.append(node);
            return node;
        };
        const begin = () => {
            place(item);
            const [before, after] = [glyphs(old), glyphs(fresh)];
            const pairs = [];
            const used = new Set();
            for (const g of after) {
                const match = before.find((o) => !used.has(o) && o.part === g.part && o.text === g.text) ?? (g.part && before.find((o) => !used.has(o) && o.part === g.part)) ?? before.find((o) => !used.has(o) && o.text === g.text);
                if (match) used.add(match);
                pairs.push([match, g]);
            }
            const list = pairs.map(([o, g]) => ({ node: ghost(g), from: o?.rect, to: g.rect, enter: !o }));
            for (const o of before.filter((b) => !used.has(b))) list.push({ node: ghost(o), leave: true });
            old.style.visibility = "hidden";
            return list;
        };
        tween(duration, delay, (k) => {
            if (done) return;
            ghosts ??= begin();
            const e = smooth(k);
            for (const g of ghosts) {
                if (g.leave) g.node.style.opacity = 1 - clamp01(k / 0.5);
                else if (g.enter) g.node.style.opacity = clamp01((k - 0.4) / 0.6);
                else {
                    const [dx, dy] = [g.from.x + g.from.w / 2 - (g.to.x + g.to.w / 2), g.from.y + g.from.h / 2 - (g.to.y + g.to.h / 2)];
                    const s = Math.min(4, Math.max(0.25, g.from.h / (g.to.h || 1)));
                    g.node.style.transform = `translate(${(dx * (1 - e)).toFixed(2)}px, ${(dy * (1 - e)).toFixed(2)}px) scale(${lerp(s, 1, e).toFixed(4)})`;
                }
            }
        }, finish);
    }

    function transform(item, action, duration, delay) {
        const to = String(action.to);
        if (item.def.type === "tex" || (item.def.type === "box" && typeof item.def.tex === "string")) {
            morph(item, to, duration, delay);
            if (item.rect) sizeBox(item);
            return;
        }
        if (item.node && ["text", "box"].includes(item.def.type)) {
            const old = item.node;
            item.node = textNode(item, to, false, num(item.def.size, item.def.type === "box" ? 0.36 : 0.42));
            item.node.style.cssText = old.style.cssText;
            if (old.dataset.anchor !== undefined) item.node.dataset.anchor = old.dataset.anchor;
            item.nodes.splice(item.nodes.indexOf(old), 1);
            if (item.rect) sizeBox(item);
            if (!item.shown) return old.remove();
            const leaves = leavesOf(item.node);
            tween(duration, delay, (k) => {
                old.style.opacity = 1 - clamp01(k / 0.5);
                leaves.forEach((leaf, i) => (leaf.style.opacity = k < 1 ? clamp01((k * (leaves.length + 4) - i - leaves.length * 0.4) / 4) : ""));
            }, () => old.remove());
            return;
        }
        if (["plot", "area"].includes(item.def.type)) {
            const before = fnOf(item);
            const after = (x) => value(to, x);
            tween(duration, delay, (k) => {
                const e = smooth(k);
                item.fn = k < 1 ? (x) => lerp(before(x), after(x), e) : after;
            });
        }
    }

    function flow(action, delay) {
        const id = typeof action.id === "string" ? action.id : `flow-${++made}`;
        stopFlow(id, 0);
        const target = items.get(String(action.target ?? "").split(".")[0]);
        const along = target?.path;
        const ends = !along && action.from !== undefined ? [action.from, action.to] : null;
        if (!along && !ends) return;
        const group = svgNode("g", { color: paint(action.color, NAMED.yellow), opacity: 0 }, top);
        const count = Math.round(Math.min(40, Math.max(2, num(action.count, 8))));
        const dots = Array.from({ length: count }, () => svgNode("circle", { r: 6, fill: "currentColor" }, group));
        const at = (u) => {
            if (along) {
                const length = along.getTotalLength();
                const p = along.getPointAtLength(u * length);
                const [ox, oy] = shift(target);
                return [p.x + ox, p.y + oy];
            }
            const [a, b] = ends.map((end) => (typeof end === "string" ? (boxOf(end) ? centre(boxOf(end)) : [W / 2, H / 2]) : px([value(end[0]), value(end[1])])));
            return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
        };
        flows.set(id, { group, dots, at, start: now + delay, speed: num(action.speed, 0.35) });
        tween(0.4, delay, (k) => group.setAttribute("opacity", k));
    }

    function stopFlow(id, duration) {
        const f = flows.get(id);
        if (!f) return;
        flows.delete(id);
        tween(duration, 0, (k) => f.group.setAttribute("opacity", 1 - k), () => f.group.remove());
    }

    function aim(action, duration, delay) {
        let to = [W / 2, H / 2];
        let z = 1;
        if (action.target !== undefined) {
            const box = boxOf(String([action.target].flat()[0]));
            if (box) {
                to = centre(box);
                z = num(action.value, Math.min(2.4, Math.max(1, Math.min(W / (box.w * 2.6), H / (box.h * 2.6)))));
            }
        } else if (isPair(action.to)) {
            to = px([value(action.to[0]), value(action.to[1])]);
            z = num(action.value, 1.6);
        }
        const from = { ...camera };
        tween(duration, delay, (k) => {
            const e = smooth(k);
            Object.assign(camera, { x: lerp(from.x, to[0], e), y: lerp(from.y, to[1], e), z: lerp(from.z, z, e) });
        });
    }

    function act(action, instant) {
        const duration = instant ? 0 : Math.min(10, Math.max(0.05, num(action.duration, TIME[action.do] ?? 1)));
        const delay = instant ? 0 : Math.min(10, Math.max(0, num(action.delay, 0)));
        if (action.do === "set") {
            const from = { ...vars };
            const to = action.vars ?? {};
            return tween(duration, delay, (k) => Object.keys(to).forEach((name) => Number.isFinite(to[name]) && (vars[name] = lerp(from[name] ?? 0, to[name], smooth(k)))));
        }
        if (action.do === "camera") return aim(action, duration, delay);
        if (action.do === "flow") return flow(action, delay);
        // apply with no target transforms every axes on the board.
        const targets = action.do === "apply" && action.target === undefined ? [...items].filter(([, item]) => item.map).map(([id]) => id) : [action.target].flat();
        for (const target of targets) {
            if (action.do === "hide" && flows.has(target)) {
                stopFlow(target, duration);
                continue;
            }
            const [id, part] = String(target).split(".");
            const item = items.get(id);
            if (!item) continue;
            if (action.do === "show") part ? fadeNodes(partNodes(item, part), 1, duration, delay) : show(item, duration, delay);
            else if (action.do === "hide") hide(item, part, duration, delay);
            else if (action.do === "move") move(item, action, duration, delay);
            else if (action.do === "color") recolor(item, part, paint(action.color, NAMED.yellow), duration, delay);
            else if (action.do === "highlight") highlight(item, part, duration, delay);
            else if (action.do === "surround") surround(action, target, duration, delay);
            else if (action.do === "opacity") {
                if (part) fadeNodes(partNodes(item, part), num(action.value, 1), duration, delay);
                else {
                    const from = item.opacity;
                    tween(duration, delay, (k) => (item.opacity = lerp(from, clamp01(num(action.value, 1)), smooth(k))));
                }
            } else if (action.do === "transform") transform(item, action, duration, delay);
            else if (action.do === "apply" && item.map) {
                const from = [...item.matrix];
                const to = action.matrix.flat();
                tween(duration, delay, (k) => (item.matrix = from.map((v, i) => lerp(v, to[i], smooth(k)))));
            }
        }
    }

    // Axes and plots first so elements on them can find them; then unhidden elements write in, in order.
    const rank = { axes: 0, plot: 1 };
    const listed = (spec.elements ?? []).map((def, index) => [def, index]);
    for (const [def, index] of [...listed].sort((a, b) => (rank[a[0].type] ?? 2) - (rank[b[0].type] ?? 2) || a[1] - b[1])) add(def, index);
    listed.filter(([def]) => !def.hidden).forEach(([def], i) => show(items.get(def.id), TIME.show, Math.min(2.4, i * 0.14)));

    return {
        step(index) {
            if (!Number.isInteger(index) || index <= played || index >= steps.length) return;
            for (let i = played + 1; i <= index; i++) for (const action of Array.isArray(steps[i]) ? steps[i] : []) act(action ?? {}, i < index);
            played = index;
            settle = 2;
        },
        addSteps(more) {
            steps.push(...more);
            for (const action of more.flat()) if (action?.do === "set") for (const [name, v] of Object.entries(action.vars ?? {})) if (!Number.isInteger(v)) whole.delete(name);
        },
        frame(t) {
            now = t;
            const busy = tweens.length || flows.size || settle > 0 || easing;
            for (const tw of [...tweens]) {
                if (now < tw.start) continue;
                const k = Math.min(1, (now - tw.start) / tw.duration);
                tw.update(k);
                if (k >= 1) {
                    tweens.splice(tweens.indexOf(tw), 1);
                    tw.done?.();
                }
            }
            if (!busy) return;
            settle = tweens.length ? 2 : settle - 1;
            spots = [];
            for (const item of items.values()) {
                if (!item.attached) item.draw?.();
                refreshText(item);
                follow(item);
                place(item);
            }
            easing = declutter();
            for (const item of items.values()) if (item.attached) item.draw?.();
            for (const f of flows.values()) {
                const t = Math.max(0, now - f.start) * f.speed;
                f.dots.forEach((dot, i) => {
                    const u = (((t + i / f.dots.length) % 1) + 1) % 1;
                    const [x, y] = f.at(u);
                    dot.setAttribute("cx", x);
                    dot.setAttribute("cy", y);
                    dot.setAttribute("r", ((3 + 4 * Math.sin(Math.PI * u)) / camera.z).toFixed(1));
                });
            }
            cam.style.transform = `translate(${W / 2 - camera.x * camera.z}px, ${H / 2 - camera.y * camera.z}px) scale(${camera.z})`;
        },
        dispose() {
            tweens.length = 0;
            flows.clear();
            world.replaceChildren();
        },
    };
}

// spec: { elements, vars, steps, autoplay, stepSeconds, loop }; returns { step(index), dispose() }.
export async function renderBoard(spec, { root }) {
    const katex = await loadKatex();
    const inset = spec.autoplay === false ? 110 : 0;
    const stage = element("div", "board", root);
    const world = element("div", "board-world", stage);
    const fit = () => {
        const w = root.clientWidth || innerWidth;
        const h = Math.max(1, (root.clientHeight || innerHeight) - inset);
        const k = Math.min(w / W, h / H);
        world.style.transform = `translate(${(w - W * k) / 2}px, ${(h - H * k) / 2}px) scale(${k})`;
    };
    fit();
    let board = build(spec, world, katex);
    let timer = 0;
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    // Standalone boards play their steps on a timer and loop; explanations drive the steps instead.
    if (spec.autoplay !== false && steps.length) {
        const every = Math.min(20, Math.max(1, num(spec.stepSeconds, 3.2))) * 1000;
        let next = 0;
        const tick = () => {
            if (next >= steps.length) {
                if (spec.loop === false) return;
                board.dispose();
                board = build(spec, world, katex);
                next = 0;
                timer = setTimeout(tick, 2500);
                return;
            }
            board.step(next++);
            timer = setTimeout(tick, every);
        };
        timer = setTimeout(tick, 2500);
    }
    let raf = 0;
    const loop = () => {
        raf = requestAnimationFrame(loop);
        board.frame(performance.now() / 1000);
    };
    loop();
    const resize = new ResizeObserver(fit);
    resize.observe(root);
    return {
        step: (index) => board.step(index),
        addSteps: (more) => board.addSteps(more),
        dispose() {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
            resize.disconnect();
            board.dispose();
            stage.remove();
        },
    };
}
