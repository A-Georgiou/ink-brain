// Plays narrated explanations: each step's drawings sketch in while its narration is spoken.
import { playableBoardSteps } from "../shared/board.mjs";
import { playableSteps } from "../shared/scene.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// Rough speaking time, used when the voice is off and as a safety timeout.
export const readingTime = (text) => Math.min(15_000, Math.max(1_200, String(text).trim().split(/\s+/).length * 340));

export function validateSteps(steps) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 12) return "steps must be a list of 1 to 12 steps";
    const index = steps.findIndex((step) => typeof step?.say !== "string" || !step.say.trim());
    return index >= 0 ? `step ${index + 1} needs something to say` : null;
}

export class ExplainPlayer {
    #run = null;
    #count = 0;

    // speak(text, utterance) queues narration and returns { started, ended } promises, or null with no voice.
    constructor({ surface, speak, caption, keepSeconds = 90 }) {
        this.surface = surface;
        this.speak = speak;
        this.caption = caption;
        this.keepSeconds = keepSeconds;
    }

    cancel(reason = "interrupted") {
        if (!this.#run || this.#run.stopped) return;
        this.#run.stopped = reason;
        this.#run.wake();
    }

    async play({ title, steps, scene, board }) {
        const problem = validateSteps(steps);
        if (problem) return { text: `Nothing was explained: ${problem}.`, failed: true };
        this.cancel("replaced");
        let wake;
        const stopped = new Promise((resolve) => (wake = resolve));
        const run = { id: ++this.#count, stopped: null, wake };
        this.#run = run;
        const group = `explain-${run.id}`;
        const notes = [];
        let completed = 0;
        let stage = null;
        // The stage is a 3D scene or a 2D board, shown in a panel and stepped along with the narration.
        const kind = scene ? "scene" : board ? "board" : null;
        if (kind) {
            const spec = scene ?? board;
            const playable = scene ? playableSteps(scene, steps.map((step) => step.scene)) : playableBoardSteps(board, steps.map((step) => step.board));
            const placement = { x: spec.x, y: spec.y, width: spec.width, height: spec.height, over: spec.over };
            const shown = playable.problem ? { failed: true, text: playable.problem } : await this.surface[kind]({ id: `${group}-${kind}`, title: String(title ?? ""), ...placement, [kind]: spec }, playable.steps);
            if (shown.failed) {
                if (this.#run === run) this.#run = null;
                return { text: `Nothing was explained, fix the ${kind} first: ${shown.text}`, failed: true };
            }
            stage = shown.id;
            notes.push(...playable.dropped);
            if (scene && board) notes.push("the board was left out because a scene was given; use one stage per explanation");
        }
        this.caption({ type: "start", title: String(title ?? "").slice(0, 120), total: steps.length, scene: stage });
        // Queue all narration up front so the voice can prepare each step while the previous one plays.
        const lines = steps.map((step, index) => this.speak(step.say.trim().slice(0, 600), `${group}-${index}`));
        try {
            for (const [index, step] of steps.entries()) {
                if (run.stopped) break;
                const line = lines[index];
                if (line) await Promise.race([line.started, sleep(index === 0 ? 1_500 : 8_000), stopped]);
                if (run.stopped) break;
                if (step.clear) await this.surface.clearGroup(group);
                const drawing = Array.isArray(step.draw) && step.draw.length ? await this.surface.drawShapes(step.draw, { clear: false, ttl: 0, group }) : { duration: 0, problems: [] };
                if (drawing.problems.length) notes.push(`step ${index + 1}: ${drawing.problems.join("; ")}`);
                if (step.panel) {
                    const shown = await this.surface.execute("live_panel", step.panel);
                    if (shown.failed) notes.push(`step ${index + 1} panel: ${shown.text}`);
                }
                if (stage) await this.surface.sceneStep(stage, index);
                this.caption({ type: "step", index, total: steps.length, text: step.say.trim().slice(0, 600) });
                const said = line ? Promise.race([line.ended, sleep(readingTime(step.say) * 3 + 15_000)]) : Promise.all([sleep(readingTime(step.say)), sleep(drawing.duration)]);
                await Promise.race([said, stopped]);
                if (run.stopped) break;
                completed = index + 1;
                if (!line) await Promise.race([sleep(300), stopped]);
            }
        } finally {
            if (this.#run === run) this.#run = null;
            this.caption({ type: "end", stopped: Boolean(run.stopped) });
            this.surface.expireGroup(group, this.keepSeconds).catch(() => {});
        }
        const summary = run.stopped
            ? `The user interrupted the explanation after ${completed} of ${steps.length} steps.`
            : `Narrated all ${steps.length} steps on the user's screen; the drawings stay up for a while.`;
        return { text: notes.length ? `${summary} Some drawings or scene actions were skipped: ${notes.join(" | ")}` : summary };
    }
}
