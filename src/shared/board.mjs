// 2D motion-graphics boards (3Blue1Brown style): element and action vocabulary plus validation.
import { compile } from "./mathexpr.mjs";

export const BOARD_TYPES = ["tex", "text", "box", "circle", "line", "arrow", "path", "brace", "axes", "plot", "area", "dot", "vector", "tangent"];
export const BOARD_ACTIONS = ["show", "hide", "move", "transform", "color", "highlight", "surround", "opacity", "set", "apply", "flow", "camera"];
// \part{name}{...} marks a piece steps can target as id.name; \val{name} shows a variable's value.
const TEX_MACROS = { "\\part": "\\htmlClass{p-#1}{#2}", "\\val": "\\htmlClass{v-#1}{#1}" };

export const katexOptions = () => ({ macros: { ...TEX_MACROS }, trust: (context) => context.command === "\\htmlClass", strict: "ignore", throwOnError: true, output: "html" });

const formatted = (value) => (Math.abs(value - Math.round(value)) < 1e-9 ? String(Math.round(value)) : value.toFixed(Math.abs(value) < 10 ? 2 : 1));
// Puts the current value of each variable or expression in place of \val{...}; names in whole show rounded.
export const withValues = (source, vars = {}, whole = new Set()) => {
    const names = Object.keys(vars);
    const out = String(source).replace(/\\val\{([^{}]+)\}/g, (all, expr) => {
        const key = expr.trim();
        if (Number.isFinite(vars[key])) return formatted(whole.has(key) ? Math.round(vars[key]) : vars[key]);
        if (!names.length) return all;
        try {
            const v = compile(key, names)(vars);
            return Number.isFinite(v) ? formatted(v) : all;
        } catch {
            return all;
        }
    });
    return /\\val\{/.test(source) ? out.replace(/\+\s*-(\d)/g, "- $1").replace(/-\s*-(\d)/g, "+ $1") : out;
};

export const texParts = (tex) => [...String(tex ?? "").matchAll(/\\part\{([\w-]+)\}/g)].map((match) => match[1]);

// Plain phrases need text mode; KaTeX otherwise removes their spaces.
export function labelTex(source) {
    if (typeof source !== "string") return source;
    const text = source.trim();
    const words = text.split(/\s+/);
    const prose = words.some((word) => /\p{L}{3}/u.test(word) && !/^(sin|cos|tan|log|ln|exp|lim|min|max)$/i.test(word));
    return words.length > 1 && prose && /^[\p{L}\p{N}.,:;!?()'’/ +<>=-]+$/u.test(text) ? `\\text{${text}}` : source;
}

const ID = /^[\w-]+$/;
const isPair = (p) => Array.isArray(p) && p.length === 2;
// Where each type may sit (its coordinates become that axes' maths coordinates), and which types must.
const ON = { plot: ["axes"], area: ["axes", "plot"], dot: ["axes", "plot"], vector: ["axes"], tangent: ["plot"], path: ["axes"], line: ["axes"], arrow: ["axes"], circle: ["axes"], box: ["axes"], tex: ["axes"], text: ["axes"], brace: ["axes"] };
const MUST_SIT = new Set(["plot", "area", "tangent"]);
const NEEDS = {
    tex: (e) => (typeof e.tex === "string" && e.tex.trim() !== "") || "needs tex",
    // Text may start empty, as a placeholder that a later transform fills in.
    text: (e) => typeof e.text === "string" || "needs text",
    path: (e) => (Array.isArray(e.points) && e.points.length >= 2) || "needs at least two points",
    axes: (e) => [e.x, e.y].every((r) => r === undefined || (Array.isArray(r) && r.length >= 2 && r[0] < r[1])) || "x and y must be [min, max, step] with min below max",
    plot: (e) => typeof e.fn === "string" || "needs fn, an expression in x",
    area: (e) => isPair(e.domain) || "needs domain [from, to]",
    dot: (e) => isPair(e.at) || (e.on !== undefined && e.x !== undefined) || "needs at: [x, y], or to be on a plot with x",
    tangent: (e) => e.x !== undefined || "needs x, where along the plot it touches",
    vector: (e) => isPair(e.to) || isPair(e.at) || "needs to: [x, y]",
    line: (e) => (e.from !== undefined && e.to !== undefined) || "needs from and to",
    arrow: (e) => (e.from !== undefined && e.to !== undefined) || "needs from and to",
    brace: (e) => typeof e.of === "string" || (isPair(e.from) && isPair(e.to)) || "needs of (an element or part) or from and to",
};

// Every expression an element uses, with the names it may refer to; ids are the board's element ids.
function expressionsOf(element, vars, ids) {
    const list = [];
    const add = (value, names = vars) => typeof value === "string" && list.push([value, names]);
    add(element.fn, ["x", ...vars]);
    if (element.type === "area" && !ids.has(element.lower)) add(element.lower, ["x", ...vars]);
    add(element.x);
    add(element.r);
    add(element.width);
    add(element.height);
    add(element.bars);
    for (const pair of [element.at, element.from, element.to, element.domain]) if (isPair(pair)) pair.forEach((value) => add(value));
    if (element.type === "path" && Array.isArray(element.points)) for (const p of element.points) if (isPair(p)) p.forEach((value) => add(value));
    return list;
}

// Why an expression does not compile, or null.
function expressionProblem(source, names) {
    try {
        compile(source, names);
        return null;
    } catch (error) {
        return error.message;
    }
}

function elementsProblem(board) {
    if (!board || typeof board !== "object") return "board must be an object with elements";
    const { elements, vars = {} } = board;
    if (!Array.isArray(elements) || !elements.length || elements.length > 100) return "board needs 1 to 100 elements";
    if (typeof vars !== "object" || Object.values(vars).some((value) => !Number.isFinite(value))) return "board vars must map names to numbers";
    const names = Object.keys(vars);
    const types = new Map();
    for (const element of elements) {
        const id = element?.id;
        if (typeof id !== "string" || !ID.test(id)) return `each board element needs an id of letters, digits, _ or - (got ${JSON.stringify(id)})`;
        if (types.has(id)) return `board element id "${id}" is used twice`;
        if (!BOARD_TYPES.includes(element.type)) return `board element "${id}" has unknown type "${element.type}"; use ${BOARD_TYPES.join(", ")}`;
        types.set(id, element.type);
    }
    for (const element of elements) {
        const need = NEEDS[element.type]?.(element);
        if (typeof need === "string") return `${element.type} "${element.id}" ${need}`;
        const seats = ON[element.type] ?? [];
        if (element.on !== undefined && !seats.includes(types.get(element.on))) return `${element.type} "${element.id}" is on "${element.on}", which is not ${seats.join(" or ") || "something it can sit on"}`;
        if (MUST_SIT.has(element.type) && element.on === undefined) return `${element.type} "${element.id}" needs on: the id of its ${seats.join(" or ")}`;
        if (element.type === "area" && types.get(element.on) === "axes" && typeof element.fn !== "string") return `area "${element.id}" needs fn, or to be on a plot`;
        if (element.type === "area" && types.get(element.lower) && types.get(element.lower) !== "plot") return `area "${element.id}" lower must be a plot or an expression of x`;
        for (const end of element.type === "brace" ? [element.of] : ["line", "arrow"].includes(element.type) ? [element.from, element.to] : []) {
            if (typeof end === "string" && !types.has(end.split(".")[0])) return `${element.type} "${element.id}" points at unknown element "${end}"`;
        }
        for (const [source, allowed] of expressionsOf(element, names, types)) {
            const bad = expressionProblem(source, allowed);
            if (bad) return `${element.type} "${element.id}": ${bad}`;
        }
    }
    return null;
}

const targetsOf = (action) => [action?.target].flat().filter((target) => target !== undefined);

// What steps can target: element ids, equation parts (id.part), and surrounds and flows made by steps.
function namesOf(board, steps) {
    const parts = new Map(board.elements.map((element) => [element.id, new Set(texParts(element.tex))]));
    const actions = steps.flat().filter((action) => action && typeof action === "object");
    for (const action of actions.filter((a) => a.do === "transform")) for (const target of targetsOf(action)) for (const part of texParts(action.to)) parts.get(target)?.add(part);
    const made = new Set(actions.filter((a) => ["surround", "flow"].includes(a.do) && typeof a.id === "string").map((a) => a.id));
    return { types: new Map(board.elements.map((element) => [element.id, element.type])), parts, made, vars: Object.keys(board.vars ?? {}) };
}

function actionProblem(action, names, laxHide = false) {
    if (!BOARD_ACTIONS.includes(action?.do)) return `unknown action "${action?.do}"; use ${BOARD_ACTIONS.join(", ")}`;
    const targets = targetsOf(action);
    for (const target of targets) {
        const [id, part] = String(target).split(".");
        if (action.do === "hide" && (names.made.has(target) || (laxHide && part === undefined && ID.test(id)))) continue;
        if (!names.types.has(id)) return `${action.do} targets unknown element "${target}"`;
        if (part !== undefined && !names.parts.get(id)?.has(part)) return `${action.do} targets "${target}", but "${id}" has no \\part{${part}}{...}`;
    }
    if (!targets.length && !["set", "camera", "flow", "apply"].includes(action.do)) return `${action.do} needs a target`;
    if (action.do === "move" && !isPair(action.to) && !isPair(action.by)) return "move needs to or by as [x, y]";
    if (action.do === "transform" && typeof action.to !== "string") return "transform needs to: the new tex, text or fn";
    if (action.do === "transform") {
        for (const target of targets.filter((t) => ["plot", "area"].includes(names.types.get(t)))) {
            const bad = expressionProblem(action.to, ["x", ...names.vars]);
            if (bad) return `transform of "${target}": ${bad}`;
        }
    }
    if (action.do === "set") {
        const entries = Object.entries(action.vars ?? {});
        if (!entries.length) return "set needs vars, such as {\"a\": 2}";
        const bad = entries.find(([name, value]) => !names.vars.includes(name) || !Number.isFinite(value));
        if (bad) return `set ${bad[0]}: declare it in the board's vars and give it a number`;
    }
    if (action.do === "apply") {
        if (targets.some((t) => names.types.get(t) !== "axes")) return "apply works on axes";
        if (!targets.length && ![...names.types.values()].includes("axes")) return "apply needs axes on the board";
        if (!(Array.isArray(action.matrix) && action.matrix.length === 2 && action.matrix.every((row) => isPair(row) && row.every(Number.isFinite)))) return "apply needs matrix [[a, b], [c, d]]";
    }
    if (action.do === "flow" && !targets.length && !(action.from !== undefined && action.to !== undefined)) return "flow needs a target to stream along, or from and to";
    return null;
}

// A problem the model can fix, or null; steps holds one action list per narrated step.
export function validateBoard(board, steps = []) {
    const problem = elementsProblem(board);
    if (problem) return problem;
    if (!Array.isArray(steps) || steps.length > 12 || steps.some((actions) => !Array.isArray(actions) || actions.length > 40)) return "board steps must be at most 12 lists of at most 40 actions";
    const names = namesOf(board, steps);
    for (const [index, actions] of steps.entries()) {
        for (const action of actions) {
            const bad = actionProblem(action, names);
            if (bad) return `board step ${index + 1}: ${bad}`;
        }
    }
    return null;
}

// For explanations: keeps a board playable by dropping only its broken actions, and lists them.
export function playableBoardSteps(board, steps) {
    const problem = elementsProblem(board);
    if (problem) return { problem, steps: [], dropped: [] };
    const lists = steps.map((actions) => (Array.isArray(actions) ? actions.slice(0, 40) : []));
    const names = namesOf(board, lists);
    const dropped = [];
    const kept = lists.map((actions, index) =>
        actions.filter((action) => {
            const bad = actionProblem(action, names, true);
            if (bad) dropped.push(`board step ${index + 1}: ${bad}`);
            return !bad;
        }),
    );
    return { problem: null, steps: kept, dropped };
}

// Every piece of TeX a board will typeset, so it can be checked before anything is shown.
export function texSources(board, steps = []) {
    const list = [];
    for (const element of board.elements ?? []) {
        if (typeof element.tex === "string") list.push([element.id, element.tex]);
        if (typeof element.label === "string") list.push([`${element.id} label`, labelTex(element.label)]);
        for (const label of Array.isArray(element.labels) ? element.labels : []) if (typeof label === "string") list.push([`${element.id} labels`, labelTex(label)]);
    }
    const tex = new Set((board.elements ?? []).filter((element) => element.type === "tex" || (["box", "circle"].includes(element.type) && element.tex)).map((element) => element.id));
    for (const action of steps.flat()) if (action?.do === "transform" && typeof action.to === "string" && targetsOf(action).some((t) => tex.has(t))) list.push([`transform of ${action.target}`, action.to]);
    return list;
}

// Board layout. Boxes are { x, y, w, h, frame } in board pixels, where frame marks a box element.
export const BOARD_MARGIN = 10;
const GAP = 14;
const area = (r) => r.w * r.h;
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
// Text inside a bigger box (a frame), or a box drawn around text, overlaps on purpose.
const nested = (a, b) => {
    const [big, small] = area(a) > area(b) ? [a, b] : [b, a];
    return big.frame && area(big) > 1.5 * area(small) && overlap(a, b) > 0.85 * area(small);
};
// Elements that touch or overlap, unless nested, need separating.
const hits = (a, b) => a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4 && !nested(a, b);
const fitsIn = (v, size, max, margin = BOARD_MARGIN) => size > max - 2 * margin || (v >= margin - 0.5 && v + size <= max - margin + 0.5);

// The smallest move [dx, dy] that keeps box b on a width by height board and off the taken boxes; a move clears them by GAP.
export function clearSpot(b, taken, width, height) {
    const search = (gap, margin) => {
        const into = (v, size, max) => (size > max - 2 * margin ? margin - v : Math.min(Math.max(v, margin), max - margin - size) - v);
        const at = ([dx, dy]) => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h, frame: b.frame });
        const onBoard = (r) => fitsIn(r.x, r.w, width, margin) && fitsIn(r.y, r.h, height, margin);
        let frontier = [[into(b.x, b.w, width), into(b.y, b.h, height)]];
        const seen = new Set();
        let least = null;
        for (let depth = 0; depth < 6 && frontier.length; depth++) {
            const next = [];
            for (const d of frontier) {
                const r = at(d);
                const blockers = taken.filter((o) => hits(r, o));
                if (!blockers.length) return { d, clear: true };
                const cost = blockers.reduce((sum, o) => sum + overlap(r, o), 0) + Math.hypot(...d) * 0.1;
                if (!least || cost < least.cost) least = { d, cost };
                for (const o of blockers) next.push([d[0], o.y - gap - b.h - b.y], [d[0], o.y + o.h + gap - b.y], [o.x - gap - b.w - b.x, d[1]], [o.x + o.w + gap - b.x, d[1]]);
            }
            frontier = next
                .filter((d) => onBoard(at(d)) && !seen.has(d.join()) && seen.add(d.join()))
                .sort((p, q) => Math.hypot(...p) - Math.hypot(...q))
                .slice(0, 16);
        }
        return { d: least?.d ?? [into(b.x, b.w, width), into(b.y, b.h, height)], clear: false };
    };
    const first = search(GAP, BOARD_MARGIN);
    if (first.clear) return first.d;
    const tight = search(4, 2);
    return tight.clear ? tight.d : first.d;
}

