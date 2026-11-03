import { validateBoard } from "../shared/board.mjs";
import { validateScene } from "../shared/scene.mjs";

function sceneVisible(spec, complete) {
    const objects = spec.objects;
    const byId = new Map(objects.map((object) => [object.id, object]));
    const cutters = new Set(objects.flatMap((object) => object.cut ?? []));
    return objects.some((object) => {
        if (object.type === "group" || (object.type === "text" && !object.text?.trim())) return false;
        // A faint outline or bare construction cutter is not a useful first visual.
        const described = (typeof object.label === "string" && object.label.trim()) || ["text", "base", "loft", "lathe", "part"].includes(object.type);
        if ((!complete && !described) || (Number.isFinite(object.opacity) && object.opacity < 0.35)) return false;
        const seen = new Set();
        for (let node = object; node; node = byId.get(node.on ?? node.parent)) {
            if (cutters.has(node.id) || seen.has(node) || node.hidden || node.opacity === 0) return false;
            seen.add(node);
        }
        return true;
    });
}

function boardVisible(spec) {
    return spec.elements.some((element) => {
        if (element.hidden || (Number.isFinite(element.opacity) && element.opacity < 0.35)) return false;
        if (["text", "axes"].includes(element.type)) return false;
        return ["tex", "plot", "area", "vector", "tangent"].includes(element.type)
            || (element.type === "path" && element.closed)
            || [element.text, element.tex, element.label].some((text) => typeof text === "string" && text.trim());
    });
}

// Coalesces valid stage prefixes; doubling their size avoids rebuilding for every token or tiny part.
export class StagePreview {
    #latest = null;
    #pending = null;
    #shown = null;
    #count = 0;
    #stopped = false;
    #controller = new AbortController();

    constructor(id, surface, kind) {
        this.id = id;
        this.surface = surface;
        this.kind = kind;
        this.list = kind === "board" ? "elements" : "objects";
        this.pictures = new Map();
    }

    offer(spec, title, complete = false) {
        if (this.#stopped) return;
        try {
            if (this.kind === "board" ? validateBoard(spec) || !boardVisible(spec) : validateScene(spec) || !sceneVisible(spec, complete)) return;
        } catch {
            return;
        }
        const count = spec[this.list].length;
        if (!complete && count < Math.max(1, this.#count * 2)) return;
        this.#count = count;
        this.#latest = { title, complete, spec: complete ? spec : { ...spec, [this.list]: [...spec[this.list]] } };
        this.#pending ??= this.#drain().finally(() => (this.#pending = null));
    }

    async #drain() {
        while (this.#latest && !this.#stopped) {
            const { title, spec, complete } = this.#latest;
            this.#latest = null;
            const id = `explain-${this.id}-${this.kind}`;
            const result = await this.surface[this.kind]({ ...spec, id, title, building: !complete, [this.kind]: spec }, [], this.pictures, this.#controller.signal).catch(() => ({ failed: true }));
            if (result.failed) {
                this.#shown = this.#latest = null;
                this.#stopped = true;
                await this.#clear();
            } else this.#shown = { id: result.id, kind: this.kind, title, spec };
        }
    }

    async stop(clear = false) {
        this.#stopped = true;
        this.#latest = null;
        if (clear) this.#controller.abort();
        const pending = this.#pending;
        if (clear) await this.#clear();
        await pending;
        if (clear && pending) await this.#clear();
        return this.#shown;
    }

    async #clear() {
        await this.surface.execute("live_clear", { target: "panels", id: `explain-${this.id}-${this.kind}` }).catch(() => {});
    }
}
