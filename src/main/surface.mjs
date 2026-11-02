// Runs live_* tools on the overlay and the native helper; results are { text, images?, failed? }.
import katex from "katex";
import { katexOptions, texSources, validateBoard, withValues } from "../shared/board.mjs";
import { isRegion, panelRect, shapeToOverlay, validateShape } from "../shared/geometry.mjs";
import { validateScene } from "../shared/scene.mjs";

const PANEL_KINDS = new Set(["markdown", "mermaid", "three", "html", "scene", "board"]);
const MAX_PANEL_CHARS = 200_000;

export const cleanId = (value) => (typeof value === "string" ? value.replace(/[^\w.-]/g, "").slice(0, 48) : "");
// Models sometimes send a nested object as JSON text; take it as the object it describes.
const asObject = (value) => {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};

// Typesets a board's equations up front, so TeX mistakes reach the model before anything is shown.
function texProblem(board, steps) {
    for (const [where, tex] of texSources(board, steps)) {
        try {
            katex.renderToString(withValues(tex, board.vars ?? {}), katexOptions());
        } catch (error) {
            return `tex of ${where}: ${String(error.message).replace(/^KaTeX parse error: /, "")}`;
        }
    }
    return null;
}

export class Surface {
    #panelCount = 0;

    // Tool handlers take (args, origin) and memory (name, args, origin); image readers return data URLs; snap(shapes) may move marks onto real controls.
    constructor({ overlayCall, look, say, geometry, config, regionImage, readImage, explain, cutout, image, control, read, memory, snap = null }) {
        Object.assign(this, { overlayCall, look, say, geometry, config, regionImage, readImage, explain, cutout, image, control, read, memory, snap });
    }

    // callId identifies the model's tool call, so an explanation already playing from its streamed arguments carries on.
    async execute(name, args = {}, origin = "Ink Brain", callId = undefined) {
        switch (name) {
            case "live_annotate":
                return this.#annotate(args);
            case "live_explain":
                return this.explain({ ...args, steps: asObject(args.steps), scene: asObject(args.scene), board: asObject(args.board) }, origin, callId);
            case "live_panel":
                return this.#panel({ ...args, scene: asObject(args.scene), board: asObject(args.board) });
            case "live_cutout":
                return this.cutout(args, origin);
            case "live_image":
                return this.image(args, origin);
            case "live_control":
                return this.control(args, origin);
            case "live_clear":
                return this.#clear(args);
            case "live_look":
                return this.look({ region: args.region });
            case "live_read":
                return this.read(args, origin);
            case "live_remember":
            case "live_recall":
            case "live_reopen":
                return this.memory(name, args, origin);
            case "live_speak":
                return this.#speak(args);
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    // Validates, snaps, scales and draws shapes, returning how many were drawn and snapped, the drawing time and any problems.
    async drawShapes(shapes, { clear = true, ttl, group } = {}) {
        const { scale } = this.geometry();
        const problems = [];
        const valid = [];
        for (const [index, shape] of (Array.isArray(shapes) ? shapes.slice(0, 40) : []).entries()) {
            const problem = validateShape(shape);
            if (problem) problems.push(`shape ${index + 1}: ${problem}`);
            else valid.push(shape);
        }
        if (!valid.length) return { drawn: 0, snapped: 0, duration: 0, problems };
        const placed = this.snap ? await this.snap(valid).catch(() => valid) : valid;
        const mapped = [];
        for (const shape of placed) {
            const out = { ...shapeToOverlay(shape, scale), id: cleanId(shape.id) || undefined };
            if (shape.kind === "lens") out.image = await this.regionImage(shape).catch(() => null);
            mapped.push(out);
        }
        const result = await this.overlayCall("annotate", { shapes: mapped, clear, ttl: ttl ?? this.config.annotationTtlSeconds, group });
        return { drawn: mapped.length, snapped: placed.filter((shape, index) => shape !== valid[index]).length, duration: result?.duration ?? 0, problems };
    }

    clearGroup(group) {
        return this.overlayCall("clear", { target: "annotations", group });
    }

    expireGroup(group, seconds) {
        return this.overlayCall("expire", { group, seconds });
    }

    async #annotate(args) {
        const ttl = Number.isFinite(args.ttl_seconds) ? Math.max(0, args.ttl_seconds) : undefined;
        const { drawn, snapped, problems } = await this.drawShapes(args.shapes, { clear: args.clear !== false, ttl });
        if (!drawn) return { text: `Nothing was drawn. ${problems.join("; ")}`, failed: true };
        const onto = snapped ? `, ${snapped} snapped onto the control${snapped === 1 ? "" : "s"} under ${snapped === 1 ? "it" : "them"}` : "";
        const skipped = problems.length ? ` Skipped invalid shapes: ${problems.join("; ")}.` : "";
        return { text: `Drew ${drawn} shape${drawn === 1 ? "" : "s"} on the user's screen${onto}.${skipped}` };
    }

    async #panel(args) {
        const kind = String(args.kind ?? "");
        if (!PANEL_KINDS.has(kind)) return { text: `Unknown panel kind "${kind}". Use markdown, mermaid, three, html, scene or board.`, failed: true };
        if (kind === "scene") return this.scene(args);
        if (kind === "board") return this.board(args);
        const content = String(args.content ?? "");
        if (!content.trim()) return { text: "Panel content is empty.", failed: true };
        if (content.length > MAX_PANEL_CHARS) return { text: `Panel content is too large (${content.length} characters).`, failed: true };
        return this.#showPanel(args, kind, content);
    }

