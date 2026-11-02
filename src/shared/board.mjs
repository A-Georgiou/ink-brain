// 2D motion-graphics boards (3Blue1Brown style): element and action vocabulary plus validation.
import { compile } from "./mathexpr.mjs";

export const BOARD_TYPES = ["tex", "text", "box", "circle", "line", "arrow", "path", "brace", "axes", "plot", "area", "dot", "vector", "tangent"];
export const BOARD_ACTIONS = ["show", "hide", "move", "transform", "color", "highlight", "surround", "opacity", "set", "apply", "flow", "camera"];
// \part{name}{...} marks a piece steps can target as id.name; \val{name} shows a variable's value.
const TEX_MACROS = { "\\part": "\\htmlClass{p-#1}{#2}", "\\val": "\\htmlClass{v-#1}{#1}" };

export const katexOptions = () => ({ macros: { ...TEX_MACROS }, trust: (context) => context.command === "\\htmlClass", strict: "ignore", throwOnError: true, output: "html" });

const formatted = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1));
// Puts the current value of each variable in place of \val{name}.
export const withValues = (source, vars) => String(source).replace(/\\val\{(\w+)\}/g, (all, name) => (Number.isFinite(vars[name]) ? formatted(vars[name]) : all));

export const texParts = (tex) => [...String(tex ?? "").matchAll(/\\part\{([\w-]+)\}/g)].map((match) => match[1]);

const ID = /^[\w-]+$/;
const isPair = (p) => Array.isArray(p) && p.length === 2;
// Where each type may sit (its coordinates become that axes' maths coordinates), and which types must.
const ON = { plot: ["axes"], area: ["axes", "plot"], dot: ["axes", "plot"], vector: ["axes"], tangent: ["plot"], path: ["axes"], line: ["axes"], arrow: ["axes"] };
const MUST_SIT = new Set(["plot", "area", "tangent"]);
const NEEDS = {
    tex: (e) => (typeof e.tex === "string" && e.tex.trim() !== "") || "needs tex",
    text: (e) => (typeof e.text === "string" && e.text.trim() !== "") || "needs text",
    path: (e) => (Array.isArray(e.points) && e.points.length >= 2) || "needs at least two points",
    axes: (e) => [e.x, e.y].every((r) => r === undefined || (Array.isArray(r) && r.length >= 2 && r[0] < r[1])) || "x and y must be [min, max, step] with min below max",
    plot: (e) => typeof e.fn === "string" || "needs fn, an expression in x",
    area: (e) => isPair(e.domain) || "needs domain [from, to]",
    dot: (e) => isPair(e.at) || (e.on !== undefined && e.x !== undefined) || "needs at: [x, y], or to be on a plot with x",
    tangent: (e) => e.x !== undefined || "needs x, where along the plot it touches",
    vector: (e) => isPair(e.to) || "needs to: [x, y]",
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

function actionProblem(action, names) {
    if (!BOARD_ACTIONS.includes(action?.do)) return `unknown action "${action?.do}"; use ${BOARD_ACTIONS.join(", ")}`;
    const targets = targetsOf(action);
    for (const target of targets) {
        const [id, part] = String(target).split(".");
        if (action.do === "hide" && names.made.has(target)) continue;
        if (!names.types.has(id)) return `${action.do} targets unknown element "${target}"`;
        if (part !== undefined && !names.parts.get(id)?.has(part)) return `${action.do} targets "${target}", but "${id}" has no \\part{${part}}{...}`;
    }
    if (!targets.length && !["set", "camera", "flow"].includes(action.do)) return `${action.do} needs a target`;
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
            const bad = actionProblem(action, names);
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
        if (typeof element.label === "string") list.push([`${element.id} label`, element.label]);
        for (const label of Array.isArray(element.labels) ? element.labels : []) if (typeof label === "string") list.push([`${element.id} labels`, label]);
    }
    const tex = new Set((board.elements ?? []).filter((element) => element.type === "tex" || (element.type === "box" && element.tex)).map((element) => element.id));
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
const fitsIn = (v, size, max) => size > max - 2 * BOARD_MARGIN || (v >= BOARD_MARGIN - 0.5 && v + size <= max - BOARD_MARGIN + 0.5);

// The smallest move [dx, dy] that keeps box b on a width by height board and off the taken boxes; a move clears them by GAP.
export function clearSpot(b, taken, width, height) {
    const into = (v, size, max) => (size > max - 2 * BOARD_MARGIN ? BOARD_MARGIN - v : Math.min(Math.max(v, BOARD_MARGIN), max - BOARD_MARGIN - size) - v);
    const at = ([dx, dy]) => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h, frame: b.frame });
    const onBoard = (r) => fitsIn(r.x, r.w, width) && fitsIn(r.y, r.h, height);
    let frontier = [[into(b.x, b.w, width), into(b.y, b.h, height)]];
    const seen = new Set();
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
        const next = [];
        for (const d of frontier) {
            const r = at(d);
            const blockers = taken.filter((o) => hits(r, o));
            if (!blockers.length) return d;
            for (const o of blockers) next.push([d[0], o.y - GAP - b.h - b.y], [d[0], o.y + o.h + GAP - b.y], [o.x - GAP - b.w - b.x, d[1]], [o.x + o.w + GAP - b.x, d[1]]);
        }
        frontier = next
            .filter((d) => onBoard(at(d)) && !seen.has(d.join()) && seen.add(d.join()))
            .sort((p, q) => Math.hypot(...p) - Math.hypot(...q))
            .slice(0, 16);
    }
    return [into(b.x, b.w, width), into(b.y, b.h, height)];
}
