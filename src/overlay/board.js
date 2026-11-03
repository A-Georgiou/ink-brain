// 3Blue1Brown-style boards: typeset maths, graphs and diagrams that animate in time with narration.
import { compile } from "/shared/mathexpr.mjs";
import { BOARD_MARGIN, circleRadius, clearNodeSpot, clearSpot, katexOptions, labelTex, linkBend, linkLabelGap, linkLabelSide, loopAround, placeLinkLabel, routeBend, routeDiagramLink, sequenceLink, withValues } from "/shared/board.mjs";

// A 16 by 9 unit board of 100 px units, origin in the middle and y up: SVG shapes under KaTeX text.
const [W, H, UNIT] = [1600, 900, 100];
const NS = "http://www.w3.org/2000/svg";
// Manim's palette, so colours named by the model look right on the dark board.
const NAMED = { blue: "#58C4DD", teal: "#2EE6A8", green: "#83C167", yellow: "#FFE45E", gold: "#F0AC5F", orange: "#FF862F", red: "#FC6255", maroon: "#C55F73", purple: "#9A72AC", pink: "#D147BD", grey: "#A6B0BE", gray: "#A6B0BE", white: "#ECECEC" };
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
.board-html>div{position:absolute;white-space:nowrap;color:#ECECEC;line-height:1.25;transform-origin:center;text-shadow:0 0 6px #0d1117,0 0 12px #0d1117,0 1px 3px #0d1117}
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
    const connections = new Map();
    for (const def of spec.elements ?? []) {
        if (!["line", "arrow"].includes(def.type) || typeof def.from !== "string" || typeof def.to !== "string") continue;
        const [a, b] = [def.from.split(".")[0], def.to.split(".")[0]];
        if (a === b) continue;
        for (const [id, other] of [[a, b], [b, a]]) {
            if (!connections.has(id)) connections.set(id, new Set());
            connections.get(id).add(other);
        }
    }
    const vars = { ...(spec.vars ?? {}) };
    const names = ["x", ...Object.keys(vars)];
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    const kinds = new Set((spec.elements ?? []).map((item) => item.type));
    const nodes = (spec.elements ?? []).filter((item) => ["box", "circle"].includes(item.type)).length;
    let autoFrame = (nodes >= 2 || (nodes && ["line", "arrow"].some((type) => kinds.has(type)))) && !["axes", "plot", "area", "vector", "tangent", "brace"].some((type) => kinds.has(type));
    let framing = autoFrame;
    // A variable that only ever holds whole numbers, such as a count, also shows whole numbers while it animates.
    const sets = steps.flat().filter((action) => action?.do === "set");
    const whole = new Set(Object.keys(vars).filter((name) => [vars[name], ...sets.filter((a) => a.vars && name in a.vars).map((a) => a.vars[name])].every(Number.isInteger)));
    const live = (source) => withValues(source, vars, whole);
    const tweens = [];
    const flows = new Map();
    const surrounds = new Set();
    const camera = { x: W / 2, y: H / 2, z: 1 };
    const compiled = new Map();
    let now = performance.now() / 1000;
    let played = -1;
    let made = 0;
    let revealed = 0;
    let settle = 2;
    let easing = false;

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
        for (const node of item.g.querySelectorAll("path, circle, ellipse, rect, text")) {
            const b = node.getBBox();
            if (b.width || b.height) box = union(box, { x: b.x + ox, y: b.y + oy, w: b.width, h: b.height });
        }
        return box;
    };

    const setTex = (node, source) => {
        const shown = live(source).replace(/(?<!\\)%/g, "\\%");
        katex.render(shown, node, katexOptions());
        node.dataset.source = source;
        node.dataset.shown = shown;
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
            node.dataset.boardId = item.def.id;
            node.style.fontSize = `${Math.max(0.46, num(item.def.size, 0.48)) * UNIT}px`;
            node.style.color = item.textColor ?? item.color;
            item.nodes.push(node);
            watchText(item, node);
        }
        const tex = labelTex(source);
        if (node.dataset.source !== tex || node.dataset.shown !== live(tex)) setTex(node, tex);
        Object.assign(node.style, { left: `${x}px`, top: `${y}px` });
        node.dataset.anchor = anchor;
    };
    const texSize = (_item, source, size) => Math.max(/\\frac\b/.test(source) ? 0.58 : 0.48, size);
    const textNode = (item, source, tex, size) => {
        const wrap = item.def.width && item.def.type === "text";
        const node = element("div", tex ? "board-tex" : `board-text${item.def.font === "sans" ? " sans" : ""}`, layer);
        node.dataset.boardId = item.def.id;
        const sideNote = item.def.type === "text" && isPair(item.def.at) && Math.abs(Number(item.def.at[0])) > 4.5;
        const minSize = ["box", "circle"].includes(item.def.type) ? 0.36 : sideNote ? 0.32 : 0.38;
        const pxSize = (tex ? texSize(item, source, size) : Math.max(minSize, size)) * UNIT;
        node.style.fontSize = `${pxSize}px`;
        (tex ? setTex : setText)(node, source);
        if (wrap) {
            const maxW = item.def.width * UNIT;
            if (node.offsetWidth > maxW && node.offsetWidth <= maxW * 1.15) {
                node.style.fontSize = `${pxSize * (maxW / node.offsetWidth)}px`;
            } else if (node.offsetWidth > maxW) {
                node.classList.add("wrap");
                node.style.maxWidth = `${maxW}px`;
            }
        }
        if (!wrap) fitWidth(item, node);
        item.nodes.push(node);
        watchText(item, node);
        return node;
    };
    // Text too wide for the board is set smaller so that it fits.
    const fitWidth = (item, node) => {
        const ax = isPair(item.def.at) && typeof item.def.at[0] === "number" && !item.def.on ? px(item.def.at)[0] : W / 2;
        const sideRoom = ax > W * 0.58 ? (W - ax - 36) * 2 : W - 2 * BOARD_MARGIN;
        const room = Math.min(W - 2 * BOARD_MARGIN - (item.def.type === "box" ? 56 : 0), Math.max(520, sideRoom));
        if (node.offsetWidth > room) node.style.fontSize = `${parseFloat(node.style.fontSize) * Math.max(0.5, room / node.offsetWidth)}px`;
    };
    // A box is never smaller than its text, and shrinks its text to fit when an explicit width is given.
    const sizeBox = (item) => {
        const axes = axesOf(item);
        const [cx, cy] = axes ? pointOf(item, item.def.at ?? [0, 0]) : atOf(item.def);
        const [sx, sy] = axes ? axes.scale : [UNIT, UNIT];
        const givenW = item.def.width !== undefined ? Math.abs(value(item.def.width)) * sx : 0;
        const givenH = item.def.height !== undefined ? Math.abs(value(item.def.height)) * sy : 0;
        const padX = axes || (givenW > 0 && givenW < 140) ? 16 : 32;
        const padY = axes || (givenH > 0 && givenH < 90) ? 14 : 24;
        if (item.node && givenW > 24 && item.node.offsetWidth + padX > givenW * (axes || givenW < 140 ? 1 : 1.12)) {
            const targetW = givenW * (axes || givenW < 140 ? 1 : 1.12) - padX;
            item.node.style.fontSize = `${parseFloat(item.node.style.fontSize) * Math.max(axes || givenW < 140 ? 0.45 : 0.72, targetW / item.node.offsetWidth)}px`;
        }
        const w = givenW > 0 ? Math.max(givenW, item.node ? item.node.offsetWidth + padX : 20) : Math.max(0, item.node ? item.node.offsetWidth + 56 : 240);
        const h = givenH > 0 ? Math.max(givenH, item.node ? item.node.offsetHeight + padY : 20) : Math.max(0, item.node ? item.node.offsetHeight + 40 : 110);
        const attrs = { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: axes ? Math.min(8, w / 6, h / 6) : Math.min(18, h / 4) };
        for (const [key, v] of Object.entries(attrs)) item.rect.setAttribute(key, v);
        if (item.node) Object.assign(item.node.style, { left: `${cx}px`, top: `${cy}px` });
    };
    const sizeCircle = (item) => {
        const [cx, cy] = pointOf(item, item.def.at ?? [0, 0]);
        const r = Math.max(0, value(item.def.r ?? 1));
        const axes = axesOf(item);
        if (item.circle) {
            const radius = item.node ? circleRadius(r * UNIT, item.node.offsetWidth, item.node.offsetHeight) : r * UNIT;
            for (const [k, v] of Object.entries({ cx, cy, r: radius })) item.circle.setAttribute(k, v);
        } else if (item.ellipse) {
            const [rx, ry] = axes ? [r * axes.scale[0], r * axes.scale[1]] : [r * UNIT, r * UNIT];
            for (const [k, v] of Object.entries({ cx, cy, rx, ry })) item.ellipse.setAttribute(k, v);
            if (item.def.label) label(item, "label", item.def.label, [cx + rx + 16, cy - 16], "translate(0, -50%)");
        }
        if (item.node) Object.assign(item.node.style, { left: `${cx}px`, top: `${cy}px` });
    };
    const textOwners = new WeakMap();
    const textResize = new ResizeObserver((entries) => {
        for (const { target } of entries) {
            const item = textOwners.get(target);
            if (!item) continue;
            if (item.node === target && item.rect) sizeBox(item);
            if (item.node === target && item.def.type === "circle") sizeCircle(item);
            settle = Math.max(settle, 2);
        }
    });
    const watchText = (item, node) => {
        if (!["box", "circle", "line", "arrow"].includes(item.def.type)) return;
        textOwners.set(node, item);
        textResize.observe(node);
    };
    // An item's function of x: its own, else the plot it is on, else its fn expression.
    const fnOf = (item) => item.fn ?? items.get(item.def.on)?.fn ?? ((x) => value(item.def.fn, x));
    const refreshText = (item) => {
        const node = item.node;
        if (node && /\\val\{/.test(node.dataset.source) && node.dataset.shown !== live(node.dataset.source)) {
            const plain = item.def.type === "text" || (["box", "circle"].includes(item.def.type) && typeof item.def.tex !== "string");
            (plain ? setText : setTex)(node, node.dataset.source);
            if (item.rect) sizeBox(item);
            if (item.def.type === "circle") sizeCircle(item);
        }
    };
    // Text and boxes placed by expressions of vars or sitting on axes follow them as set or apply animates.
    const follow = (item) => {
        if (item.def.type === "box" && (axesOf(item) || [item.def.at, [item.def.width, item.def.height]].flat().some((v) => typeof v === "string"))) return sizeBox(item);
        if (!item.node || (!axesOf(item) && (!Array.isArray(item.def.at) || !item.def.at.some((v) => typeof v === "string")))) return;
        const [x, y] = TEXT_TYPES.has(item.def.type) ? pointOf(item, item.def.at ?? [0, 0]) : atOf(item.def);
        Object.assign(item.node.style, { left: `${x}px`, top: `${y}px` });
        if (item.def.type === "box") sizeBox(item);
        if (item.def.type === "circle") sizeCircle(item);
    };

    // Joins points or elements; an element end stops at its edge, facing the other end.
    const edge = (box, toward, gap) => {
        const [cx, cy] = centre(box);
        const [dx, dy] = [toward[0] - cx, toward[1] - cy];
        const s = Math.min(Math.abs((box.w / 2 + gap) / (dx || 1e-9)), Math.abs((box.h / 2 + gap) / (dy || 1e-9)), 1);
        return [cx + dx * s, cy + dy * s];
    };
    const arrowTip = (item, point, direction, size) => {
        const [x, y] = [point[0] - direction[0] * size, point[1] - direction[1] * size];
        item.tip.setAttribute("d", `M${point.join(",")}L${x - direction[1] * size * 0.42},${y + direction[0] * size * 0.42}L${x + direction[1] * size * 0.42},${y - direction[0] * size * 0.42}Z`);
    };
    const linkPoints = (item) => {
        const [x, y] = shift(item);
        const key = `${item.path.getAttribute("d")},${x},${y}`;
        if (key === item.pointsKey) return item.points;
        item.pointsKey = key;
        try {
            const length = item.path.getTotalLength();
            const count = Math.max(1, Math.min(60, Math.ceil(length / 30)));
            item.points = Array.from({ length: count + 1 }, (_, i) => {
                const p = item.path.getPointAtLength((length * i) / count);
                return [p.x + x, p.y + y];
            });
        } catch {
            item.points = [];
        }
        return item.points;
    };
    const drawLink = (item, from, to, tipped) => {
        const [ox, oy] = shift(item);
        if (typeof from === "string" && from === to) {
            const box = boxOf(from);
            if (!box) return;
            const loop = loopAround({ ...box, x: box.x - ox, y: box.y - oy });
            const direction = unit([loop.to[0] - loop.control2[0], loop.to[1] - loop.control2[1]]);
            const tip = tipped ? 26 + item.width * 2 : 0;
            const end = [loop.to[0] - direction[0] * tip * 0.75, loop.to[1] - direction[1] * tip * 0.75];
            item.path.setAttribute("d", `M${loop.from.join(",")}C${loop.control1.join(",")} ${loop.control2.join(",")} ${end.join(",")}`);
            if (tipped) arrowTip(item, loop.to, direction, tip);
            const h = item.labels?.label?.offsetHeight ?? num(item.def.size, 0.45) * UNIT;
            const y = (loop.from[1] + 3 * loop.control1[1] + 3 * loop.control2[1] + loop.to[1]) / 8;
            label(item, "label", item.def.label, [(loop.from[0] + loop.to[0]) / 2, y + loop.side * (h / 2 + 14)]);
            return;
        }
        const middle = (end) => (typeof end === "string" ? (boxOf(end) && centre(boxOf(end))) : pointOf(item, end));
        const [ca, cb] = [middle(from), middle(to)];
        if (!ca || !cb) return;
        let a = typeof from === "string" ? edge(boxOf(from), cb, 12) : [...ca];
        let b = typeof to === "string" ? edge(boxOf(to), ca, 12) : [...cb];
        if (typeof from === "string") [a[0], a[1]] = [a[0] - ox, a[1] - oy];
        if (typeof to === "string") [b[0], b[1]] = [b[0] - ox, b[1] - oy];
        // A diagonal secant line on axes keeps a visible span as its two points converge.
        if (item.def.on && item.def.type === "line" && [from, to].flat().some((v) => typeof v === "string") && Math.abs(b[0] - a[0]) > 0.5 && Math.abs(b[1] - a[1]) > 0.5) {
            const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (span > 1e-4 && span < 220) {
                const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                const [dx, dy] = [(b[0] - a[0]) / span, (b[1] - a[1]) / span];
                a = [mx - dx * 110, my - dy * 110];
                b = [mx + dx * 110, my + dy * 110];
            }
        }
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
        if (item.def.type === "vector" && item.def.on) {
            const collinear = [...items.values()].some((other) => {
                if (other === item || !other.shown || other.leaving || other.def.type !== "vector" || other.def.on !== item.def.on || (other.order ?? 0) >= (item.order ?? Infinity)) return false;
                const oa = pointOf(other, other.def.from ?? [0, 0]);
                const ob = pointOf(other, other.def.to ?? other.def.at);
                return Math.hypot(oa[0] - a[0], oa[1] - a[1]) < 8 && Math.abs(normal[0] * (ob[0] - oa[0]) + normal[1] * (ob[1] - oa[1])) < 6;
            });
            if (collinear) {
                a = [a[0] + normal[0] * 7, a[1] + normal[1] * 7];
                b = [b[0] + normal[0] * 7, b[1] + normal[1] * 7];
            }
        }
        if (item.ghost) {
            const axes = axesOf(item);
            const m = axes?.matrix;
            const deformed = m && Math.hypot(m[0] - 1, m[1], m[2], m[3] - 1) > 0.05;
            if (deformed && isPair(from) && isPair(to)) {
                const ga = axes.baseMap([value(from[0]), value(from[1])]);
                const gb = axes.baseMap([value(to[0]), value(to[1])]);
                const glen = Math.hypot(gb[0] - ga[0], gb[1] - ga[1]);
                if (glen > 8) {
                    const gdir = [(gb[0] - ga[0]) / glen, (gb[1] - ga[1]) / glen];
                    const gn = [-gdir[1], gdir[0]];
                    const same = Math.abs(gn[0] * (b[0] - ga[0]) + gn[1] * (b[1] - ga[1])) < 6;
                    const [sx, sy] = same ? [gn[0] * -6, gn[1] * -6] : [0, 0];
                    const [gx0, gy0, gx1, gy1] = [ga[0] + sx, ga[1] + sy, gb[0] + sx, gb[1] + sy];
                    const span = `M${(ga[0] - gdir[0] * 80).toFixed(1)},${(ga[1] - gdir[1] * 80).toFixed(1)}L${(gb[0] + gdir[0] * 140).toFixed(1)},${(gb[1] + gdir[1] * 140).toFixed(1)}`;
                    const head = `M${gx0.toFixed(1)},${gy0.toFixed(1)}L${gx1.toFixed(1)},${gy1.toFixed(1)}M${(gx1 - gdir[0] * 14 - gn[0] * 6).toFixed(1)},${(gy1 - gdir[1] * 14 - gn[1] * 6).toFixed(1)}L${gx1.toFixed(1)},${gy1.toFixed(1)}L${(gx1 - gdir[0] * 14 + gn[0] * 6).toFixed(1)},${(gy1 - gdir[1] * 14 + gn[1] * 6).toFixed(1)}`;
                    item.ghost.setAttribute("d", `${span}${head}`);
                } else item.ghost.setAttribute("d", "");
            } else item.ghost.setAttribute("d", "");
        }
        const graph = !item.def.on && ["line", "arrow"].includes(item.def.type);
        item.sequence = graph && isPair(from) && isPair(to) && sequenceLink(a, b);
        const routing = routeDiagramLink(item.def, item.sequence);
        let desired = graph ? linkBend(item.def, [...items.values()].map((other) => other.def)) : num(item.def.bend, 0);
        if (graph && !Number.isFinite(item.def.bend) && typeof from === "string" && typeof to === "string" && from !== to) {
            const [u0, v0] = [from.split(".")[0], to.split(".")[0]];
            const siblings = [...items.values()].filter((o) => ["line", "arrow"].includes(o.def.type) && typeof o.def.from === "string" && typeof o.def.to === "string" && ((o.def.from.split(".")[0] === u0 && o.def.to.split(".")[0] === v0) || (o.def.from.split(".")[0] === v0 && o.def.to.split(".")[0] === u0)));
            if (siblings.length > 2) {
                const idx = siblings.indexOf(item);
                const sign = u0 < v0 ? 1 : -1;
                const dirSign = from.split(".")[0] === u0 ? 1 : -1;
                desired = ([0.42, -0.42, 0.88, -0.88, 1.3, -1.3][idx] ?? 0.5) * sign * dirSign;
            }
        }
        const isNode = (other) => other.def.type === "box" || (other.def.type === "circle" && Boolean(other.node));
        const terminals = [from, to].filter((end) => typeof end === "string").map((end) => end.split(".")[0]);
        const blockers = routing
            ? [...items.values()].flatMap((other) => {
                  if (other === item || !other.shown || other.leaving || other.opacity <= 0.15 || terminals.includes(other.def.id)) return [];
                  const box = isNode(other)
                      ? boxOf(other.def.id)
                      : other.order < item.order && other.labels?.label
                        ? rectOf([other.labels.label])
                        : null;
                  return box ? [{ ...box, x: box.x - ox, y: box.y - oy, node: isNode(other) }] : [];
              })
            : [];
        if (routing && !Number.isFinite(item.def.bend)) {
            const near = (r, p) => p[0] >= r.x - 12 && p[0] <= r.x + r.w + 12 && p[1] >= r.y - 12 && p[1] <= r.y + r.h + 12;
            const endBox = (end, p) => {
                if (typeof end === "string") {
                    const r = boxOf(end);
                    return r && { ...r, x: r.x - ox, y: r.y - oy };
                }
                return blockers.find((r) => r.node && near(r, p));
            };
            const [sa, sb] = [endBox(from, a), endBox(to, b)];
            const mid = sa && sb && sa !== sb ? blockers.filter((r) => r.node && r !== sa && r !== sb && Math.min(a[1], b[1]) < r.y + r.h && Math.max(a[1], b[1]) > r.y && Math.max(a[0], b[0]) >= r.x - 8 && Math.min(a[0], b[0]) <= r.x + r.w + 8) : [];
            if (mid.length) {
                const leftX = Math.min(sa.x, sb.x, ...mid.map((r) => r.x));
                a = [sa.x - 10, sa.y + sa.h / 2];
                b = [sb.x - 10, sb.y + sb.h / 2];
                const spanY = Math.max(120, Math.abs(b[1] - a[1]));
                const needed = Math.max(0.42, ((0.5 * (a[0] + b[0]) - (leftX - 42)) * 4) / spanY);
                desired = (b[1] >= a[1] ? 1 : -1) * Math.min(1.1, needed);
            }
        }
        const length2 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const normal2 = [-(b[1] - a[1]) / length2, (b[0] - a[0]) / length2];
        const key = JSON.stringify([a, b, desired, blockers]);
        if (key !== item.routeKey) {
            item.routeKey = key;
            item.route = routing ? routeBend(a, b, desired, blockers) : desired;
        }
        const bend = item.route * length2 * 0.5;
        const control = [(a[0] + b[0]) / 2 + normal2[0] * bend, (a[1] + b[1]) / 2 + normal2[1] * bend];
        const tip = tipped ? Math.min(length2 * 0.45, 26 + item.width * 2) : 0;
        const dir = unit([b[0] - control[0], b[1] - control[1]]);
        const end = [b[0] - dir[0] * tip * 0.75, b[1] - dir[1] * tip * 0.75];
        item.path.setAttribute("d", bend ? `M${a.join(",")}Q${control.join(",")} ${end.join(",")}` : `M${a.join(",")}L${end.join(",")}`);
        if (tipped) arrowTip(item, b, dir, tip);
        const crossedAxis =
            graph &&
            isPair(from) &&
            isPair(to) &&
            [...items.values()].some((other) => {
                if (other === item || !other.shown || other.leaving || other.def.on || !["line", "arrow"].includes(other.def.type) || !isPair(other.def.from) || !isPair(other.def.to)) return false;
                const [oa, ob] = [pointOf(other, other.def.from), pointOf(other, other.def.to)];
                const od = unit([ob[0] - oa[0], ob[1] - oa[1]]);
                return Math.abs(dir[0] * od[0] + dir[1] * od[1]) < 0.25 && Math.hypot((oa[0] + ob[0]) / 2 - (a[0] + b[0]) / 2, (oa[1] + ob[1]) / 2 - (a[1] + b[1]) / 2) < length2 * 0.35;
            });
        if (graph && !crossedAxis) {
            const side = linkLabelSide(normal2, bend, item.sequence);
            const node = item.labels?.label;
            const gap = linkLabelGap(normal2, node?.offsetWidth ?? 0, node?.offsetHeight ?? num(item.def.size, 0.45) * UNIT);
            let spot = [(a[0] + b[0]) / 2 + normal2[0] * (bend / 2 + side * gap), (a[1] + b[1]) / 2 + normal2[1] * (bend / 2 + side * gap)];
            if (node?.offsetWidth && node.offsetHeight) {
                const labelObstacles = [...items.values()].flatMap((other) => {
                    if (other === item || !other.shown || other.leaving || other.opacity <= 0.15) return [];
                    if (isNode(other)) {
                        const box = boxOf(other.def.id);
                        return box ? [{ ...box, x: box.x - ox, y: box.y - oy, node: true }] : [];
                    }
                    if ((other.order ?? 0) < (item.order ?? Infinity)) {
                        const box = TEXT_TYPES.has(other.def.type) ? boxOf(other.def.id) : other.labels?.label ? rectOf([other.labels.label]) : null;
                        return box ? [{ ...box, x: Math.round(box.x - ox), y: Math.round(box.y - oy), w: Math.round(box.w), h: Math.round(box.h), node: false }] : [];
                    }
                    return [];
                });
                const paths = [...items.values()]
                    .filter((other) => other !== item && other.shown && !other.leaving && other.opacity > 0.15 && other.path && ["line", "arrow"].includes(other.def.type))
                    .map((other) => linkPoints(other).map(([x, y]) => [Math.round(x - ox), Math.round(y - oy)]));
                const options = { a: a.map(Math.round), b: b.map(Math.round), control: control.map(Math.round), width: node.offsetWidth, height: node.offsetHeight, side, obstacles: labelObstacles, paths };
                const labelKey = JSON.stringify(options);
                if (labelKey !== item.labelKey) {
                    item.labelKey = labelKey;
                    item.labelSpot = placeLinkLabel(options);
                }
                spot = item.labelSpot;
            }
            label(item, "label", item.def.label, spot);
            return;
        }
        if (crossedAxis) {
            const tipSpot = Math.abs(dir[0]) > Math.abs(dir[1]) ? [b[0] - dir[0] * 28, b[1] - 32] : [b[0] + 22, b[1] - dir[1] * 20];
            const tipAnchor = Math.abs(dir[0]) > Math.abs(dir[1]) ? "translate(-50%, -50%)" : "translate(0, -50%)";
            label(item, "label", item.def.label, tipSpot, tipAnchor);
            return;
        }
        const sharedMid = item.def.on && [...items.values()].some((other) => {
            if (other === item || !other.shown || other.leaving || other.def.on !== item.def.on || !other.labels?.label || (other.order ?? 0) >= (item.order ?? Infinity)) return false;
            const oa = pointOf(other, other.def.from ?? [0, 0]);
            const ob = pointOf(other, other.vecTo ?? other.def.to ?? other.def.at ?? [0, 0]);
            return Math.hypot((oa[0] + ob[0]) / 2 - (a[0] + b[0]) / 2, (oa[1] + ob[1]) / 2 - (a[1] + b[1]) / 2) < 28;
        });
        const side = (bend < 0 ? -1 : 1) * (sharedMid ? -1 : 1);
        const out = [normal2[0] * side, normal2[1] * side];
        const spot = [(a[0] + b[0]) / 2 + out[0] * (bend / 2 + (Math.abs(out[0]) > 0.45 ? 18 : 34)), (a[1] + b[1]) / 2 + out[1] * (bend / 2 + 32)];
        const vecEnd = item.vecTo ?? item.def.to ?? item.def.at;
        const vecSpot = [b[0] + dir[0] * 28, b[1] + dir[1] * 28 - (Math.abs(dir[1]) < 0.15 ? 22 : 0)];
        const anchor = isPair(vecEnd) && item.def.type === "vector" ? "translate(-50%, -50%)" : out[0] > 0.45 ? "translate(0, -50%)" : out[0] < -0.45 ? "translate(-100%, -50%)" : "translate(-50%, -50%)";
        label(item, "label", item.def.label, isPair(vecEnd) && item.def.type === "vector" ? vecSpot : spot, anchor);
        if (item.labels?.label) {
            const dynamicSeg = item.def.on && ["line", "arrow"].includes(item.def.type) && [item.def.from, item.def.to].flat().some((v) => typeof v === "string");
            if (Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) < (dynamicSeg ? 18 : 6)) item.labels.label.dataset.held = "1";
            else delete item.labels.label.dataset.held;
        }
    };

    const BUILD = {
        tex(item) {
            item.node = textNode(item, item.def.tex, true, num(item.def.size, 0.6));
        },
        text(item) {
            item.node = textNode(item, item.def.text, false, num(item.def.size, 0.44));
        },
        box(item) {
            const content = item.def.tex ?? item.def.text;
            item.textColor = paint(item.def.text_color, "#ECECEC");
            if (typeof content === "string") item.node = textNode(item, content, typeof item.def.tex === "string", num(item.def.size, typeof item.def.tex === "string" ? 0.48 : 0.42));
            const fill = item.def.fill === false ? 0 : 0.14;
            item.rect = stroke(item, "rect", { fill: "currentColor", "fill-opacity": fill, "data-fill": fill });
            item.draw = () => sizeBox(item);
            sizeBox(item);
        },
        circle(item) {
            const fill = item.def.fill ? 0.25 : 0;
            const content = item.def.tex ?? item.def.text;
            const isNode = typeof content === "string" || Boolean(item.def.fill);
            item.textColor = paint(item.def.text_color, "#ECECEC");
            if (typeof content === "string") item.node = textNode(item, content, typeof item.def.tex === "string", num(item.def.size, 0.38));
            const fillAttr = isNode ? { "data-fill": fill } : {};
            if (item.def.on) item.ellipse = stroke(item, "ellipse", { fill: "currentColor", "fill-opacity": fill, ...fillAttr });
            else item.circle = stroke(item, "circle", { fill: "currentColor", "fill-opacity": fill, ...fillAttr });
            item.draw = () => sizeCircle(item);
            sizeCircle(item);
        },
        line(item) {
            item.path = stroke(item, "path", item.def.on ? { "clip-path": `url(#clip-${axesOf(item)?.def.id})` } : {});
            item.draw = () => drawLink(item, item.def.from, item.def.to, false);
        },
        arrow(item) {
            item.path = stroke(item, "path");
            item.tip = solid(item, "path");
            item.draw = () => drawLink(item, item.def.from, item.def.to, true);
        },
        vector(item) {
            if (item.def.on) item.ghost = svgNode("path", { fill: "none", stroke: "currentColor", "stroke-width": 2.5, "stroke-opacity": 0.4, "stroke-dasharray": "8 6", "clip-path": `url(#clip-${axesOf(item)?.def.id})` }, item.g);
            BUILD.arrow(item);
            item.draw = () => drawLink(item, item.def.from ?? [0, 0], item.vecTo ?? item.def.to ?? item.def.at, true);
        },
        path(item) {
            const fill = item.def.fill ? 0.22 : 0;
            if (item.def.on) item.ghost = svgNode("path", { fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-opacity": 0.34, "stroke-dasharray": "8 6", "clip-path": `url(#clip-${axesOf(item)?.def.id})` }, item.g);
            item.path = stroke(item, "path", { fill: "currentColor", "fill-opacity": fill, "data-fill": fill });
            const curved = item.def.curve ?? !item.def.closed;
            item.draw = () => {
                const axes = axesOf(item);
                const m = axes?.matrix;
                if (item.ghost) {
                    const deformed = m && Math.hypot(m[0] - 1, m[1], m[2], m[3] - 1) > 0.05;
                    item.ghost.setAttribute("d", deformed ? through(item.def.points.map((p) => axes.baseMap([value(p[0]), value(p[1])])), curved, Boolean(item.def.closed)) : "");
                }
                item.path.setAttribute("d", through(item.def.points.map((p) => pointOf(item, p)), curved, Boolean(item.def.closed)));
            };
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
            item.scale = [w / (x1 - x0), h / (y1 - y0)];
            item.matrix = [1, 0, 0, 1];
            const baseMap = ([mx, my]) => [cx - w / 2 + ((mx - x0) / (x1 - x0)) * w, cy + h / 2 - ((my - y0) / (y1 - y0)) * h];
            item.baseMap = baseMap;
            item.map = ([mx, my]) => {
                const [a, b, c, e] = item.matrix;
                return baseMap([a * mx + b * my, c * mx + e * my]);
            };
            const clip = svgNode("clipPath", { id: `clip-${d.id}` }, defs);
            svgNode("rect", { x: cx - w / 2 - 8, y: cy - h / 2 - 8, width: w + 16, height: h + 16 }, clip);
            const refGrid = d.grid ? svgNode("path", { stroke: "#888888", "stroke-opacity": 0.16, "stroke-width": 1.5, fill: "none", "clip-path": `url(#clip-${d.id})` }, item.g) : null;
            const grid = d.grid ? svgNode("path", { stroke: "#58C4DD", "stroke-opacity": 0.34, "stroke-width": 2, fill: "none", pathLength: 1, "clip-path": `url(#clip-${d.id})` }, item.g) : null;
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
            const texts = numbers.map(([, v]) =>
                Object.assign(svgNode("text", { "font-size": 34, "font-family": "KaTeX_Main, serif", fill: "#C9D1D9", stroke: "#0d1117", "stroke-width": 7, "stroke-linejoin": "round", "paint-order": "stroke", class: "fade" }, item.g), {
                    textContent: String(v).replace("-", "\u2212"),
                }),
            );
            item.draw = () => {
                const [ax, ay] = [x0 <= 0 && x1 >= 0 ? 0 : x0, y0 <= 0 && y1 >= 0 ? 0 : y0];
                const line = (p, q, map = item.map) => `M${map(p).join(",")}L${map(q).join(",")}`;
                if (grid) {
                    const [sx, sy] = [x1 - x0, y1 - y0];
                    const gridPath = (map) => {
                        const rows = [...marks(x0 - sx, x1 + sx, xs).map((v) => line([v, y0 - sy], [v, y1 + sy], map)), ...marks(y0 - sy, y1 + sy, ys).map((v) => line([x0 - sx, v], [x1 + sx, v], map))];
                        return `${line([0, y0 - sy], [0, y1 + sy], map)}${line([x0 - sx, 0], [x1 + sx, 0], map)}${rows.join("")}`;
                    };
                    refGrid.setAttribute("d", gridPath(baseMap));
                    grid.setAttribute("d", gridPath(item.map));
                }
                axis.setAttribute("d", `${line([x0, ay], [x1, ay], baseMap)}${line([ax, y0], [ax, y1], baseMap)}`);
                const tipAt = (from, to) => {
                    const [p, q] = [baseMap(from), baseMap(to)];
                    const dir = unit([q[0] - p[0], q[1] - p[1]]);
                    return `M${q[0] + dir[0] * 16},${q[1] + dir[1] * 16}L${q[0] - dir[1] * 9},${q[1] + dir[0] * 9}L${q[0] + dir[1] * 9},${q[1] - dir[0] * 9}Z`;
                };
                tips.setAttribute("d", `${tipAt([x0, ay], [x1, ay])}${tipAt([ax, y0], [ax, y1])}`);
                const tick = (p, along) => {
                    const [q, r] = [baseMap(p), baseMap([p[0] + along[0], p[1] + along[1]])];
                    const n = unit([r[1] - q[1], q[0] - r[0]]);
                    return `M${q[0] - n[0] * 8},${q[1] - n[1] * 8}L${q[0] + n[0] * 8},${q[1] + n[1] * 8}`;
                };
                ticks.setAttribute("d", [...marks(x0, x1, xs).map((v) => tick([v, ay], [1, 0])), ...marks(y0, y1, ys).map((v) => tick([ax, v], [0, 1]))].join(""));
                const crossX = y0 < 0 && y1 > 0;
                const crossY = x0 < 0 && x1 > 0;
                numbers.forEach(([axisName, v], i) => {
                    const [x, y] = baseMap(axisName === "x" ? [v, ay] : [ax, v]);
                    const [dx, dy, anchor] = axisName === "x" ? [crossX ? 10 : 0, 42, crossX ? "start" : "middle"] : [-14, crossY ? 24 : 10, "end"];
                    Object.entries({ x: x + dx, y: y + dy, "text-anchor": anchor }).forEach(([key, val]) => texts[i].setAttribute(key, val));
                });
                const [xl, yl] = Array.isArray(d.labels) ? d.labels : [];
                const xe = baseMap([x1, ay]);
                const ye = baseMap([ax, y1]);
                label(item, "x", xl, [xe[0] + 24, xe[1]], "translate(0, -50%)");
                label(item, "y", yl, [ye[0] + 18, ye[1] - 8], "translate(0, -50%)");
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
                if (last) label(item, "label", item.def.label, [last[0] + 14, last[1] - 30], "translate(0, -50%)");
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
                const parent = items.get(item.def.on);
                const axes = axesOf(item);
                const mx = parent?.fn ? value(item.def.x) : isPair(item.def.at) ? value(item.def.at[0]) : 0;
                const xy = parent?.fn ? axes.map([mx, parent.fn(mx)]) : pointOf(item, item.def.at);
                item.circle.setAttribute("cx", xy[0]);
                item.circle.setAttribute("cy", xy[1]);
                const plot = parent?.fn ? parent : axes && [...items.values()].find((o) => o.def.type === "plot" && axesOf(o) === axes && o.fn);
                let spot = [xy[0] + 18, xy[1] - 18];
                let anchor = "translate(0, -100%)";
                if (axes && plot?.fn) {
                    const dx = (axes.range.x1 - axes.range.x0) * 0.08;
                    const [yL, yR] = [axes.map([mx - dx, plot.fn(mx - dx)])[1], axes.map([mx + dx, plot.fn(mx + dx)])[1]];
                    if (yL < xy[1] - 4 && yR < xy[1] - 4) {
                        spot = [xy[0], xy[1] + 24];
                        anchor = "translate(-50%, 0)";
                    } else if (yR < xy[1] - 6 && yL >= xy[1] - 2) {
                        const shortLabel = String(item.def.label ?? "").length <= 5;
                        spot = shortLabel ? [xy[0] - 18, xy[1] - 16] : [xy[0] + 18, xy[1] + 10];
                        anchor = shortLabel ? "translate(-100%, -100%)" : "translate(0, 0)";
                    }
                }
                label(item, "label", item.def.label, spot, anchor);
                if (item.labels?.label) {
                    const crowded = [...items.values()].some((other) => {
                        if (other === item || !other.shown || other.leaving || other.def.type !== "dot" || !other.labels?.label || (other.order ?? 0) >= (item.order ?? Infinity)) return false;
                        return Math.hypot(Number(other.circle.getAttribute("cx")) - xy[0], Number(other.circle.getAttribute("cy")) - xy[1]) < 42;
                    });
                    if (crowded) item.labels.label.dataset.held = "1";
                    else delete item.labels.label.dataset.held;
                }
            };
        },
        tangent(item) {
            item.path = stroke(item, "path");
            item.circle = solid(item, "circle", { r: 5 });
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

    const itemOf = (def, color, width, opacity = 1) => ({
        def, g: svgNode("g", { color, "data-board-id": def.id, "data-board-type": def.type, "data-board-from": typeof def.from === "string" ? def.from.split(".")[0] : undefined, "data-board-to": typeof def.to === "string" ? def.to.split(".")[0] : undefined, "data-board-on": def.on }, svg),
        nodes: [], offset: [0, 0], nudge: [0, 0], push: [0, 0], pulse: 1, opacity, shown: false, color, width,
    });
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
            } else if (["box", "circle"].includes(def.type)) {
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
            const np = item.def.type === "dot" ? 1 : p;
            Object.assign(node.style, { opacity: item.opacity, visibility: node.dataset.held ? "hidden" : hidden });
            node.style.transform = `translate(${ox + nx}px, ${oy + ny}px) ${node.dataset.anchor ?? "translate(-50%, -50%)"} scale(${np})`;
        }
    };

    // Keeps written elements and labels apart: each steps aside from those written before it, and glides there.
    const declutter = () => {
        const entries = [];
        const taken = [];
        const edgeObstacles = [];
        for (const item of items.values()) {
            if (!item.shown || item.leaving || item.opacity <= 0.05) continue;
            if (item.def.type === "dot") {
                const [ox, oy] = shift(item);
                const b = item.circle.getBBox();
                if (b.width) taken.push({ x: b.x + ox - 4, y: b.y + oy - 4, w: b.width + 8, h: b.height + 8 });
            } else if (item.def.type === "axes") {
                const [ox, oy] = shift(item);
                for (const t of item.g.querySelectorAll("text")) {
                    const b = t.getBBox();
                    if (b.width) taken.push({ x: b.x + ox - 2, y: b.y + oy - 2, w: b.width + 4, h: b.height + 4 });
                }
                if (item.range && item.baseMap) {
                    const { x0, x1, y0, y1 } = item.range;
                    const [ax, ay] = [x0 <= 0 && x1 >= 0 ? 0 : x0, y0 <= 0 && y1 >= 0 ? 0 : y0];
                    const [lx0, ly] = item.baseMap([x0, ay]);
                    const [lx1] = item.baseMap([x1, ay]);
                    const [vx, vy0] = item.baseMap([ax, y1]);
                    const [, vy1] = item.baseMap([ax, y0]);
                    edgeObstacles.push({
                        owner: item.def.id,
                        ends: [],
                        boxes: [
                            { x: Math.min(lx0, lx1) + ox, y: ly + oy - 4, w: Math.abs(lx1 - lx0), h: 8 },
                            { x: vx + ox - 4, y: Math.min(vy0, vy1) + oy, w: 8, h: Math.abs(vy1 - vy0) },
                        ],
                    });
                }
            } else if (item.def.type === "circle" && !item.node && item.circle) {
                const [ox, oy] = shift(item);
                const [cx, cy, r] = ["cx", "cy", "r"].map((k) => Number(item.circle.getAttribute(k)));
                if (r > 10) {
                    const boxes = Array.from({ length: 24 }, (_, i) => {
                        const a = (i / 24) * Math.PI * 2;
                        return { x: cx + ox + Math.cos(a) * r - 5, y: cy + oy + Math.sin(a) * r - 5, w: 10, h: 10 };
                    });
                    edgeObstacles.push({ owner: item.def.id, ends: [], boxes });
                }
            } else if (["line", "arrow", "vector", "tangent", "plot"].includes(item.def.type) && item.path) {
                const pts = linkPoints(item);
                if (pts.length >= 2) {
                    const [p0, p1] = [pts[0], pts.at(-1)];
                    if (item.def.type !== "plot" && (Math.abs(p1[0] - p0[0]) < 8 || Math.abs(p1[1] - p0[1]) < 8)) {
                        const [x0, x1] = [Math.min(p0[0], p1[0]), Math.max(p0[0], p1[0])];
                        const [y0, y1] = [Math.min(p0[1], p1[1]), Math.max(p0[1], p1[1])];
                        edgeObstacles.push({ owner: item.def.id, from: item.def.from, to: item.def.to, ends: [p0, p1], boxes: [{ x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 }] });
                    } else {
                        const step = Math.max(1, Math.floor(pts.length / (item.def.type === "plot" ? 18 : 6)));
                        const sampled = pts.filter((_, idx) => idx > 0 && idx < pts.length - 1 && idx % step === 0);
                        edgeObstacles.push({ owner: item.def.id, from: item.def.from, to: item.def.to, ends: [p0, p1], boxes: sampled.map(([x, y]) => ({ x: x - 5, y: y - 5, w: 10, h: 10 })) });
                    }
                }
            }
            if (MOVABLE.has(item.def.type) || (item.def.type === "circle" && item.node)) entries.push({ item, holder: item, box: () => boxOf(item.def.id) });
            for (const node of Object.values(item.labels ?? {})) entries.push({ item, holder: node, box: () => rectOf([node]) });
        }
        let moving = false;
        let frameMoved = false;
        for (const { item, holder, box: measure } of entries.sort((a, b) => a.item.order - b.item.order)) {
            const box = measure();
            if (!box || !Number.isFinite(box.x)) continue;
            holder.nudge ??= [0, 0];
            const isFrame = holder === item && ["box", "circle"].includes(item.def.type);
            const rawHome = { ...box, id: holder === item ? item.def.id : undefined, x: box.x - holder.nudge[0], y: box.y - holder.nudge[1], frame: isFrame };
            const pulsing = holder.placed && Math.abs(item.pulse - 1) > 1e-3;
            const home = { ...rawHome, id: rawHome.id, frame: isFrame };
            const linked = isFrame ? connections.get(item.def.id) : null;
            const insideHome = ([px1, py1]) => px1 >= home.x - 6 && px1 <= home.x + home.w + 6 && py1 >= home.y - 6 && py1 <= home.y + home.h + 6;
            const onAxesOrCircle = Boolean(item.def.on) || [...items.values()].some((o) => o.def.type === "circle" && !o.node && o.shown);
            const checkEdges = !isFrame && ((holder === item && (!item.def.on || !["line", "arrow"].some((t) => kinds.has(t)) || onAxesOrCircle)) || item.def.type === "dot" || Boolean(item.def.on));
            const extra = !checkEdges ? [] : edgeObstacles.filter((e) => e.owner !== item.def.id && ![e.from, e.to].includes(item.def.id) && (item.def.type === "dot" || Boolean(item.def.on) || !e.ends.some(insideHome))).flatMap((e) => e.boxes);
            const allObstacles = extra.length ? [...taken, ...extra] : taken;
            // A morphing or pulsing equation keeps its place until its animation has landed.
            if ((!item.settle && !pulsing) || !holder.push) {
                holder.push = linked?.size ? clearNodeSpot(home, taken, linked, W, H) : clearSpot(home, allObstacles, W, H);
            }
            taken.push({ ...home, x: home.x + holder.push[0], y: home.y + holder.push[1] });
            const k = holder.placed ? 0.25 : 1;
            holder.placed = true;
            const next = holder.nudge.map((v, i) => (Math.abs(holder.push[i] - v) < 0.5 ? holder.push[i] : v + (holder.push[i] - v) * k));
            if (next[0] === holder.nudge[0] && next[1] === holder.nudge[1]) continue;
            holder.nudge = next;
            if (isFrame) frameMoved = true;
            place(item);
            moving ||= next[0] !== holder.push[0] || next[1] !== holder.push[1];
        }
        return { moving, frameMoved };
    };

    // Writes an element in: strokes draw, fills fade up, glyphs and words appear in turn and dots pop.
    function show(item, duration, delay) {
        if (item.shown && !item.leaving) return;
        item.leaving = false;
        item.order ??= ++revealed;
        item.opacity = num(item.def.opacity, 1);
        const lines = [...item.g.querySelectorAll("[pathLength]")];
        const fades = [...item.g.querySelectorAll(".fade, [data-fill]")];
        const leaves = item.nodes.flatMap(leavesOf);
        const pop = item.def.type === "dot";
        const set = (k) => {
            if (item.leaving) return;
            item.shown = true;
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
        if (delay <= 0) set(0);
        tween(duration * (leaves.length > 12 ? 1.25 : 1), delay, set);
    }

    function stopFlowsOn(id, duration = 0.3) {
        for (const [fid, f] of flows) if (f.targetId === id) stopFlow(fid, duration);
    }

    function hide(item, part, duration, delay) {
        if (part) return fadeNodes(partNodes(item, part), 0, duration, delay);
        stopFlowsOn(item.def.id, duration);
        for (const sid of surrounds) {
            const s = items.get(sid);
            if (s && s.targetId === item.def.id) hide(s, undefined, duration, delay);
        }
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
        if (to === NAMED.red && ["line", "arrow"].includes(item.def.type) && !item.def.on) {
            stopFlowsOn(item.def.id, duration);
            item.path?.setAttribute("stroke-dasharray", "14 11");
        } else if (item.path && !item.def.dashed) {
            item.path.removeAttribute("stroke-dasharray");
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
        const swell = ["tex", "text", "dot"].includes(item.def.type) ? 0.14 : ["box", "circle"].includes(item.def.type) ? 0.06 : 0;
        const box = swell ? boxOf(item.def.id) : null;
        item.pivot = box ? centre(box).map((v, i) => v - shift(item)[i]) : [0, 0];
        tween(duration, delay, (k) => {
            const s = Math.sin(Math.PI * k);
            item.pulse = 1 + swell * s;
            item.g.setAttribute("color", k < 1 ? mix(item.color, flash, s * 0.85) : item.color);
            item.g.style.filter = !swell && k < 1 ? `drop-shadow(0 0 ${(s * 8).toFixed(1)}px ${flash})` : "";
            for (const node of item.nodes) node.style.color = k < 1 ? mix(item.textColor ?? item.color, flash, s * 0.85) : (item.textColor ?? item.color);
        });
    }

    function surround(action, target, duration, delay) {
        if (!boxOf(target)) return;
        for (const sid of [...surrounds]) {
            const prev = items.get(sid);
            if (prev && prev.shown && !prev.leaving) hide(prev, undefined, 0.4, delay);
        }
        const id = typeof action.id === "string" ? action.id : `surround-${++made}`;
        const def = { id, type: "surround", color: action.color ?? "yellow" };
        const item = itemOf(def, paint(def.color, NAMED.yellow), 4);
        item.targetId = String(target).split(".")[0];
        const rect = stroke(item, "rect", { rx: 10 });
        item.attached = true;
        item.draw = () => {
            const owner = items.get(item.targetId);
            const box = owner && owner.shown && !owner.leaving ? boxOf(target) : null;
            if (!box) {
                if (item.shown && !item.leaving) hide(item, undefined, 0.2, 0);
                return;
            }
            for (const [k, v] of Object.entries({ x: box.x - 14, y: box.y - 10, width: box.w + 28, height: box.h + 20 })) rect.setAttribute(k, v);
        };
        item.draw();
        items.set(id, item);
        surrounds.add(id);
        show(item, duration, delay);
    }

    function move(item, action, duration, delay) {
        if (item.def.type === "vector" && isPair(action.to)) {
            let startVec = null;
            let endVec = null;
            return tween(duration, delay, (k) => {
                if (!startVec) {
                    const cur = item.vecTo ?? item.def.to ?? item.def.at ?? [0, 0];
                    startVec = [value(cur[0]), value(cur[1])];
                    endVec = [value(action.to[0]), value(action.to[1])];
                }
                const e = smooth(k);
                item.vecTo = [lerp(startVec[0], endVec[0], e), lerp(startVec[1], endVec[1], e)];
            });
        }
        let from = null;
        let to = null;
        tween(duration, delay, (k) => {
            if (!from) {
                from = [...item.offset];
                const axes = axesOf(item);
                const [sx, sy] = axes ? axes.scale : [UNIT, UNIT];
                if (isPair(action.by)) to = [from[0] + value(action.by[0]) * sx, from[1] - value(action.by[1]) * sy];
                else {
                    const box = boxOf(item.def.id);
                    const [cx, cy] = box ? centre({ ...box, x: box.x - item.nudge[0], y: box.y - item.nudge[1] }) : [W / 2, H / 2];
                    const [tx, ty] = pointOf(item, action.to);
                    to = [from[0] + tx - cx, from[1] + ty - cy];
                }
            }
            item.offset = [lerp(from[0], to[0], smooth(k)), lerp(from[1], to[1], smooth(k))];
        });
    }

    // Like TransformMatchingTex: matching parts and symbols glide as ghosts, keeping KaTeX's layout intact.
    function morph(item, source, duration, delay) {
        item.settle?.();
        const old = item.node;
        const fresh = element("div", old.className, layer);
        fresh.dataset.boardId = item.def.id;
        const baseSize = ["box", "circle"].includes(item.def.type) ? 0.48 : 0.6;
        Object.assign(fresh.style, { left: old.style.left, top: old.style.top, color: old.style.color, fontSize: `${texSize(item, source, num(item.def.size, baseSize)) * UNIT}px` });
        if (old.dataset.anchor !== undefined) fresh.dataset.anchor = old.dataset.anchor;
        setTex(fresh, source);
        fitWidth(item, fresh);
        watchText(item, fresh);
        item.nodes.splice(item.nodes.indexOf(old), 1, fresh);
        item.node = fresh;
        place(item);
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
                if (g.leave) g.node.style.opacity = 1 - clamp01(k / 0.35);
                else if (g.enter) g.node.style.opacity = clamp01((k - 0.35) / 0.65);
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
        if (item.def.type === "tex" || (["box", "circle"].includes(item.def.type) && typeof item.def.tex === "string")) {
            morph(item, to, duration, delay);
            if (item.rect) sizeBox(item);
            if (item.def.type === "circle") sizeCircle(item);
            return;
        }
        if (item.node && ["text", "box", "circle"].includes(item.def.type)) {
            item.settle?.();
            const old = item.node;
            const fresh = textNode(item, to, false, num(item.def.size, ["box", "circle"].includes(item.def.type) ? 0.42 : 0.44));
            Object.assign(fresh.style, { left: old.style.left, top: old.style.top, color: old.style.color });
            if (old.dataset.anchor !== undefined) fresh.dataset.anchor = old.dataset.anchor;
            item.nodes.splice(item.nodes.indexOf(inputNodeOf(item, old)), 1);
            item.node = fresh;
            place(item);
            if (item.rect) sizeBox(item);
            if (item.def.type === "circle") sizeCircle(item);
            if (!item.shown || (duration <= 0 && delay <= 0)) return old.remove();
            fresh.dataset.held = "1";
            const leaves = leavesOf(fresh);
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                old.remove();
                delete fresh.dataset.held;
                for (const leaf of leaves) leaf.style.opacity = "";
                if (item.settle === finish) item.settle = null;
            };
            item.settle = finish;
            tween(duration, delay, (k) => {
                if (done) return;
                if (k < 0.35) {
                    old.style.opacity = item.opacity * (1 - k / 0.35);
                } else {
                    old.style.visibility = "hidden";
                    delete fresh.dataset.held;
                    const u = (k - 0.35) / 0.65;
                    leaves.forEach((leaf, i) => (leaf.style.opacity = k < 1 ? clamp01((u * (leaves.length + 3) - i) / 3.5) : ""));
                }
            }, finish);
            return;
        }
        if (["arrow", "line", "vector", "dot", "tangent", "brace"].includes(item.def.type)) {
            item.def.label = to;
            item.draw?.();
            return;
        }
        if (["plot", "area"].includes(item.def.type)) {
            const after = (x) => value(to, x);
            let before = null;
            tween(duration, delay, (k) => {
                before ??= fnOf(item);
                const e = smooth(k);
                item.fn = k < 1 ? (x) => lerp(before(x), after(x), e) : after;
            });
        }
    }

    const inputNodeOf = (item, node) => {
        const idx = item.nodes.indexOf(node);
        return idx >= 0 ? node : item.nodes[0];
    };

    function flow(action, delay) {
        const id = typeof action.id === "string" ? action.id : `flow-${++made}`;
        stopFlow(id, 0);
        const targetId = String(action.target ?? "").split(".")[0];
        const target = items.get(targetId);
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
        flows.set(id, { group, dots, at, start: now + delay, speed: num(action.speed, 0.35), targetId });
        tween(0.4, delay, (k) => group.setAttribute("opacity", k));
    }

    function stopFlow(id, duration) {
        const f = flows.get(id);
        if (!f) return;
        flows.delete(id);
        tween(duration, 0, (k) => f.group.setAttribute("opacity", 1 - k), () => f.group.remove());
    }

    function aim(action, duration, delay) {
        autoFrame = false;
        framing = false;
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
        let from = null;
        tween(duration, delay, (k) => {
            from ??= { ...camera };
            const e = smooth(k);
            Object.assign(camera, { x: lerp(from.x, to[0], e), y: lerp(from.y, to[1], e), z: lerp(from.z, z, e) });
        });
    }

    function act(action, instant) {
        const duration = instant ? 0 : Math.min(10, Math.max(0.05, num(action.duration, TIME[action.do] ?? 1)));
        const delay = instant ? 0 : Math.min(10, Math.max(0, num(action.delay, 0)));
        if (action.do === "set") {
            const to = action.vars ?? {};
            let from = null;
            return tween(duration, delay, (k) => {
                from ??= { ...vars };
                for (const name of Object.keys(to)) if (Number.isFinite(to[name])) vars[name] = lerp(from[name] ?? 0, to[name], smooth(k));
            });
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
                const raw = clamp01(num(action.value, 1));
                const toVal = raw > 0 && ["tex", "text", "box", "circle"].includes(item.def.type) ? Math.max(0.48, raw) : raw;
                if (raw < 0.5) stopFlowsOn(id, duration);
                if (part) fadeNodes(partNodes(item, part), toVal, duration, delay);
                else {
                    let from = null;
                    tween(duration, delay, (k) => {
                        from ??= item.opacity;
                        item.opacity = lerp(from, toVal, smooth(k));
                    });
                }
            } else if (action.do === "transform") transform(item, action, duration, delay);
            else if (action.do === "apply" && item.map) {
                const raw = action.matrix.flat();
                let from = null;
                let to = null;
                tween(duration, delay, (k) => {
                    if (!from) {
                        from = [...item.matrix];
                        const [a0, b0, c0, d0] = from;
                        const [a1, b1, c1, d1] = raw;
                        const det0 = a0 * d0 - b0 * c0;
                        const det1 = a1 * d1 - b1 * c1;
                        to = Math.abs(det0) > 1.05 && Math.abs(det1 + 1) < 1e-3 ? [a1 * a0 + b1 * c0, a1 * b0 + b1 * d0, c1 * a0 + d1 * c0, c1 * b0 + d1 * d0] : raw;
                    }
                    item.matrix = from.map((v, i) => lerp(v, to[i], smooth(k)));
                });
            }
        }
    }

    // Axes and plots first so elements on them can find them; then unhidden elements write in briskly so the opening view is complete.
    const rank = { axes: 0, plot: 1 };
    const listed = (spec.elements ?? []).map((def, index) => [def, index]);
    for (const [def, index] of [...listed].sort((a, b) => (rank[a[0].type] ?? 2) - (rank[b[0].type] ?? 2) || a[1] - b[1])) add(def, index);
    listed.filter(([def]) => !def.hidden).forEach(([def], i) => show(items.get(def.id), 0.55, Math.min(0.6, i * 0.03)));

    const bounds = () => {
        let box = null;
        for (const [id, item] of items) {
            if (autoFrame && (item.def.type === "surround" || !item.shown || item.leaving || item.opacity <= 0.05)) continue;
            box = union(box, boxOf(id));
        }
        if (!box) for (const id of items.keys()) box = union(box, boxOf(id));
        if (!box || !Number.isFinite(box.x) || box.w < 1 || box.h < 1) return { x: 0, y: 0, w: W, h: H };
        const x0 = Math.max(0, box.x - 56);
        const y0 = Math.max(0, box.y - 44);
        const x1 = Math.min(W, box.x + box.w + 56);
        const y1 = Math.min(H, box.y + box.h + 52);
        return { x: x0, y: y0, w: Math.max(480, x1 - x0), h: Math.max(280, y1 - y0) };
    };

    return {
        bounds,
        status: () => ({ index: played, settled: !tweens.length && settle <= 0 && !easing }),
        step(index) {
            if (!Number.isInteger(index) || index <= played || index >= steps.length) return;
            now = performance.now() / 1000;
            for (let i = played + 1; i <= index; i++) {
                const list = Array.isArray(steps[i]) ? steps[i] : [];
                if (list.some((a) => a?.do === "flow")) {
                    for (const fid of [...flows.keys()]) stopFlow(fid, i < index ? 0 : 0.3);
                }
                for (const action of list) act(action ?? {}, i < index);
            }
            played = index;
            settle = 2;
            this.frame(now);
        },
        addSteps(more) {
            steps.push(...more);
            for (const action of more.flat()) if (action?.do === "set") for (const [name, v] of Object.entries(action.vars ?? {})) if (!Number.isInteger(v)) whole.delete(name);
        },
        frame(t) {
            now = t;
            const busy = tweens.length || flows.size || settle > 0 || easing || framing;
            for (const tw of [...tweens]) {
                if (now < tw.start) continue;
                const k = Math.min(1, (now - tw.start) / tw.duration);
                tw.update(k);
                if (k >= 1) {
                    tweens.splice(tweens.indexOf(tw), 1);
                    tw.done?.();
                }
            }
            if (!busy) return false;
            settle = tweens.length ? 2 : settle - 1;
            framing = false;
            for (const item of items.values()) {
                if (!item.attached) item.draw?.();
                refreshText(item);
                follow(item);
                place(item);
            }
            for (const item of items.values()) {
                if (item.attached) {
                    item.draw?.();
                    place(item);
                }
            }
            const { moving, frameMoved } = declutter();
            easing = moving;
            if (frameMoved) {
                for (const item of items.values()) {
                    if (item.attached) {
                        item.draw?.();
                        place(item);
                    }
                }
            }
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
            return true;
        },
        dispose() {
            tweens.length = 0;
            flows.clear();
            surrounds.clear();
            textResize.disconnect();
            world.replaceChildren();
        },
    };
}

// spec: { elements, vars, steps, autoplay, stepSeconds, loop }; returns { step(index), setInset(px), dispose() }.
export async function renderBoard(spec, { root }) {
    const katex = await loadKatex();
    let inset = spec.autoplay === false ? 116 : 0;
    let envelope = null;
    let refitPreview = false;
    let board = null;
    const stage = element("div", "board", root);
    const world = element("div", "board-world", stage);
    const fit = () => {
        const w = root.clientWidth || innerWidth;
        const h = Math.max(1, (root.clientHeight || innerHeight) - inset);
        const b = envelope ?? { x: 0, y: 0, w: W, h: H };
        const k = Math.min(w / b.w, h / b.h, (w / W) * 1.45);
        const tx = (w - b.w * k) / 2 - b.x * k;
        const ty = (h - b.h * k) / 2 - b.y * k;
        world.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${k.toFixed(4)})`;
    };
    const updateEnvelope = () => {
        const next = union(envelope, board.bounds());
        if (!envelope || next.x < envelope.x - 1 || next.y < envelope.y - 1 || next.w > envelope.w + 2 || next.h > envelope.h + 2) {
            envelope = next;
            fit();
        }
    };
    fit();
    board = build(spec, world, katex);
    board.frame(performance.now() / 1000);
    updateEnvelope();
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
                envelope = null;
                board = build(spec, world, katex);
                board.frame(performance.now() / 1000);
                updateEnvelope();
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
    let pump = 0;
    const loop = () => {
        cancelAnimationFrame(raf);
        clearTimeout(pump);
        const changed = board.frame(performance.now() / 1000);
        const status = refitPreview && board.status();
        // Forget the preview's temporary bounds once its first narrated view has settled.
        if (status && status.index >= 0 && status.settled) {
            envelope = null;
            refitPreview = false;
        }
        if (changed || !envelope) updateEnvelope();
        raf = requestAnimationFrame(loop);
        if (changed) pump = setTimeout(loop, 36);
    };
    loop();
    const resize = new ResizeObserver(fit);
    resize.observe(root);
    return {
        step(index) {
            board.step(index);
            loop();
        },
        status: () => board.status(),
        // Replay and step-back rebuild to that step, because a board only plays forward.
        goto(index) {
            board.dispose();
            board = build(spec, world, katex);
            if (Number.isInteger(index) && index >= 0) board.step(index);
            loop();
        },
        addSteps(more) {
            refitPreview ||= !steps.length && board.status().index < 0 && more.length > 0;
            board.addSteps(more);
            loop();
        },
        setInset(px) {
            const h = root.clientHeight || innerHeight;
            const next = Math.max(inset, Math.min(Math.round(num(px, 0)), h * 0.55));
            if (next === inset) return;
            inset = next;
            fit();
        },
        dispose() {
            cancelAnimationFrame(raf);
            clearTimeout(pump);
            clearTimeout(timer);
            resize.disconnect();
            board.dispose();
            stage.remove();
        },
    };
}