    // Shows a motion-graphics scene; an explanation passes its per-step actions and drives the steps itself.
    async scene(args, steps = null) {
        const scene = args.scene;
        const actions = steps ?? (Array.isArray(scene?.steps) ? scene.steps : []);
        const problem = validateScene(scene, actions);
        if (problem) return { text: `The scene was not shown: ${problem}.`, failed: true };
        const objects = [];
        for (const object of scene.objects) {
            if (object.type !== "image") objects.push(object);
            else {
                try {
                    objects.push({ ...object, src: undefined, image: this.readImage(object.src) });
                } catch (error) {
                    return { text: `The scene was not shown: image "${object.id}": ${error.message}`, failed: true };
                }
            }
        }
        const content = JSON.stringify({ view: scene.view, camera: scene.camera, objects, steps: actions, autoplay: !steps, stepSeconds: scene.step_seconds, loop: scene.loop });
        return this.#showPanel(args, "scene", content);
    }

    // Shows a 2D motion-graphics board; as with scenes, an explanation passes its per-step actions.
    async board(args, steps = null) {
        const board = args.board;
        const actions = steps ?? (Array.isArray(board?.steps) ? board.steps : []);
        const problem = validateBoard(board, actions) ?? texProblem(board, actions);
        if (problem) return { text: `The board was not shown: ${problem}.`, failed: true };
        const content = JSON.stringify({ elements: board.elements, vars: board.vars, steps: actions, autoplay: !steps, stepSeconds: board.step_seconds, loop: board.loop });
        return this.#showPanel(args, "board", content);
    }

    sceneStep(id, index) {
        return this.overlayCall("scene-step", { id, index }).catch(() => {});
    }

    // Adds narrated steps to a stage already on screen, from step first on; board transforms whose TeX fails are dropped.
    async addSteps(id, steps, { board = null, first = 0 } = {}) {
        const problems = [];
        const kept = steps.map((actions, index) =>
            actions.filter((action) => {
                const bad = board && action?.do === "transform" && texProblem(board, [[action]]);
                if (bad) problems.push(`board step ${first + index + 1}: ${bad}`);
                return !bad;
            }),
        );
        await this.overlayCall("scene-steps", { id, steps: kept }).catch(() => {});
        return { problems };
    }

    async #showPanel(args, kind, content) {
        const { scale } = this.geometry();
        const id = cleanId(args.id) || `panel-${++this.#panelCount}`;
        const over = isRegion(args.over) ? args.over : null;
        const source = isRegion(args.image_region) ? args.image_region : over;
        const image = source && (kind === "three" || kind === "html") ? await this.regionImage(source).catch(() => null) : null;
        const title = String(args.title ?? "").slice(0, 120);
        const result = await this.overlayCall("panel", { id, kind, title, content, rect: panelRect(args, over, scale), frameless: Boolean(over), image }, 25_000);
        if (!result?.ok) {
            return { text: `The ${kind} panel "${id}" failed to render: ${result?.error ?? "unknown error"}. Fix it and call live_panel again with id "${id}".`, failed: true, id };
        }
        return { text: `Showing the ${kind} panel "${id}"${over ? " over the region" : ""} on the user's screen.`, id };
    }

    async #clear(args) {
        const target = ["annotations", "panels", "all"].includes(args.target) ? args.target : "all";
        const id = cleanId(args.id) || undefined;
        await this.overlayCall("clear", { target, id, scope: id ? undefined : "visible" });
        return { text: args.id ? `Removed "${args.id}".` : `Cleared ${target === "all" ? "drawings and panels" : target} from the page the user is looking at.` };
    }

    async #speak(args) {
        const text = String(args.text ?? "").trim().slice(0, 600);
        if (!text) return { text: "Nothing to say.", failed: true };
        await this.say(text);
        return { text: "Said it out loud on the user's screen." };
    }
}