// Leave space for an arrow between connected nodes when the board has room.
export function clearNodeSpot(box, taken, linked, width, height) {
    const expanded = taken.map((other) =>
        linked.has(other.id) && !nested(box, other)
            ? { ...other, x: other.x - 60, y: other.y - 60, w: other.w + 120, h: other.h + 120, frame: false }
            : other,
    );
    const spot = clearSpot(box, expanded, width, height);
    const moved = { ...box, x: box.x + spot[0], y: box.y + spot[1] };
    return expanded.some((other) => hits(moved, other)) ? clearSpot(box, taken, width, height) : spot;
}

// Opposite directions need the same bend sign because their normals point in opposite directions.
export function linkBend(edge, elements) {
    if (Number.isFinite(edge.bend)) return edge.bend;
    if (typeof edge.from !== "string" || typeof edge.to !== "string" || edge.from === edge.to) return 0;
    const reverse = elements.find((other) => ["line", "arrow"].includes(other.type) && other.from === edge.to && other.to === edge.from);
    return reverse ? (reverse.bend < 0 ? -0.45 : 0.45) : 0;
}

// Give labels room beside a link without pushing long labels away from it.
export function linkLabelGap(normal, width, height) {
    return Math.min(60, Math.max(34, (Math.abs(normal[0]) * width + Math.abs(normal[1]) * height) / 2 + 14));
}

