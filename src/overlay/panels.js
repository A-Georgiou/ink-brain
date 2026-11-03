// Floating panels on the user's screen: Markdown inline; diagrams, 3D and HTML in sandboxed frames.
import { renderMarkdown } from "./markdown.js";
import { stageSpot } from "/shared/geometry.mjs";

const KIND_LABEL = { markdown: "Notes", mermaid: "Diagram", three: "3D", html: "Interactive", scene: "Explainer", board: "Explainer", cutout: "Cutout", image: "Render" };
const DEFAULT_SIZE = { markdown: [440, 380], mermaid: [600, 440], three: [560, 460], html: [600, 460], image: [520, 420], scene: [720, 540], board: [760, 520] };
// Boards and scenes scale their content to the panel, so smaller ones become hard to read.
const MIN_SIZE = { scene: [520, 380], board: [640, 380] };
// A 3D stage beside what the user circled takes as much of the free space as it can, from this size down.
const [STAGE_MAX, STAGE_MIN] = [[920, 700], [400, 300]];
const SANDBOX_URL = "/overlay/sandbox.html";
const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14"><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>`;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const asRect = (r) => ({ x: r.x, y: r.y, w: r.w ?? r.width, h: r.h ?? r.height });
// Whether a panel hides a fifth or more of what the user marked.
const covers = (mark, panel) => {
    if (!mark) return false;
    const area = Math.max(0, Math.min(mark.x + mark.w, panel.x + panel.w) - Math.max(mark.x, panel.x)) * Math.max(0, Math.min(mark.y + mark.h, panel.y + panel.h) - Math.max(mark.y, panel.y));
    return area > 0.2 * Math.max(1, mark.w * mark.h);
};

export class Panels {
    #panels = new Map();
    #frames = new Map();
    #z = 20;

