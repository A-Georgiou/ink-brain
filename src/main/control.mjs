// Operates the Mac once approved: one visible action at a time, stopped by Esc or moving the mouse.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ACTIONS = new Set(["click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "wait"]);
const POINTER_ACTIONS = new Set(["click", "double_click", "right_click", "move", "drag"]);
const finite = (...values) => values.every(Number.isFinite);

export function validateActions(actions) {
    if (!Array.isArray(actions) || !actions.length || actions.length > 12) return "actions must be a list of 1 to 12 actions";
    for (const [index, action] of actions.entries()) {
        const where = `action ${index + 1}`;
        if (!ACTIONS.has(action?.action)) return `${where} has an unknown action "${action?.action}"`;
        if (POINTER_ACTIONS.has(action.action) && !finite(action.x, action.y)) return `${where} (${action.action}) needs x and y`;
        if (action.action === "drag" && !(Array.isArray(action.to) && finite(action.to[0], action.to[1]))) return `${where} (drag) needs to as [x, y]`;
        if (action.action === "type" && typeof action.text !== "string") return `${where} (type) needs text`;
        if (action.action === "key" && typeof action.keys !== "string") return `${where} (key) needs keys`;
        if (action.action === "scroll" && !finite(action.dx ?? 0, action.dy ?? 0)) return `${where} (scroll) needs dx or dy`;
    }
    return null;
}

export class Controller {
    #stop = null;
    #allowed = new Set();

    // approve(request) resolves to "once", "always" or "deny"; setControlling(on) shows the stop banner.
    constructor({ helper, toScreen, showPointer, approve, setControlling, look, config, beforeAction = () => {} }) {
        Object.assign(this, { helper, toScreen, showPointer, approve, setControlling, look, config, beforeAction });
    }

    get active() {
        return this.#stop !== null;
    }

    stop(reason) {
        if (this.#stop && !this.#stop.reason) this.#stop.reason = reason;
    }

    forget(originId) {
        if (originId) this.#allowed.delete(originId);
        else this.#allowed.clear();
    }

    // origin ({ id, label }) is who asked, so "allow for this conversation" applies to that caller only.
    async run({ reason, actions }, origin = { id: "standalone", label: "Ink Brain" }) {
        if (this.config.control === "off") return { text: "Taking control is turned off in the user's Ink Brain settings. Explain the steps instead.", failed: true };
        const problem = validateActions(actions);
        if (problem) return { text: `Nothing was done: ${problem}.`, failed: true };
        const status = await this.helper.request("input.status");
        if (!status.allowed) {
            this.helper.request("input.request").catch(() => {});
            return { text: "Ink Brain is not yet allowed to control this Mac. The user has been asked to allow it in System Settings > Privacy & Security > Accessibility; explain the steps for now.", failed: true };
        }
        if (!this.#allowed.has(origin.id)) {
            const decision = await this.approve({ origin, reason: String(reason ?? "").slice(0, 300), actions });
            if (decision === "deny") return { text: "The user did not allow you to take control. Explain the steps instead, or ask what they would like.", failed: true };
            if (decision === "always") this.#allowed.add(origin.id);
        }
        const run = { reason: null };
        this.#stop = run;
        this.setControlling(true);
        let last = status;
        let done = 0;
        try {
            for (const action of actions) {
                if (run.reason) break;
                const now = await this.helper.request("input.status");
                if (Math.hypot(now.x - last.x, now.y - last.y) > 6) {
                    run.reason = "the user moved the mouse";
                    break;
                }
                if (action.action === "wait") await sleep(Math.min(5_000, Math.max(0, action.ms ?? 500)));
                else last = await this.#perform(action);
                done++;
                await sleep(action.action === "type" ? 250 : 350);
            }
        } catch (error) {
            run.reason = error.message;
        } finally {
            this.#stop = null;
            this.setControlling(false);
        }
        await sleep(450);
        const view = await this.look({});
        const summary = run.reason ? `Stopped after ${done} of ${actions.length} actions because ${run.reason}.` : `Did all ${actions.length} actions.`;
        return { text: `${summary} ${view.text}`, images: view.images, failed: Boolean(run.reason) && done === 0 };
    }

    // Shows the pointer, performs one action and resolves to the helper's status afterwards.
    #perform(action) {
        const params = { action: action.action, text: action.text, keys: action.keys, dx: action.dx ?? 0, dy: action.dy ?? 0 };
        if (finite(action.x, action.y)) {
            Object.assign(params, this.toScreen(action.x, action.y));
            this.showPointer(action.x, action.y, action.label ?? "", action.action.endsWith("click"));
        }
        if (action.action === "drag") {
            const end = this.toScreen(...action.to);
            Object.assign(params, { toX: end.x, toY: end.y });
        }
        this.beforeAction(action);
        return this.helper.request("input.act", params, { timeoutMs: 60_000 });
    }
}