export const sequenceLink = (a, b) => Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0]) * 0.2;

export const linkLabelSide = (normal, bend, sequence) => (sequence ? (normal[1] > 0 ? -1 : 1) : bend < 0 ? -1 : 1);

export const routeDiagramLink = (edge, sequence) => !edge.on && !sequence && (edge.type === "arrow" || (edge.type === "line" && (typeof edge.from === "string" || typeof edge.to === "string")));

export const circleRadius = (requested, textWidth, textHeight) => Math.max(requested, Math.hypot(textWidth / 2, textHeight / 2) + 18);

// Zoom compact diagrams into the available board without clipping their full content.
export function diagramFrame(bounds, width = 1600, height = 900) {
    const normal = { x: width / 2, y: height / 2, z: 1 };
    if (!bounds || ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) return normal;
    const z = Math.min(1.7, (width - 160) / bounds.w, (height - 160) / bounds.h);
    return z <= 1.05 ? normal : { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, z };
}

function segmentHits(a, b, rect) {
    let low = 0;
    let high = 1;
    for (const [p, q, lo, hi] of [[a[0], b[0], rect.x - 2, rect.x + rect.w + 2], [a[1], b[1], rect.y - 2, rect.y + rect.h + 2]]) {
        if (Math.abs(q - p) < 1e-8) {
            if (p < lo || p > hi) return false;
        } else {
            const [t1, t2] = [(lo - p) / (q - p), (hi - p) / (q - p)].sort((x, y) => x - y);
            low = Math.max(low, t1);
            high = Math.min(high, t2);
            if (low > high) return false;
        }
    }
    return true;
}