    // pageFor(rect) names the page a panel at rect belongs to, so it hides and moves with that page; target() is what the user circled.
    constructor(container, { avoid = () => [], target = () => null, onLayout = () => {}, pageFor = () => null } = {}) {
        this.container = container;
        this.avoid = avoid;
        this.target = target;
        this.onLayout = onLayout;
        this.pageFor = pageFor;
        addEventListener("message", (event) => this.#onMessage(event));
    }

    rects() {
        return [...this.#panels.values()].filter((panel) => !panel.el.classList.contains("away")).map((panel) => panel.el.getBoundingClientRect());
    }

    showPages(states) {
        for (const panel of this.#panels.values()) {
            const state = panel.page && states.get(panel.page);
            if (!state) continue;
            panel.el.classList.toggle("away", !state.visible);
            if (!Number.isFinite(state.dx)) continue;
            const [dx, dy] = [state.dx - panel.offset.dx, state.dy - panel.offset.dy];
            if (!dx && !dy) continue;
            panel.el.style.left = `${panel.el.offsetLeft + dx}px`;
            panel.el.style.top = `${panel.el.offsetTop + dy}px`;
            panel.offset = { dx: state.dx, dy: state.dy };
        }
    }

    pageKeys() {
        return new Set([...this.#panels.values()].map((panel) => panel.page).filter(Boolean));
    }

    rectOf(id) {
        const panel = this.#panels.get(id);
        return panel && !panel.el.classList.contains("away") ? panel.el.getBoundingClientRect() : null;
    }

    // Appends narrated steps to a motion-graphics scene while its explanation is still being written.
    addSteps(id, steps) {
        const panel = this.#panels.get(id);
        if (!panel) return;
        panel.added.push(...steps);
        if (panel.sent) panel.frame?.contentWindow?.postMessage({ type: "steps", steps }, "*");
    }

    // Moves a motion-graphics scene to a narrated step; a frame still loading gets it once ready.
    step(id, index) {
        const panel = this.#panels.get(id);
        if (!panel) return;
        panel.step = index;
        panel.frame?.contentWindow?.postMessage({ type: "step", index }, "*");
    }

    goto(id, index) {
        const panel = this.#panels.get(id);
        if (!panel) return;
        panel.step = index;
        panel.frame?.contentWindow?.postMessage({ type: "goto", index }, "*");
    }

    // Tells a scene how much of its bottom the subtitles cover, so it frames the model above them.
    inset(id, px) {
        const panel = this.#panels.get(id);
        if (!panel || panel.inset === px) return;
        panel.inset = px;
        if (panel.sent) panel.frame?.contentWindow?.postMessage({ type: "inset", px }, "*");
    }

    async show({ id, kind, title, content, rect = {}, frameless = false, image = null, building = false }) {
        const isNew = !this.#panels.has(id);
        const panel = this.#open(id, kind, title, frameless);
        if (building) panel.el.querySelector(".panel-kind").textContent = "Building";
        panel.step = null;
        panel.added = [];
        panel.autoSize = !frameless && !Number.isFinite(rect.width) && !Number.isFinite(rect.height) && isNew;
        if (frameless) this.#cover(panel, rect);
        else this.#layout(panel, kind, rect, isNew);
        this.#anchor(panel);
        this.#clearError(panel);
        const body = panel.el.querySelector(".panel-body");
        if (kind === "markdown") {
            this.#dropFrame(panel);
            body.className = "panel-body markdown";
            body.innerHTML = renderMarkdown(content);
            if (!frameless && !Number.isFinite(rect.height)) this.#fitHeight(panel);
            return { ok: true };
        }
        body.className = "panel-body";
        return this.#renderInFrame(panel, kind, content, image);
    }

    // Lifts a piece of the screen into a card that flies out from where it sits on screen.
    showCutout({ id, image, from, to, scale, title }) {
        const panel = this.#open(id, "cutout", title || "From your screen");
        this.#dropFrame(panel);
        panel.autoSize = false;
        panel.autoPlaced = false;
        const body = panel.el.querySelector(".panel-body");
        body.className = "panel-body image-body";
        const img = Object.assign(new Image(), { src: image, alt: title || "Part of your screen", draggable: false });
        body.replaceChildren(img);
        const bar = 40;
        const w = clamp(from.w * scale, 160, innerWidth * 0.6);
        const h = clamp(from.h * (w / from.w), 80, innerHeight * 0.7);
        const spot = to ? { x: to[0], y: to[1] } : this.#nearby(from, w, h + bar, panel);
        spot.x = clamp(spot.x, 12, innerWidth - w - 12);
        spot.y = clamp(spot.y, 32, innerHeight - h - bar - 12);
        Object.assign(panel.el.style, { left: `${spot.x}px`, top: `${spot.y}px`, width: `${w}px`, height: `${h + bar}px` });
        this.#anchor(panel);
        const s0 = from.w / w;
        panel.el.animate(
            [
                { transform: `translate(${from.x - spot.x}px, ${from.y - spot.y - bar * s0}px) scale(${s0})`, boxShadow: "0 0 0 rgba(0,0,0,0)" },
                { transform: `translate(${(from.x - spot.x) * 0.15}px, ${(from.y - spot.y) * 0.15 - 18}px) scale(${s0 + (1 - s0) * 0.85}) rotate(-1.2deg)`, offset: 0.55 },
                { transform: "none" },
            ],
            { duration: 750, easing: "cubic-bezier(0.2, 0.85, 0.25, 1)" },
        );
        const ghost = document.createElement("div");
        ghost.className = "cutout-ghost";
        Object.assign(ghost.style, { left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px` });
        this.container.append(ghost);
        setTimeout(() => ghost.remove(), 2600);
        this.onLayout();
        return { x: spot.x, y: spot.y + bar, w, h };
    }

    // Shows an image file, optionally laid over a region with a before/after slider.
    async showImage({ id, image, before, rect = {}, frameless = false, title }) {
        const isNew = !this.#panels.has(id);
        const panel = this.#open(id, "image", title || "Image", frameless);
        this.#dropFrame(panel);
        const body = panel.el.querySelector(".panel-body");
        body.className = `panel-body image-body${frameless ? " cover" : ""}`;
        const after = Object.assign(new Image(), { src: image, className: "after", alt: title || "Image", draggable: false });
        await after.decode().catch(() => {});
        if (before) {
            const base = Object.assign(new Image(), { src: before, className: "before", alt: "Before", draggable: false });
            const handle = document.createElement("div");
            handle.className = "compare-handle";
            body.replaceChildren(base, after, handle);
            this.#compare(body);
        } else {
            body.replaceChildren(after);
        }
        if (frameless) {
            this.#cover(panel, rect);
        } else {
            const ratio = (after.naturalHeight || 3) / (after.naturalWidth || 4);
            const width = rect.width ?? clamp(after.naturalWidth || 520, 280, Math.min(640, innerWidth * 0.45));
            this.#layout(panel, "image", { ...rect, width, height: rect.height ?? width * ratio + 40 }, isNew);
        }
        this.#anchor(panel);
        this.onLayout();
        return { ok: true };
    }

    clear(id, { visibleOnly = false } = {}) {
        const ids = id ? [id] : [...this.#panels.keys()];
        for (const key of ids) {
            const panel = this.#panels.get(key);
            if (!panel || (visibleOnly && panel.el.classList.contains("away"))) continue;
            panel.pending?.finish({ ok: false, error: "The panel was closed." });
            this.#dropFrame(panel);
            panel.el.remove();
            this.#panels.delete(key);
        }
    }

    // Gets or creates a panel, brings it to the front and dresses it for its kind.
    #open(id, kind, title, frameless = false) {
        const panel = this.#panels.get(id) ?? this.#create(id);
        const el = panel.el;
        panel.kind = kind;
        el.style.zIndex = String(++this.#z);
        el.classList.toggle("cutout", kind === "cutout");
        el.classList.toggle("frameless", frameless);
        el.querySelector(".panel-kind").textContent = KIND_LABEL[kind];
        el.querySelector(".panel-title").textContent = title || KIND_LABEL[kind];
        return panel;
    }

    #anchor(panel) {
        const el = panel.el;
        panel.page = this.pageFor({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
        panel.offset = { dx: 0, dy: 0 };
        el.classList.remove("away");
    }

    // Places a frameless panel exactly over a region of the screen.
    #cover(panel, rect) {
        panel.autoPlaced = false;
        const { x = 0, y = 0, width = 320, height = 240 } = rect;
        Object.assign(panel.el.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(40, width)}px`, height: `${Math.max(40, height)}px` });
    }

    // A spot beside the source (right, left, below, above) that fits on screen, else the usual one.
    #nearby(from, w, h, self) {
        const gap = 28;
        const candidates = [
            { x: from.x + from.w + gap, y: from.y - 20 },
            { x: from.x - w - gap, y: from.y - 20 },
            { x: from.x, y: from.y + from.h + gap },
            { x: from.x, y: from.y - h - gap },
        ];
        const fits = (c) => c.x >= 12 && c.y >= 32 && c.x + w <= innerWidth - 12 && c.y + h <= innerHeight - 12;
        return candidates.find(fits) ?? this.#place(w, h, self, null, [1]);
    }

    // Before/after slider: sweeps in to reveal the new image, then tracks the pointer when dragged.
    #compare(body) {
        const set = (fraction) => body.style.setProperty("--split", `${clamp(fraction, 0, 1) * 100}%`);
        set(0);
        const started = performance.now();
        const sweep = (now) => {
            const t = Math.min(1, (now - started) / 1400);
            set(1 - (1 - t) ** 3);
            if (t < 1 && !body.dataset.dragged) requestAnimationFrame(sweep);
        };
        requestAnimationFrame(sweep);
        body.addEventListener("pointerdown", (event) => {
            body.dataset.dragged = "1";
            body.setPointerCapture(event.pointerId);
            const move = (e) => {
                const r = body.getBoundingClientRect();
                set((e.clientX - r.left) / r.width);
            };
            move(event);
            body.addEventListener("pointermove", move);
            body.addEventListener("pointerup", () => body.removeEventListener("pointermove", move), { once: true });
        });
    }

    #create(id) {
        const el = document.createElement("section");
        el.className = "panel card interactive";
        el.innerHTML = `<header class="panel-bar"><span class="panel-kind"></span><span class="panel-title"></span><button type="button" class="icon-button panel-close" title="Close">${CLOSE_ICON}</button></header><div class="panel-body"></div><div class="panel-grip"></div>`;
        this.container.append(el);
        const panel = { id, el, frame: null, pending: null };
        el.addEventListener("pointerdown", () => (el.style.zIndex = String(++this.#z)));
        el.querySelector(".panel-close").addEventListener("click", () => this.clear(id));
        this.#track(panel, el.querySelector(".panel-bar"), "dragging", (start, dx, dy) => {
            el.style.left = `${start.left + dx}px`;
            el.style.top = `${start.top + dy}px`;
        });
        this.#track(panel, el.querySelector(".panel-grip"), "resizing", (start, dx, dy) => {
            el.style.width = `${Math.max(240, start.width + dx)}px`;
            el.style.height = `${Math.max(160, start.height + dy)}px`;
        });
        this.#panels.set(id, panel);
        return panel;
    }

