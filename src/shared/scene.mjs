// 3D motion-graphics scenes: object and action vocabulary plus validation.
import { isRegion } from "./geometry.mjs";

export const OBJECT_TYPES = ["box", "sphere", "cylinder", "cone", "torus", "capsule", "plane", "loft", "extrude", "lathe", "gear", "spring", "text", "arrow", "path", "wire", "group", "image", "base", "part"];
// Ready-made components for type part; their shapes live in the overlay's parts.js.
export const PART_KINDS = ["usb-a", "usb-b", "usb-c", "micro-usb", "hdmi", "micro-hdmi", "ethernet", "audio-jack", "barrel-jack", "microsd", "header", "socket", "ffc", "chip", "can", "capacitor", "smd", "crystal", "led", "button", "display"];
export const MATERIALS = ["metal", "chrome", "gold", "copper", "paint", "plastic", "rubber", "glass", "pcb", "screen", "matte"];
export const SCENE_ACTIONS = ["show", "hide", "move", "rotate", "scale", "color", "opacity", "highlight", "spin", "flow", "camera", "label", "explode"];

const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const isFlatPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const isSection = (s) => Boolean(s) && [s.at, s.width, s.height].every(Number.isFinite) && s.width >= 0 && s.height >= 0;
const TARGETLESS = new Set(["flow", "camera"]);

// Repeated parts (pins, keys, LEDs) are one object with a grid; its copies are id#1, id#2 and so on.
export function gridCount(object) {
    const [columns, rows] = Array.isArray(object?.grid) ? object.grid : [];
    return Number.isInteger(columns) && Number.isInteger(rows) && columns > 0 && rows > 0 ? columns * rows : 0;
}

const radialCount = (object) => (Number.isInteger(object?.radial) && object.radial > 1 ? object.radial : 0);
const isTraced = (object) => object.type === "loft" && isRegion(object.region) && Array.isArray(object.outline) && object.outline.filter(isFlatPoint).length >= 3;

// Every name an action, flow or wire can point at: object ids and grid or radial copies.
function namesIn(objects) {
    const names = new Set();
    for (const object of objects) {
        names.add(object.id);
        for (let n = 1; n <= (gridCount(object) || radialCount(object)); n++) names.add(`${object.id}#${n}`);
    }
    return names;
}

function objectsProblem(scene) {
    if (!scene || typeof scene !== "object") return "scene must be an object with objects";
    const objects = scene.objects;
    if (!Array.isArray(objects) || !objects.length || objects.length > 120) return "scene needs 1 to 120 objects";
    const ids = new Set();
    for (const object of objects) {
        const id = object?.id;
        if (typeof id !== "string" || !id.trim()) return "each scene object needs an id";
        if (ids.has(id)) return `scene object id "${id}" is used twice`;
        ids.add(id);
        if (!OBJECT_TYPES.includes(object.type)) return `scene object "${id}" has unknown type "${object.type}"; use ${OBJECT_TYPES.join(", ")}`;
        if (object.type === "arrow" && !(isPoint(object.from) && isPoint(object.to))) return `arrow "${id}" needs from and to as [x, y, z]`;
        if (object.type === "path" && !(Array.isArray(object.points) && object.points.filter(isPoint).length >= 2)) return `path "${id}" needs at least two [x, y, z] points`;
        if (object.type === "text" && !String(object.text ?? "").trim()) return `text "${id}" needs text`;
        if (object.type === "image" && typeof object.src !== "string") return `image "${id}" needs src, the path of an image from image_generation`;
        if (object.type === "base" && !isRegion(object.region)) return `base "${id}" needs region, the picture of the thing on screen in screenshot pixels`;
        if (object.type === "part" && !PART_KINDS.includes(object.part)) return `part "${id}" has unknown part "${object.part}"; use ${PART_KINDS.join(", ")}`;
        if (object.type === "extrude" && !(Array.isArray(object.points) && object.points.filter(isFlatPoint).length >= 3)) return `extrude "${id}" needs at least three [x, y] outline points`;
        if (object.type === "lathe" && !(Array.isArray(object.points) && object.points.filter(isFlatPoint).length >= 2)) return `lathe "${id}" needs at least two [radius, y] profile points`;
        if (object.type === "loft" && !isTraced(object) && !(Array.isArray(object.sections) && object.sections.filter(isSection).length >= 2)) {
            return `loft "${id}" needs at least two sections, each with at, width and height, or region and outline traced on its picture`;
        }
        if (object.radial !== undefined && !(radialCount(object) && object.radial <= 120)) return `"${id}" radial must be a whole number of copies from 2 to 120`;
        if (object.pivot !== undefined && !isPoint(object.pivot)) return `"${id}" pivot must be [x, y, z]`;
        if (object.mirror !== undefined && !["x", "y", "z"].includes(object.mirror)) return `"${id}" mirror must be x, y or z`;
        if (object.grid !== undefined && !(gridCount(object) && gridCount(object) <= 400)) return `"${id}" grid must be [columns, rows] of whole numbers, at most 400 copies`;
    }
    for (const object of objects) {
        if (object.cut === undefined) continue;
        if (!Array.isArray(object.cut)) return `"${object.id}" cut must be a list of object ids`;
        const bad = object.cut.find((cutter) => !ids.has(cutter) || cutter === object.id);
        if (bad !== undefined) return `"${object.id}" cuts with "${bad}", which is not another object's id`;
    }
    const bases = new Set(objects.filter((o) => o.type === "base" || isTraced(o)).map((o) => o.id));
    for (const object of objects) {
        if (object.on === undefined) continue;
        if (!bases.has(object.on)) return `"${object.id}" is on "${object.on}", which is not a base or a traced loft`;
        if (!isFlatPoint(object.at)) return `"${object.id}" needs at: [x, y], where it sits on the picture`;
        if (object.footprint !== undefined && !(isFlatPoint(object.footprint) && object.footprint.every((v) => v > 0))) return `"${object.id}" footprint must be [width, height]`;
    }
    const names = namesIn(objects);
    for (const object of objects.filter((o) => o.type === "wire")) {
        for (const end of [object.from, object.to]) if (!(isPoint(end) || names.has(end))) return `wire "${object.id}" end ${JSON.stringify(end)} is not an object id, a copy like pins#3, or [x, y, z]`;
    }
    const parents = new Map(objects.map((object) => [object.id, object.parent]));
    for (const object of objects) {
        if (object.parent === undefined) continue;
        if (!ids.has(object.parent) || object.parent === object.id) return `scene object "${object.id}" has unknown parent "${object.parent}"`;
        let node = object.parent;
        for (let hops = 0; node !== undefined && hops <= objects.length; hops++) {
            if (node === object.id) return `scene objects "${object.id}" and "${object.parent}" are each other's parents`;
            node = parents.get(node);
        }
    }
    return null;
}

