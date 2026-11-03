import { isRegion } from "../shared/geometry.mjs";
import { validateScene } from "../shared/scene.mjs";

function visible(spec, complete) {
    const objects = spec.objects;
    const byId = new Map(objects.map((object) => [object.id, object]));
    const cutters = new Set(objects.flatMap((object) => object.cut ?? []));
    return objects.some((object) => {
        if (object.type === "group" || (object.type === "text" && !object.text?.trim())) return false;
        // A faint outline or bare construction cutter is not a useful first visual.
        const described = (typeof object.label === "string" && object.label.trim()) || object.type === "text" || (["base", "loft"].includes(object.type) && isRegion(object.region));
        if ((!complete && !described) || (Number.isFinite(object.opacity) && object.opacity < 0.35)) return false;
        const seen = new Set();
        for (let node = object; node; node = byId.get(node.on ?? node.parent)) {
            if (cutters.has(node.id) || seen.has(node) || node.hidden || node.opacity === 0) return false;
            seen.add(node);
        }
        return true;
    });
}

// Coalesces valid scene prefixes; doubling their size avoids rebuilding for every token or tiny part.
export class ScenePreview {
    #latest = null;
    #pending = null;
    #shown = null;
    #count = 0;
    #stopped = false;
    #controller = new AbortController();

    constructor(id, surface) {
        this.id = id;
        this.surface = surface;
        this.pictures = new Map();
    }

    offer(spec, title, complete = false) {
        if (this.#stopped) return;
        try {
            if (validateScene(spec) || !visible(spec, complete)) return;
        } catch {
            return;
        }
        const count = spec.objects.length;
        if (!complete && count < Math.max(1, this.#count * 2)) return;
        this.#count = count;
        this.#latest = { title, complete, spec: complete ? spec : { ...spec, objects: [...spec.objects] } };
        this.#pending ??= this.#drain().finally(() => (this.#pending = null));
    }

    async #drain() {
        while (this.#latest && !this.#stopped) {
            const { title, spec, complete } = this.#latest;
            this.#latest = null;
            const id = `explain-${this.id}-scene`;
            const result = await this.surface.scene({ ...spec, id, title, building: !complete, scene: spec }, [], this.pictures, this.#controller.signal).catch(() => ({ failed: true }));
            if (result.failed) {
                this.#shown = this.#latest = null;
                this.#stopped = true;
                await this.#clear();
            } else this.#shown = { id: result.id, kind: "scene", title, spec };
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
        await this.surface.execute("live_clear", { target: "panels", id: `explain-${this.id}-scene` }).catch(() => {});
    }
}