    // Pointer-captured drag helper used for moving and resizing panels.
    #track(panel, handle, mode, apply) {
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || event.target.closest("button")) return;
            event.preventDefault();
            const el = panel.el;
            const start = { x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
            handle.setPointerCapture(event.pointerId);
            el.classList.add(mode);
            document.body.classList.add("dragging");
            panel.autoSize = false;
            panel.autoPlaced = false;
            const move = (e) => apply(start, e.clientX - start.x, e.clientY - start.y);
            const up = () => {
                el.classList.remove(mode);
                document.body.classList.remove("dragging");
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
                handle.removeEventListener("pointercancel", up);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
            handle.addEventListener("pointercancel", up);
        });
    }

    // A note grows or shrinks to fit what it says, so nothing is cut off, and moves if it now needs a new spot.
    #fitHeight(panel) {
        const el = panel.el;
        const body = el.querySelector(".panel-body");
        const height = clamp(body.scrollHeight + el.offsetHeight - body.clientHeight, 160, innerHeight - 80);
        if (Math.abs(height - el.offsetHeight) < 2) return;
        el.style.height = `${height}px`;
        const spot = panel.autoPlaced ? this.#place(el.offsetWidth, height, panel, null, [1]) : { x: el.offsetLeft, y: el.offsetTop };
        el.style.left = `${clamp(spot.x, 16, innerWidth - el.offsetWidth - 16)}px`;
        el.style.top = `${clamp(spot.y, 40, innerHeight - height - 16)}px`;
        this.onLayout();
    }

    #layout(panel, kind, rect, isNew) {
        const el = panel.el;
        const margin = 16;
        const [defaultWidth, defaultHeight] = DEFAULT_SIZE[kind];
        const min = MIN_SIZE[kind] ?? [240, 160];
        const keepSize = !isNew && kind === "scene" && panel.frameKind === kind && panel.frame && !panel.frameFrameless;
        const width = clamp(rect.width ?? (isNew ? defaultWidth : parseFloat(el.style.width) || el.offsetWidth), keepSize && !Number.isFinite(rect.width) ? 1 : min[0], innerWidth - margin * 2);
        const height = clamp(rect.height ?? (isNew ? defaultHeight : parseFloat(el.style.height) || el.offsetHeight), keepSize && !Number.isFinite(rect.height) ? 1 : min[1], innerHeight - margin * 2);
        const placeSelf = !Number.isFinite(rect.x) || !Number.isFinite(rect.y);
        if (isNew) panel.autoPlaced = placeSelf;
        const target = isNew && placeSelf && ["scene", "board"].includes(kind) && !Number.isFinite(rect.width) && !Number.isFinite(rect.height) ? this.target() : null;
        const others = [...this.#panels.values()].filter((p) => p !== panel && p.el.isConnected && !p.el.classList.contains("away")).map((p) => asRect(p.el.getBoundingClientRect()));
        const roomy = target && stageSpot({ target: asRect(target), view: { width: innerWidth, height: innerHeight }, max: STAGE_MAX, min: STAGE_MIN, others });
        // A panel carried on from an earlier turn gets out of the way if the user has since marked something under it.
        const inTheWay = !isNew && placeSelf && panel.autoPlaced && covers(this.target(), asRect(el.getBoundingClientRect()));
        const spot = roomy || (isNew || inTheWay ? this.#place(width, height, panel, placeSelf ? null : rect, undefined, min) : { x: placeSelf ? parseFloat(el.style.left) || el.offsetLeft : rect.x, y: placeSelf ? parseFloat(el.style.top) || el.offsetTop : rect.y, w: width, h: height });
        el.style.width = `${spot.w}px`;
        el.style.height = `${spot.h}px`;
        el.style.left = `${clamp(spot.x, margin, innerWidth - spot.w - margin)}px`;
        el.style.top = `${clamp(spot.y, margin + 24, innerHeight - spot.h - margin)}px`;
    }

    // Marks and the bubble are hard obstacles, panels soft: take the asked or first free slot, else the nearest clear one, shrinking if need be.
    #place(width, height, self, wanted = null, scales = [1, 0.85, 0.72, 0.6], min = [240, 160]) {
        const m = 24;
        const top = 52;
        const hard = this.avoid().filter(Boolean).map(asRect);
        const soft = [...this.#panels.values()].filter((p) => p !== self && p.el.isConnected && !p.el.classList.contains("away")).map((p) => asRect(p.el.getBoundingClientRect()));
        const overlap = (c, rects) => rects.reduce((sum, o) => sum + Math.max(0, Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x)) * Math.max(0, Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y)), 0);
        let fallback = null;
        for (const k of scales) {
            const [w, h] = [Math.round(Math.max(min[0], width * k)), Math.round(Math.max(min[1], height * k))];
            const fit = ({ x, y }) => ({ x: clamp(x, m, innerWidth - w - m), y: clamp(y, top, innerHeight - h - m), w, h });
            const slots = [
                ...(wanted ? [wanted] : []),
                { x: innerWidth - w - m, y: top },
                { x: m, y: top },
                { x: innerWidth - w - m, y: innerHeight - h - 130 },
                { x: m, y: innerHeight - h - 130 },
                { x: (innerWidth - w) / 2, y: top },
                { x: innerWidth - w - m, y: (innerHeight - h) / 2 },
                { x: m, y: (innerHeight - h) / 2 },
                ...hard.flatMap((o) => [
                    { x: o.x + o.w + m, y: o.y + o.h / 2 - h / 2 },
                    { x: o.x - w - m, y: o.y + o.h / 2 - h / 2 },
                    { x: o.x + o.w / 2 - w / 2, y: o.y + o.h + m },
                    { x: o.x + o.w / 2 - w / 2, y: o.y - h - m },
                ]),
            ].map(fit);
            const clear = slots.filter((c) => !overlap(c, hard));
            if (clear.length) {
                const cost = (c) => (wanted ? Math.hypot(c.x - wanted.x, c.y - wanted.y) : overlap(c, soft));
                return clear.reduce((best, c) => (cost(c) < cost(best) ? c : best));
            }
            const crowding = (c) => overlap(c, hard) * 4 + overlap(c, soft);
            fallback ??= slots.reduce((best, c) => (crowding(c) < crowding(best) ? c : best));
        }
        return fallback;
    }

    #renderInFrame(panel, kind, content, image = null) {
        const reuse = kind === "scene" && panel.frameKind === kind && panel.sent && !panel.pending;
        if (!reuse) {
            this.#dropFrame(panel);
            const frame = document.createElement("iframe");
            frame.setAttribute("sandbox", "allow-scripts");
            frame.src = SANDBOX_URL;
            panel.frame = frame;
            panel.frameKind = kind;
            panel.sent = false;
            panel.el.querySelector(".panel-body").replaceChildren(frame);
            this.#frames.set(frame.contentWindow, panel);
        }
        panel.frameFrameless = panel.el.classList.contains("frameless");
        panel.frame.title = panel.el.querySelector(".panel-title").textContent;
        const renderId = (panel.renderId = (panel.renderId ?? 0) + 1);
        return new Promise((resolve) => {
            const finish = (result) => {
                clearTimeout(timer);
                if (panel.pending?.finish === finish) panel.pending = null;
                resolve(result);
            };
            const timer = setTimeout(() => finish({ ok: true, note: "still rendering" }), 15_000);
            panel.pending = { kind, content, image, renderId, finish };
            if (reuse) {
                panel.frame.contentWindow.postMessage({ kind, content, image, renderId, inPlace: panel.el.classList.contains("frameless") }, "*");
                if (Number.isFinite(panel.inset)) panel.frame.contentWindow.postMessage({ type: "inset", px: panel.inset }, "*");
            }
        });
    }

    #dropFrame(panel) {
        if (!panel.frame) return;
        this.#frames.delete(panel.frame.contentWindow);
        panel.frame.remove();
        panel.frame = null;
    }

    #onMessage(event) {
        const panel = this.#frames.get(event.source);
        const data = event.data;
        if (!panel || !data || typeof data !== "object") return;
        if (data.type === "ready" && panel.pending) {
            event.source.postMessage({ kind: panel.pending.kind, content: panel.pending.content, image: panel.pending.image, renderId: panel.pending.renderId, inPlace: panel.el.classList.contains("frameless") }, "*");
            if (panel.added?.length) event.source.postMessage({ type: "steps", steps: panel.added }, "*");
            if (Number.isInteger(panel.step)) event.source.postMessage({ type: "step", index: panel.step }, "*");
            if (Number.isFinite(panel.inset)) event.source.postMessage({ type: "inset", px: panel.inset }, "*");
            panel.sent = true;
        } else if (data.type === "rendered") {
            if (data.renderId === undefined || data.renderId === panel.pending?.renderId) panel.pending?.finish({ ok: true });
        } else if (data.type === "error") {
            if (data.renderId !== undefined && data.renderId !== panel.pending?.renderId) return;
            const message = String(data.message ?? "Unknown error").slice(0, 2000);
            this.#showError(panel, message);
            panel.pending?.finish({ ok: false, error: message });
        } else if (data.type === "size" && panel.autoSize && Number.isFinite(data.width) && Number.isFinite(data.height)) {
            const el = panel.el;
            const width = clamp(data.width + 40, 280, Math.min(640, innerWidth * 0.45));
            const height = clamp(data.height + 72, 200, innerHeight * 0.6);
            el.style.width = `${width}px`;
            el.style.height = `${height}px`;
            if (panel.autoPlaced) {
                const spot = this.#place(width, height, panel, null, [1]);
                el.style.left = `${spot.x}px`;
                el.style.top = `${spot.y}px`;
            }
            el.style.left = `${clamp(el.offsetLeft, 16, innerWidth - width - 16)}px`;
            el.style.top = `${clamp(el.offsetTop, 40, innerHeight - height - 16)}px`;
            this.onLayout();
        }
    }

    #showError(panel, message) {
        this.#clearError(panel);
        const el = document.createElement("pre");
        el.className = "panel-error";
        el.textContent = message;
        panel.el.querySelector(".panel-grip").before(el);
    }

    #clearError(panel) {
        panel.el.querySelector(".panel-error")?.remove();
    }
}
