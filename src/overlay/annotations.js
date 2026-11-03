// Ink Brain's drawings: self-drawing sketches, handwriting, callouts, diagrams, a lens and a pointer.
import rough from "/vendor/rough/rough.esm.js";

const NS = "http://www.w3.org/2000/svg";
const ACCENT = "#a371f7";
const HAND = '"Noteworthy", "Marker Felt", "Chalkboard SE", "Bradley Hand", cursive';
const BOX_KINDS = new Set(["circle", "rect", "highlight", "underline", "spotlight", "brace", "lens"]);
const FRAMED_KINDS = new Set(["arrow", "callout", "marker"]);
const OWN_TEXT_KINDS = new Set(["label", "marker", "pointer", "write", "board", "brace", "callout", "diagram", "lens"]);
const DEFAULT_COLORS = { check: "#3fb950", cross: "#ff7b72", write: "#f0f6fc" };
const generator = rough.generator();
const measure = document.createElement("canvas").getContext("2d");

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const safeColor = (value, fallback = ACCENT) => (typeof value === "string" && CSS.supports("color", value) ? value : fallback);
const centre = (s) => [s.x + s.w / 2, s.y + s.h / 2];
// Where a number badge sits on the corner of a control's outline: top left unless told otherwise.
const badgeSpot = (box, corner = "tl") => [corner.endsWith("r") ? box.x + box.w + 2 : box.x - 2, corner.startsWith("b") ? box.y + box.h + 2 : box.y - 2];

function svg(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
}

function div(className, text) {
    const el = document.createElement("div");
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function place(el, x, y, delay) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.animationDelay = `${delay}s`;
    el.style.setProperty("--delay", `${delay}s`);
    return el;
}