// Choose a nearby point and side that keep a link label associated with its own edge.
export function placeLinkLabel({ a, b, control, width, height, side, obstacles = [], paths = [] }) {
    const point = (t) => [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * control[0] + t ** 2 * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * control[1] + t ** 2 * b[1]];
    const curve = Array.from({ length: 25 }, (_, i) => point(i / 24));
    const intersects = (rect, path) => path.slice(1).some((p, i) => segmentHits(path[i], p, rect));
    let best = null;
    for (const t of [0.5, 0.35, 0.65, 0.25, 0.75, 0.18, 0.82]) {
        const [dx, dy] = [2 * (1 - t) * (control[0] - a[0]) + 2 * t * (b[0] - control[0]), 2 * (1 - t) * (control[1] - a[1]) + 2 * t * (b[1] - control[1])];
        const length = Math.hypot(dx, dy) || 1;
        const normal = [-dy / length, dx / length];
        const gap = Math.max(34, (Math.abs(normal[0]) * width + Math.abs(normal[1]) * height) / 2 + 14);
        for (const direction of [side, -side]) {
            const p = point(t);
            const centre = [p[0] + normal[0] * direction * gap, p[1] + normal[1] * direction * gap];
            const rect = { x: centre[0] - width / 2, y: centre[1] - height / 2, w: width, h: height };
            const outside = rect.x < BOARD_MARGIN || rect.y < BOARD_MARGIN || rect.x + width > 1600 - BOARD_MARGIN || rect.y + height > 900 - BOARD_MARGIN;
            const collides = obstacles.reduce((sum, obstacle) => sum + (overlap(rect, obstacle) > 0 ? (obstacle.node ? 10 : 1) : 0), 0);
            const edges = [curve, ...paths].filter((path) => intersects(rect, path)).length;
            const cost = Number(outside) * 100_000 + collides * 10_000 + edges * 1_000 + gap + Math.abs(t - 0.5) * 100 + (direction === side ? 0 : 10);
            if (!best || cost < best.cost) best = { centre, cost };
        }
    }
    return best.centre;
}

