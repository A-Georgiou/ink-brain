// Strict, deterministic check of where a turn's marks landed against the control the user needs.
import { isRegion, overlapArea, validateShape } from "../src/shared/geometry.mjs";
import { controlAt } from "./elements.mjs";

const ON = 6;
const BOXES = new Set(["circle", "rect", "highlight", "underline", "spotlight"]);
const POINTS = new Set(["pulse", "pointer", "callout", "marker", "check", "cross"]);
// Marks that hide what is under them rather than ringing it.
const COVERING = new Set(["arrow", "callout", "marker", "check", "cross"]);
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const gap = (box, [x, y]) => Math.hypot(Math.max(box.x - x, 0, x - box.x - box.w), Math.max(box.y - y, 0, y - box.y - box.h));

// The shapes a turn drew, as placed on screen when recorded, else the valid ones the model asked for.
export function drawnShapes(record) {
    if (record.drawn) return record.drawn.flatMap((d) => d.shapes);
    const asked = record.tools.flatMap((t) => (t.name === "live_annotate" ? (t.args.shapes ?? []) : t.name === "live_explain" ? (t.args.steps ?? []).flatMap((s) => s.draw ?? []) : []));
    return asked.filter((shape) => !validateShape(shape));
}

// What each mark points at: an arrow's tip, a point mark's spot, or the box a box mark frames.
function aims(shapes) {
    return shapes.flatMap((s) => {
        if (s.kind === "arrow" && isPoint(s.to)) return [{ kind: s.kind, point: s.to }];
        if (BOXES.has(s.kind) && isRegion(s)) return [{ kind: s.kind, box: s }];
        return POINTS.has(s.kind) && Number.isFinite(s.x) && Number.isFinite(s.y) ? [{ kind: s.kind, point: [s.x, s.y], framed: Boolean(s.target) }] : [];
    });
}

// Pixels between a mark and a control: 0 when it lands on it. A box mark is on a control it mostly covers, unless it is far bigger.
function reach(aim, control) {
    if (!aim.box) return gap(control, aim.point);
    const covered = overlapArea(control, [aim.box]) >= 0.6 * control.w * control.h && aim.box.w * aim.box.h <= 9 * control.w * control.h;
    return covered ? 0 : gap(control, [aim.box.x + aim.box.w / 2, aim.box.y + aim.box.h / 2]);
}

// The whole control a label belongs to, which is what a mark may point at, unless that is far bigger than the label.
function wholeControl(box, elements) {
    const control = controlAt(elements, [box.x + box.w / 2, box.y + box.h / 2]);
    if (!control || control.w * control.h > 6 * box.w * box.h) return box;
    const [x, y] = [Math.min(box.x, control.x), Math.min(box.y, control.y)];
    return { x, y, w: Math.max(box.x + box.w, control.x + control.w) - x, h: Math.max(box.y + box.h, control.y + control.h) - y };
}

// target, also and decoys are the boxes the steps need, in order, and ones that look right but are wrong; all are { x, y, w, h } in screenshot pixels. elements are what the page's accessibility tree lists.
export function aimAt({ target, also = [], decoys = [] }, shapes, elements = []) {
    const marks = aims(shapes);
    const on = (aim, control) => (aim.box ? reach(aim, control) === 0 : reach(aim, control) <= ON);
    const controls = [target, ...also].map((box) => wholeControl(box, elements));
    const wrongOnes = decoys.map((box) => wholeControl(box, elements));
    const inner = { x: target.x + 4, y: target.y + 4, w: target.w - 8, h: target.h - 8 };
    return {
        hit: marks.some((aim) => on(aim, controls[0])),
        steps: controls.filter((control) => marks.some((aim) => on(aim, control))).length,
        of: controls.length,
        distance: marks.length ? Math.round(Math.min(...marks.map((aim) => reach(aim, controls[0])))) : null,
        wrong: marks.filter((aim) => wrongOnes.some((decoy) => on(aim, decoy)) && (aim.box || !controls.some((control) => on(aim, control)))).length,
        onTop: marks.filter((aim) => COVERING.has(aim.kind) && !aim.framed && aim.point && inner.w > 0 && inner.h > 0 && gap(inner, aim.point) === 0).length,
    };
}