function seedOf(text) {
    let hash = 2166136261;
    for (const ch of String(text)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    return ((hash >>> 0) % 2147483646) + 1;
}

// Catmull-Rom spline through the points, as a cubic Bezier path.
function smoothPath(points) {
    const f = (n) => n.toFixed(1);
    if (points.length < 3) return `M${points.map(([x, y]) => `${f(x)},${f(y)}`).join(" L")}`;
    let d = `M${f(points[0][0])},${f(points[0][1])}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] ?? points[i];
        const [p1, p2] = [points[i], points[i + 1]];
        const p3 = points[i + 2] ?? p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
    }
    return d;
}

// A hand-drawn loop around an ellipse that slightly overshoots where it started.
function sketchEllipse(cx, cy, rx, ry, seed) {
    const points = [];
    const start = -Math.PI * 0.62 + seed;
    for (let i = 0; i <= 64; i++) {
        const t = start + (Math.PI * 2.16 * i) / 64;
        const wobble = 1 + 0.03 * Math.sin(t * 3 + seed * 5) + 0.015 * Math.sin(t * 7 + seed);
        const drift = 1 + 0.07 * (i / 64);
        points.push([cx + Math.cos(t) * rx * wobble * drift, cy + Math.sin(t) * ry * wobble * drift]);
    }
    return smoothPath(points);
}

// Points along a quadratic curve from a to b that bows sideways by bend times its length.
function bowed(a, b, bend, steps = 10) {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const control = [(a[0] + b[0]) / 2 - dy * bend, (a[1] + b[1]) / 2 + dx * bend];
    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        const u = 1 - t;
        return [u * u * a[0] + 2 * u * t * control[0] + t * t * b[0], u * u * a[1] + 2 * u * t * control[1] + t * t * b[1]];
    });
}

function wrapText(text, size, maxWidth) {
    measure.font = `bold ${size}px ${HAND}`;
    const lines = [];
    for (const paragraph of String(text).split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            const next = line ? `${line} ${word}` : word;
            if (line && measure.measureText(next).width > maxWidth) {
                lines.push(line);
                line = word;
            } else line = next;
        }
        lines.push(line);
    }
    const width = Math.max(...lines.map((line) => measure.measureText(line).width), 1);
    return { lines, width, height: lines.length * size * 1.25 };
}

// Where the line from a node's centre towards (tx, ty) leaves the node's outline.
function edgePoint(node, tx, ty, gap = 7) {
    const [dx, dy] = [tx - node.cx, ty - node.cy];
    const rx = node.w / 2 + gap;
    const ry = node.h / 2 + gap;
    let t;
    if (node.shape === "ellipse") t = 1 / Math.hypot(dx / rx, dy / ry);
    else if (node.shape === "diamond") t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
    else t = Math.min(rx / Math.abs(dx || 1e-6), ry / Math.abs(dy || 1e-6));
    return [node.cx + dx * Math.min(t, 1), node.cy + dy * Math.min(t, 1)];
}

function keepOnScreen(el) {
    const rect = el.getBoundingClientRect();
    const dx = Math.max(8 - rect.left, 0) - Math.max(rect.right - (innerWidth - 8), 0);
    const dy = Math.max(8 - rect.top, 0) - Math.max(rect.bottom - (innerHeight - 8), 0);
    if (dx) el.style.left = `${parseFloat(el.style.left) + dx}px`;
    if (dy) el.style.top = `${parseFloat(el.style.top) + dy}px`;
}

// The screen box covered by some drawn nodes.
function boxOf(nodes) {
    let box = null;
    for (const node of nodes) {
        const r = node.getBoundingClientRect?.();
        if (!r || r.width < 1 || r.height < 1) continue;
        const x = Math.min(box?.x ?? r.left, r.left);
        const y = Math.min(box?.y ?? r.top, r.top);
        box = { x, y, w: Math.max(box ? box.x + box.w : r.right, r.right) - x, h: Math.max(box ? box.y + box.h : r.bottom, r.bottom) - y };
    }
    return box;
}

export class Annotations {
    #items = new Map();
    #pages = new Map();
    #page = null;
    #count = 0;
    #markers = 0;
    #pointerKey = null;
    #pointerTimers = [];

    constructor({ svgRoot, labels, boards, pointer, ripples }) {
        this.roots = { svg: svgRoot, labels, boards };
        this.pointer = pointer;
        this.ripples = ripples;
        this.defs = svg("defs");
        svgRoot.append(this.defs);
    }

    // Drawings go into one layer per page, so a page's drawings hide and move together.
    get svg() {
        return this.#layer("svg");
    }

    get labels() {
        return this.#layer("labels");
    }

    get boards() {
        return this.#layer("boards");
    }

    // Draws shapes in sequence; returns the drawing time (ms) and the box it covers.
    draw(shapes, { clear = true, ttl = 45, group = null, page = null } = {}) {
        if (clear) this.clear(undefined, undefined, { page });
        let t = 0;
        let end = 0;
        const added = [];
        this.#page = page;
        try {
            for (const shape of shapes) {
                const key = shape.id || `a${++this.#count}`;
                const before = this.#items.get(key)?.diagram;
                this.#remove(key);
                const { nodes, duration, diagram } = this.#render(shape, t, key, before);
                const item = { nodes, group, page, diagram, timer: null, remaining: ttl > 0 ? ttl * 1000 : null };
                this.#items.set(key, item);
                this.#arm(key, item);
                added.push(...nodes);
                end = Math.max(end, t + duration);
                t += clamp(duration * 0.45, 0.15, 0.6);
            }
        } finally {
            this.#page = null;
        }
        return { duration: Math.round(end * 1000), box: boxOf(added.filter((node) => node !== this.pointer)) };
    }

    // Clears by id, by group, by page, or only what is on screen now.
    clear(id, group, { page, visibleOnly = false } = {}) {
        if (id) return this.#remove(id);
        for (const [key, item] of [...this.#items]) {
            if (group && item.group !== group) continue;
            if (page !== undefined && item.page !== page) continue;
            if (visibleOnly && item.page && !this.#pages.get(item.page)?.visible) continue;
            this.#remove(key);
        }
        if (!group && page === undefined && !visibleOnly) this.#markers = 0;
    }

    // Lets a group of drawings (for example one explanation) fade out after a while.
    expire(group, seconds) {
        for (const [key, item] of this.#items) {
            if (item.group !== group) continue;
            item.remaining = seconds * 1000;
            this.#arm(key, item);
        }
    }

    // Shows each page's drawings only while that page is on screen, moved along with its window.
    showPages(states) {
        for (const [key, page] of this.#pages) {
            const state = states.get(key);
            if (!state) continue;
            const changed = page.visible !== state.visible;
            Object.assign(page, state);
            this.#style(page);
            if (!changed) continue;
            for (const [itemKey, item] of this.#items) {
                if (item.page !== key) continue;
                if (state.visible) this.#arm(itemKey, item);
                else this.#pause(item);
            }
        }
    }

    pageKeys() {
        return new Set([...this.#items.values()].map((item) => item.page).filter(Boolean));
    }

    // Boxes of the drawings on show for the answer to avoid; screen-wide effects are left out.
    rects() {
        const boxes = [];
        for (const item of this.#items.values()) {
            if (item.page && this.#pages.get(item.page)?.visible === false) continue;
            const box = boxOf(item.nodes.filter((node) => node !== this.pointer));
            if (box && box.w * box.h < innerWidth * innerHeight * 0.4) boxes.push(box);
        }
        return boxes;
    }

    ripple(x, y) {
        const el = place(div("ripple"), x, y, 0);
        this.ripples.append(el);
        setTimeout(() => el.remove(), 900);
    }

    #layer(name) {
        if (!this.#page) return this.roots[name];
        let page = this.#pages.get(this.#page);
        if (!page) this.#pages.set(this.#page, (page = { layers: {}, visible: true, dx: 0, dy: 0 }));
        if (!page.layers[name]) {
            page.layers[name] = name === "svg" ? svg("g", { class: "page-layer" }) : div("page-layer");
            this.roots[name].append(page.layers[name]);
            this.#style(page);
        }
        return page.layers[name];
    }

    #style(page) {
        for (const [name, layer] of Object.entries(page.layers)) {
            layer.classList.toggle("away", !page.visible);
            if (name === "svg") layer.setAttribute("transform", `translate(${page.dx} ${page.dy})`);
            else layer.style.transform = `translate(${page.dx}px, ${page.dy}px)`;
        }
    }

    // Fading only counts down while the drawing's page is on screen.
    #arm(key, item) {
        clearTimeout(item.timer);
        item.timer = null;
        if (item.remaining == null || (item.page && this.#pages.get(item.page)?.visible === false)) return;
        item.due = Date.now() + item.remaining;
        item.timer = setTimeout(() => this.#fade(key), item.remaining);
    }

    #pause(item) {
        if (!item.timer) return;
        clearTimeout(item.timer);
        item.timer = null;
        item.remaining = Math.max(0, item.due - Date.now());
    }

    #fade(key) {
        const item = this.#items.get(key);
        if (!item) return;
        for (const node of item.nodes) node.classList?.add("fading");
        setTimeout(() => this.#remove(key), 650);
    }

    #remove(key) {
        const item = this.#items.get(key);
        if (!item) return;
        clearTimeout(item.timer);
        for (const node of item.nodes) {
            if (node !== this.pointer) node.remove();
            else if (this.#pointerKey === key) node.classList.add("hidden");
        }
        this.#items.delete(key);
        if (item.page && ![...this.#items.values()].some((other) => other.page === item.page)) {
            for (const layer of Object.values(this.#pages.get(item.page)?.layers ?? {})) layer.remove();
            this.#pages.delete(item.page);
        }
    }

    // ------------------------------------------------ primitives

    // Appends rough.js paths that draw on; returns the time the strokes take.
    #ink(group, drawable, delay, { dashed = false, speed = 1100 } = {}) {
        let length = 0;
        const strokes = [];
        for (const info of generator.toPaths(drawable)) {
            if (info.fill && info.fill !== "none") {
                const fill = svg("path", { d: info.d, fill: info.fill, stroke: "none", class: "fill-in" });
                fill.style.animationDelay = `${delay}s`;
                group.append(fill);
                continue;
            }
            const halo = svg("path", { d: info.d, class: "halo", "stroke-width": info.strokeWidth + 3 });
            const ink = svg("path", { d: info.d, class: "ink", stroke: info.stroke, "stroke-width": info.strokeWidth });
            group.append(halo, ink);
            strokes.push(halo, ink);
            length = Math.max(length, ink.getTotalLength());
        }
        const duration = clamp(length / speed, 0.3, 1.3);
        for (const path of strokes) {
            if (dashed) {
                path.setAttribute("stroke-dasharray", "9 9");
                path.classList.add("fade-in");
            } else {
                path.classList.add("draw");
                path.style.setProperty("--len", path.getTotalLength().toFixed(1));
                path.style.setProperty("--dur", `${duration}s`);
            }
            path.style.setProperty("--delay", `${delay}s`);
        }
        return duration;
    }

    #inkPathData(group, d, color, delay, width = 2.4) {
        const halo = svg("path", { d, class: "halo draw", "stroke-width": width + 3 });
        const ink = svg("path", { d, class: "ink draw", stroke: color, "stroke-width": width });
        group.append(halo, ink);
        const length = ink.getTotalLength();
        const duration = clamp(length / 1100, 0.35, 1.3);
        for (const path of [halo, ink]) {
            path.style.setProperty("--len", length.toFixed(1));
            path.style.setProperty("--dur", `${duration}s`);
            path.style.setProperty("--delay", `${delay}s`);
        }
        return duration;
    }

    #opts(color, seed, extra = {}) {
        return { seed, stroke: color, strokeWidth: 2.2, roughness: 1.25, bowing: 0.9, preserveVertices: true, ...extra };
    }

    #arrow(group, from, to, color, delay, { bend = 0.15, both = false, dashed = false, seed = 1, head = true } = {}) {
        const points = bowed(from, to, bend);
        let duration = this.#ink(group, generator.curve(points, this.#opts(color, seed, { roughness: 0.9 })), delay, { dashed });
        const heads = head ? [[points.at(-2), to]] : [];
        if (both) heads.push([points[1], from]);
        for (const [prev, tip] of heads) {
            const angle = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
            const wing = (offset) => [tip[0] - 16 * Math.cos(angle + offset), tip[1] - 16 * Math.sin(angle + offset)];
            duration = Math.max(duration, this.#ink(group, generator.linearPath([wing(-0.5), tip, wing(0.5)], this.#opts(color, seed + 1, { roughness: 0.6 })), delay + duration * 0.85) + duration * 0.85);
        }
        return duration;
    }

    #write(text, x, y, { color, size, delay, align = "left", maxWidth = 520, className = "hand" }) {
        const { lines } = wrapText(text, size, maxWidth);
        const el = div(`${className}${align === "center" ? " centered" : ""}`);
        el.style.fontSize = `${size}px`;
        el.style.color = color;
        let lineDelay = delay;
        for (const line of lines) {
            const span = div("hand-line", line);
            const duration = clamp(line.length * 0.035, 0.25, 1.6);
            span.style.animationDelay = `${lineDelay}s`;
            span.style.animationDuration = `${duration}s`;
            el.append(span);
            lineDelay += duration * 0.9;
        }
        this.labels.append(place(el, x, y, 0));
        requestAnimationFrame(() => keepOnScreen(el));
        return { el, duration: lineDelay - delay };
    }

    // ------------------------------------------------ shapes

    #render(shape, delay, key, before = null) {
        const color = safeColor(shape.color, DEFAULT_COLORS[shape.kind] ?? ACCENT);
        const seed = seedOf(key);
        const group = svg("g", { class: "shape" });
        group.style.setProperty("--c", color);
        this.svg.append(group);
        const nodes = [group];
        let duration = 0.4;
        let diagram = null;
        const { kind } = shape;
        // A control a mark was snapped onto gets a tight outline first, then the mark itself.
        const lead = shape.target && FRAMED_KINDS.has(kind) ? this.#frame(group, shape.target, color, delay, seed) * 0.5 : 0;
        delay += lead;

        if (kind === "circle") {
            const pad = clamp(Math.min(shape.w, shape.h) * 0.2, 4, 12);
            duration = this.#inkPathData(group, sketchEllipse(...centre(shape), shape.w / 2 + pad, shape.h / 2 + pad, (seed % 7) * 0.37), color, delay);
        } else if (kind === "rect") {
            const pad = clamp(Math.min(shape.w, shape.h) * 0.2, 3, 7);
            duration = this.#ink(group, generator.rectangle(shape.x - pad, shape.y - pad, shape.w + pad * 2, shape.h + pad * 2, this.#opts(color, seed)), delay);
        } else if (kind === "highlight") {
            const el = place(div("highlight"), shape.x - 4, shape.y - 2, delay);
            Object.assign(el.style, { width: `${shape.w + 8}px`, height: `${shape.h + 4}px` });
            el.style.setProperty("--c", color);
            this.labels.append(el);
            nodes.push(el);
            duration = 0.55;
        } else if (kind === "underline") {
            const y = shape.y + shape.h + clamp(shape.h * 0.3, 2, 5);
            const m = clamp(shape.w * 0.05, 1, 4);
            const points = Array.from({ length: 7 }, (_, i) => [shape.x - m + ((shape.w + m * 2) * i) / 6, y + Math.sin(i * 1.7 + seed) * clamp(shape.h * 0.1, 0.6, 1.6)]);
            duration = this.#ink(group, generator.curve(points, this.#opts(color, seed, { roughness: 0.9, strokeWidth: 2.6 })), delay);
        } else if (kind === "spotlight") {
            const maskId = `mask-${key.replace(/[^\w-]/g, "")}`;
            const mask = svg("mask", { id: maskId });
            mask.append(
                svg("rect", { x: 0, y: 0, width: "100%", height: "100%", fill: "white" }),
                svg("rect", { x: shape.x - 12, y: shape.y - 12, width: shape.w + 24, height: shape.h + 24, rx: 16, fill: "black" }),
            );
            this.defs.append(mask);
            nodes.push(mask);
            const dim = svg("rect", { x: 0, y: 0, width: "100%", height: "100%", mask: `url(#${maskId})`, class: "spotlight" });
            dim.style.animationDelay = `${delay}s`;
            group.append(dim);
            duration = this.#ink(group, generator.rectangle(shape.x - 12, shape.y - 12, shape.w + 24, shape.h + 24, this.#opts(color, seed)), delay + 0.2) + 0.2;
        } else if (kind === "board") {
            const el = place(div("board"), shape.x, shape.y, delay);
            Object.assign(el.style, { width: `${shape.w}px`, height: `${shape.h}px` });
            el.style.setProperty("--c", color);
            this.boards.append(el);
            nodes.push(el);
            if (shape.text) nodes.push(this.#write(shape.text, shape.x + 18, shape.y + 12, { color: "#f0f6fc", size: shape.size ?? 26, delay: delay + 0.25 }).el);
            duration = 0.45;
        } else if (kind === "brace") {
            duration = this.#brace(group, shape, color, delay, seed, nodes);
        } else if (kind === "lens") {
            duration = this.#lens(group, shape, color, delay, seed, nodes);
        } else if (kind === "line") {
            const points = bowed(shape.from, shape.to, Number.isFinite(shape.bend) ? shape.bend : 0, 6);
            duration = this.#ink(group, generator.curve(points, this.#opts(color, seed)), delay, { dashed: shape.style === "dashed" });
        } else if (kind === "arrow") {
            duration = this.#arrow(group, shape.from, shape.to, color, delay, {
                bend: Number.isFinite(shape.bend) ? shape.bend : 0.18,
                both: shape.style === "both",
                dashed: shape.style === "dashed",
                seed,
            });
        } else if (kind === "path") {
            duration = this.#ink(group, generator.curve(shape.points, this.#opts(color, seed, { roughness: 0.8 })), delay, { speed: 900 });
        } else if (kind === "check" || kind === "cross") {
            const s = shape.size ?? 30;
            const { x, y } = shape;
            const drawable =
                kind === "check"
                    ? generator.linearPath([[x - s * 0.5, y], [x - s * 0.12, y + s * 0.42], [x + s * 0.55, y - s * 0.5]], this.#opts(color, seed, { strokeWidth: 4 }))
                    : generator.path(`M${x - s / 2},${y - s / 2} L${x + s / 2},${y + s / 2} M${x + s / 2},${y - s / 2} L${x - s / 2},${y + s / 2}`, this.#opts(color, seed, { strokeWidth: 4 }));
            duration = this.#ink(group, drawable, delay);
        } else if (kind === "pulse") {
            const el = place(div("pulse"), shape.x, shape.y, delay);
            el.style.setProperty("--c", color);
            this.labels.append(el);
            nodes.push(el);
            duration = 0.6;
        } else if (kind === "write") {
            const written = this.#write(shape.text, shape.x, shape.y, { color, size: shape.size ?? 26, delay, align: shape.align, maxWidth: shape.w ?? 520 });
            nodes.push(written.el);
            duration = written.duration;
        } else if (kind === "callout") {
            duration = this.#callout(group, shape, color, delay, seed, nodes);
        } else if (kind === "diagram") {
            ({ duration, diagram } = this.#diagram(group, shape, color, delay, seed, nodes, before));
        } else if (kind === "label") {
            nodes.push(this.#pill(shape.text ?? "", shape.x, shape.y, color, delay));
        } else if (kind === "marker") {
            // Beside a control, the number sits on a corner of the outline so it never hides the control itself.
            const [x, y] = shape.target ? badgeSpot(shape.target, shape.corner) : [shape.x, shape.y];
            const el = place(div("anno-marker", (shape.text || String(++this.#markers)).slice(0, 10)), x, y, delay);
            el.style.setProperty("--c", color);
            this.labels.append(el);
            nodes.push(el);
        } else if (kind === "pointer") {
            this.#pointerKey = key;
            nodes.push(this.#point(shape, delay));
            duration = 0.8 * ((shape.points?.length ?? 0) + 1);
        }

        if (shape.text && !OWN_TEXT_KINDS.has(kind)) {
            nodes.push(this.#caption(shape, color, delay + duration * 0.7));
        }
        return { nodes, duration: duration + lead, diagram };
    }

    // A tight rough outline around the control a mark points at.
    #frame(group, box, color, delay, seed) {
        return this.#ink(group, generator.rectangle(box.x - 3, box.y - 3, box.w + 6, box.h + 6, this.#opts(color, seed + 9, { roughness: 0.4, bowing: 0.3, strokeWidth: 2, disableMultiStroke: true })), delay);
    }

    #pill(text, x, y, color, delay, align = "") {
        const el = place(div(`anno-label ${align}`.trim(), text), x, y, delay);
        el.style.setProperty("--c", color);
        this.labels.append(el);
        requestAnimationFrame(() => keepOnScreen(el));
        return el;
    }

    #caption(shape, color, delay) {
        if (shape.kind === "underline") return this.#pill(shape.text, shape.x + shape.w + 14, shape.y + shape.h + 5, color, delay, "start");
        if (BOX_KINDS.has(shape.kind)) {
            const y = shape.y > 64 ? shape.y - 34 : shape.y + shape.h + 36;
            return this.#pill(shape.text, shape.x + shape.w / 2, y, color, delay);
        }
        if (shape.from) {
            const [x1, y1] = shape.from;
            const [x2, y2] = shape.to;
            const length = Math.hypot(x2 - x1, y2 - y1) || 1;
            return this.#pill(shape.text, x1 - ((x2 - x1) / length) * 22, y1 - ((y2 - y1) / length) * 22, color, delay);
        }
        if (shape.points) return this.#pill(shape.text, shape.points[0][0], shape.points[0][1] - 28, color, delay);
        return this.#pill(shape.text, shape.x, shape.y - 30, color, delay);
    }

    #brace(group, shape, color, delay, seed, nodes) {
        const side = ["left", "right", "top", "bottom"].includes(shape.side) ? shape.side : "right";
        const { x, y, w, h } = shape;
        const depth = 16;
        let d;
        let tip;
        if (side === "left" || side === "right") {
            const sx = side === "left" ? x - 8 : x + w + 8;
            const dir = side === "left" ? -1 : 1;
            const my = y + h / 2;
            tip = [sx + dir * depth * 2, my];
            d = `M${sx},${y} Q${sx + dir * depth},${y} ${sx + dir * depth},${y + depth} L${sx + dir * depth},${my - depth} Q${sx + dir * depth},${my} ${tip[0]},${my} Q${sx + dir * depth},${my} ${sx + dir * depth},${my + depth} L${sx + dir * depth},${y + h - depth} Q${sx + dir * depth},${y + h} ${sx},${y + h}`;
        } else {
            const sy = side === "top" ? y - 8 : y + h + 8;
            const dir = side === "top" ? -1 : 1;
            const mx = x + w / 2;
            tip = [mx, sy + dir * depth * 2];
            d = `M${x},${sy} Q${x},${sy + dir * depth} ${x + depth},${sy + dir * depth} L${mx - depth},${sy + dir * depth} Q${mx},${sy + dir * depth} ${mx},${tip[1]} Q${mx},${sy + dir * depth} ${mx + depth},${sy + dir * depth} L${x + w - depth},${sy + dir * depth} Q${x + w},${sy + dir * depth} ${x + w},${sy}`;
        }
        const duration = this.#ink(group, generator.path(d, this.#opts(color, seed, { roughness: 0.5 })), delay);
        if (shape.text) {
            const size = shape.size ?? 22;
            const offset = { left: [-12, -size * 0.6], right: [12, -size * 0.6], top: [0, -size * 1.6], bottom: [0, 10] }[side];
            const written = this.#write(shape.text, tip[0] + offset[0], tip[1] + offset[1], { color, size, delay: delay + duration * 0.8, align: side === "top" || side === "bottom" ? "center" : "left" });
            if (side === "left") written.el.classList.add("from-right");
            nodes.push(written.el);
        }
        return duration;
    }

    // A round lens beside the region showing it magnified (the main process supplies the pixels).
    #lens(group, shape, color, delay, seed, nodes) {
        const zoom = clamp(shape.zoom ?? 2.2, 1.2, 6);
        const diameter = clamp(Math.max(shape.w, shape.h) * zoom, 140, 380);
        let [cx, cy] = shape.at ?? [];
        if (!Number.isFinite(cx)) {
            const right = shape.x + shape.w + 40 + diameter / 2;
            cx = right + diameter / 2 < innerWidth ? right : shape.x - 40 - diameter / 2;
            cy = clamp(shape.y + shape.h / 2, diameter / 2 + 30, innerHeight - diameter / 2 - 20);
        }
        let duration = this.#ink(group, generator.rectangle(shape.x - 4, shape.y - 4, shape.w + 8, shape.h + 8, this.#opts(color, seed, { roughness: 0.8 })), delay);
        const [sx, sy] = centre(shape);
        const toward = edgePoint({ cx, cy, w: diameter, h: diameter, shape: "ellipse" }, sx, sy, 4);
        const from = edgePoint({ cx: sx, cy: sy, w: shape.w + 8, h: shape.h + 8 }, cx, cy, 2);
        duration += this.#ink(group, generator.line(...from, ...toward, this.#opts(color, seed + 2, { roughness: 0.7 })), delay + duration * 0.7) * 0.6;
        const el = place(div("lens"), cx - diameter / 2, cy - diameter / 2, delay + duration * 0.5);
        Object.assign(el.style, { width: `${diameter}px`, height: `${diameter}px` });
        el.style.setProperty("--c", color);
        if (shape.image) {
            const k = diameter / Math.max(shape.w, shape.h);
            el.style.backgroundImage = `url("${shape.image}")`;
            el.style.backgroundSize = `${shape.w * k}px ${shape.h * k}px`;
        }
        this.labels.append(el);
        nodes.push(el);
        if (shape.text) nodes.push(this.#pill(shape.text, cx, cy + diameter / 2 + 22, color, delay + duration));
        return duration + 0.3;
    }

    #callout(group, shape, color, delay, seed, nodes) {
        const size = shape.size ?? 24;
        const box = wrapText(shape.text, size, 360);
        let [ax, ay] = shape.at ?? [];
        if (!Number.isFinite(ax)) {
            ax = shape.x + 150 + box.width / 2 < innerWidth - 20 ? shape.x + 150 : shape.x - 150;
            ay = shape.y > 140 ? shape.y - 110 : shape.y + 110;
        }
        const written = this.#write(shape.text, ax - box.width / 2, ay - box.height / 2, { color, size, delay, maxWidth: 360 });
        written.el.classList.add("callout-text");
        nodes.push(written.el);
        const textNode = { cx: ax, cy: ay, w: box.width + 16, h: box.height + 10 };
        const start = edgePoint(textNode, shape.x, shape.y, 4);
        const end = edgePoint({ cx: shape.x, cy: shape.y, w: shape.target ? 2 : 10, h: shape.target ? 2 : 10, shape: "ellipse" }, ax, ay, 2);
        const arrow = this.#arrow(group, start, end, color, delay + written.duration * 0.6, { bend: ax > shape.x ? 0.2 : -0.2, seed });
        if (shape.target) return written.duration * 0.6 + arrow;
        const dot = place(div("target-dot"), shape.x, shape.y, delay + written.duration * 0.6 + arrow);
        dot.style.setProperty("--c", color);
        this.labels.append(dot);
        nodes.push(dot);
        return written.duration * 0.6 + arrow + 0.2;
    }

    // Re-sending a diagram id grows it: parts on screen stay put and only new ones sketch in.
    #diagram(group, shape, color, delay, seed, nodes, before) {
        const size = shape.size ?? 20;
        const laid = new Map();
        for (const node of shape.nodes) {
            const box = wrapText(node.text ?? node.id, size, Math.max(80, (node.w ?? 220) - 28));
            const w = node.w ?? clamp(box.width + 36, 96, 340);
            const h = node.h ?? Math.max(box.height + 24, size * 2.4);
            laid.set(node.id, { ...node, cx: node.x, cy: node.y, w, h, shape: node.shape ?? "box", color: safeColor(node.color, color) });
        }
        const all = [...laid.values()];
        const edges = shape.edges ?? [];
        const edgeKey = (edge) => `${edge.from}>${edge.to}`;
        let calm = null;
        const settledGroup = () => calm ?? group.appendChild((calm = svg("g", { class: "settled" })));
        const settle = (el, settled) => (settled && el.classList.add("settled"), el);
        if (shape.board !== false) {
            const pad = 34;
            const minX = Math.min(...all.map((n) => n.cx - n.w / 2)) - pad;
            const minY = Math.min(...all.map((n) => n.cy - n.h / 2)) - pad - (shape.text ? size * 1.8 : 0);
            const maxX = Math.max(...all.map((n) => n.cx + n.w / 2)) + pad;
            const maxY = Math.max(...all.map((n) => n.cy + n.h / 2)) + pad;
            const board = settle(place(div("board"), minX, minY, delay), before);
            Object.assign(board.style, { width: `${maxX - minX}px`, height: `${maxY - minY}px` });
            this.boards.append(board);
            nodes.push(board);
            if (shape.text) nodes.push(settle(this.#write(shape.text, minX + 18, minY + 10, { color: "#f0f6fc", size: size * 1.2, delay: delay + 0.2 }).el, before));
        }
        const drawn = new Set();
        let t = delay + 0.25;
        let end = t;
        const drawEdge = (edge, index) => {
            const a = laid.get(edge.from);
            const b = laid.get(edge.to);
            const start = edgePoint(a, b.cx, b.cy);
            const finish = edgePoint(b, a.cx, a.cy);
            const bend = Number.isFinite(edge.bend) ? edge.bend : 0.08 * (index % 2 ? 1 : -1);
            const edgeColor = safeColor(edge.color, color);
            const settled = before?.edges.has(edgeKey(edge));
            const d = this.#arrow(settled ? settledGroup() : group, start, finish, edgeColor, t, { bend, both: edge.style === "both", dashed: edge.style === "dashed", head: edge.style !== "line", seed: seed + 50 + index });
            if (edge.text) {
                const mid = bowed(start, finish, bend, 2)[1];
                const label = this.#write(edge.text, mid[0], mid[1] - size * 0.6, { color: edgeColor, size: size * 0.8, delay: t + d * 0.6, align: "center", className: "hand edge-label" });
                nodes.push(settle(label.el, settled));
            }
            if (settled) return;
            end = Math.max(end, t + d);
            t += Math.max(0.15, d * 0.5);
        };
        all.forEach((node, index) => {
            const settled = before?.nodes.has(node.id);
            const opts = this.#opts(node.color, seed + index, { fill: "rgba(13, 17, 23, 0.82)", fillStyle: "solid" });
            const { cx, cy, w, h } = node;
            let drawable = null;
            if (node.shape === "ellipse") drawable = generator.ellipse(cx, cy, w, h, opts);
            else if (node.shape === "diamond") drawable = generator.polygon([[cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]], opts);
            else if (node.shape !== "text") drawable = generator.rectangle(cx - w / 2, cy - h / 2, w, h, opts);
            const d = drawable ? this.#ink(settled ? settledGroup() : group, drawable, t) : 0.2;
            const label = this.#write(node.text ?? node.id, cx, cy - wrapText(node.text ?? node.id, size, w - 28).height / 2, { color: "#f0f6fc", size, delay: t + d * 0.5, align: "center", maxWidth: w - 28 });
            nodes.push(settle(label.el, settled));
            drawn.add(node.id);
            if (!settled) {
                end = Math.max(end, t + d * 0.5 + label.duration);
                t += Math.max(0.3, d * 0.8);
            }
            edges.forEach((edge, i) => {
                if (!edge.drawn && drawn.has(edge.from) && drawn.has(edge.to)) {
                    edge.drawn = true;
                    drawEdge(edge, i);
                }
            });
        });
        return { duration: end - delay, diagram: { nodes: new Set(laid.keys()), edges: new Set(edges.map(edgeKey)) } };
    }

    #point(shape, delay) {
        const pointer = this.pointer;
        for (const timer of this.#pointerTimers) clearTimeout(timer);
        this.#pointerTimers = [];
        const move = ([x, y], text) => {
            pointer.style.setProperty("--x", `${x}px`);
            pointer.style.setProperty("--y", `${y}px`);
            pointer.querySelector(".pointer-label").textContent = text;
        };
        if (pointer.classList.contains("hidden")) {
            move([innerWidth / 2, innerHeight - 90], "");
            pointer.classList.remove("hidden");
            pointer.getBoundingClientRect();
        }
        const route = [...(shape.points ?? []), [shape.x, shape.y]];
        route.forEach((point, index) => {
            const last = index === route.length - 1;
            this.#pointerTimers.push(
                setTimeout(() => {
                    move(point, last ? (shape.text ?? "") : "");
                    if (last && shape.click) setTimeout(() => this.ripple(...point), 700);
                }, (delay + index * 0.8) * 1000),
            );
        });
        return pointer;
    }
}