// Keep a requested curve unless it crosses another node or label; then try nearby curves.
export function routeBend(a, b, preferred, obstacles) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!length) return preferred;
    const containsPoint = (r, p) => p[0] >= r.x - 2 && p[0] <= r.x + r.w + 2 && p[1] >= r.y - 2 && p[1] <= r.y + r.h + 2;
    const blocked = obstacles.filter((r) => !containsPoint(r, a) && !containsPoint(r, b));
    if (!blocked.length) return preferred;
    const normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
    const collisions = (bend) => {
        const c = [(a[0] + b[0]) / 2 + (normal[0] * bend * length) / 2, (a[1] + b[1]) / 2 + (normal[1] * bend * length) / 2];
        const points = Array.from({ length: 25 }, (_, i) => {
            const t = i / 24;
            return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t ** 2 * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t ** 2 * b[1]];
        });
        return blocked.reduce((sum, r) => sum + (points.slice(1).some((p, i) => segmentHits(points[i], p, r)) ? (r.node ? 10 : 1) : 0), 0);
    };
    const current = collisions(preferred);
    if (!current) return preferred;
    const candidates = [0, 0.2, -0.2, 0.4, -0.4, 0.65, -0.65, 1, -1, 1.5, -1.5, 2, -2];
    let best = { bend: preferred, hits: current };
    for (const bend of candidates) {
        const hits = collisions(bend);
        if (hits < best.hits || (hits === best.hits && Math.abs(bend - preferred) < Math.abs(best.bend - preferred))) best = { bend, hits };
    }
    return best.bend;
}

// A self-transition leaves and re-enters a node on the side with room for its loop.
export function loopAround(box, width = 1600, height = 900) {
    const above = box.y;
    const below = height - box.y - box.h;
    const side = above >= 160 || above >= below ? -1 : 1;
    const boundary = side < 0 ? box.y : box.y + box.h;
    const depth = Math.max(35, Math.min(140, (side < 0 ? above : below) - 60));
    const cx = box.x + box.w / 2;
    const span = Math.min(box.w * 0.25, 80);
    const spread = Math.max(40, span);
    const from = [cx - span, boundary + side * 12];
    const to = [cx + span, boundary + side * 12];
    const control1 = [Math.max(BOARD_MARGIN, from[0] - spread), boundary + side * depth];
    const control2 = [Math.min(width - BOARD_MARGIN, to[0] + spread), boundary + side * depth];
    return { from, to, control1, control2, side };
}