function actionProblem(action, ids, flows, wires) {
    if (!SCENE_ACTIONS.includes(action?.do)) return `unknown action "${action?.do}"; use ${SCENE_ACTIONS.join(", ")}`;
    if (!TARGETLESS.has(action.do) && !ids.has(action.target) && !(action.do === "hide" && flows.has(action.target))) return `${action.do} targets unknown object "${action.target}"`;
    if (action.do !== "flow") return null;
    if (action.along !== undefined) return wires.has(action.along) ? null : `flow along "${action.along}" is not a wire id`;
    if (!(action.from && action.to)) return "flow needs from and to (object ids or [x, y, z]), or along a wire";
    for (const end of [action.from, action.to]) if (!(isPoint(end) || ids.has(end))) return `flow end ${JSON.stringify(end)} is not an object id or [x, y, z]`;
    return null;
}

const namesOf = (scene, steps) => ({
    ids: namesIn(scene.objects),
    flows: new Set(steps.flat().filter((action) => action?.do === "flow" && typeof action.id === "string").map((action) => action.id)),
    wires: new Set(scene.objects.filter((object) => object.type === "wire").map((object) => object.id)),
});

// A problem the model can fix, or null; steps holds one action list per narrated step.
export function validateScene(scene, steps = []) {
    const problem = objectsProblem(scene);
    if (problem) return problem;
    if (!Array.isArray(steps) || steps.length > 12 || steps.some((actions) => !Array.isArray(actions) || actions.length > 40)) {
        return "scene steps must be at most 12 lists of at most 40 actions";
    }
    const { ids, flows, wires } = namesOf(scene, steps);
    for (const [index, actions] of steps.entries()) {
        for (const action of actions) {
            const bad = actionProblem(action, ids, flows, wires);
            if (bad) return `scene step ${index + 1}: ${bad}`;
        }
    }
    return null;
}

// For explanations: keeps a scene playable by dropping only its broken actions, and lists them.
export function playableSteps(scene, steps) {
    const problem = objectsProblem(scene);
    if (problem) return { problem, steps: [], dropped: [] };
    const lists = steps.map((actions) => (Array.isArray(actions) ? actions.slice(0, 40) : []));
    const { ids, flows, wires } = namesOf(scene, lists);
    const dropped = [];
    const kept = lists.map((actions, index) =>
        actions.filter((action) => {
            const bad = actionProblem(action, ids, flows, wires);
            if (bad) dropped.push(`scene step ${index + 1}: ${bad}`);
            return !bad;
        }),
    );
    return { problem: null, steps: kept, dropped };
}
