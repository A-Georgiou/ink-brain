// Plays narrated explanations: each step's drawings sketch in while its narration is spoken.
// A streamed call starts playing as soon as its stage and first step are written, while the rest are still coming.
import { playableBoardSteps } from "../shared/board.mjs";
import { playableSteps } from "../shared/scene.mjs";
import { ArgumentStream } from "../shared/stream.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
const MAX_STEPS = 12;
const spoken = (step) => (typeof step?.say === "string" ? step.say.trim().slice(0, 600) : "");

// Rough speaking time, used when the voice is off and as a safety timeout.
export const readingTime = (text) => Math.min(15_000, Math.max(1_200, String(text).trim().split(/\s+/).length * 340));

export function validateSteps(steps) {
    if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return "steps must be a list of 1 to 12 steps";
    const index = steps.findIndex((step) => !spoken(step));
    return index >= 0 ? `step ${index + 1} needs something to say` : null;
}

// Streamed fields are JSON; models sometimes nest an object as JSON text.
function objectOf(json) {
    const value = JSON.parse(json);
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

// One explanation on screen; streamed steps keep arriving while it plays.
class Run {
    stopped = null;
    stage = null;
    steps = [];
    lines = [];
    notes = [];
    #live = false;
    #ended = false;
    #arrived = () => {};

    constructor(id, speak) {
        this.id = id;
        this.speak = speak;
        this.halted = new Promise((resolve) => (this.wake = resolve));
    }

    add(step) {
        if (this.#ended || this.steps.length >= MAX_STEPS) return;
        this.steps.push(step);
        if (this.#live) this.#queue(this.steps.length - 1);
        this.#arrived();
    }

    end() {
        this.#ended = true;
        this.#arrived();
    }

    // Once the stage is up, narration is queued as each step arrives, so the voice prepares it while the previous one plays.
    goLive() {
        this.#live = true;
        this.steps.forEach((_, index) => this.#queue(index));
    }

    #queue(index) {
        const text = spoken(this.steps[index]);
        this.lines[index] = text ? this.speak(text, `explain-${this.id}-${index}`) : null;
    }

    // The step at index once it arrives, or null when there are no more.
    async next(index) {
        while (index >= this.steps.length && !this.#ended && !this.stopped) await Promise.race([new Promise((resolve) => (this.#arrived = resolve)), this.halted]);
        return this.stopped ? null : (this.steps[index] ?? null);
    }
}

export class ExplainPlayer {
    #run = null;
    #count = 0;
    #streams = new Map();
    #finished = new Set();

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

    // Reads a live_explain call's arguments as they stream in; returns true when the explanation starts playing.
    feed(callId, chunk) {
        if (this.#finished.has(callId)) return false;
        let stream = this.#streams.get(callId);
        if (!stream) this.#streams.set(callId, (stream = { reader: new ArgumentStream("steps"), head: {}, steps: [], run: null }));
        if (stream.broken) return false;
        try {
            for (const { key, json, item } of stream.reader.push(chunk)) {
                if (item) stream.steps.push(objectOf(json));
                else if (key === "title") stream.head.title = JSON.parse(json);
                else if (key === "scene" || key === "board") stream.head[key] = objectOf(json);
            }
        } catch {
            stream.broken = true;
            return false;
        }
        if (stream.run) {
            for (const step of stream.steps.splice(0)) stream.run.add(step);
            return false;
        }
        if (!spoken(stream.steps[0])) return false;
        stream.run = this.#begin(stream.head, stream.steps.splice(0));
        return true;
    }

    // Ends explanations whose call never finished, such as when the turn stopped; they play the steps they have.
    close() {
        for (const stream of this.#streams.values()) stream.run?.end();
        this.#streams.clear();
        this.#finished.clear();
    }

    // Plays a finished live_explain call; one already playing from its streamed arguments carries on with them.
    async play({ title, steps, scene, board }, callId) {
        const run = this.#streams.get(callId)?.run;
        this.#streams.delete(callId);
        if (callId) this.#finished.add(callId);
        if (run) {
            for (const step of (Array.isArray(steps) ? steps : []).slice(run.steps.length)) run.add(step);
            if (!run.stage && (scene || board)) run.notes.push("the board or scene came after the steps, so it was not shown; write it before the steps");
            run.end();
            return run.done;
        }
        const problem = validateSteps(steps);
        if (problem) return { text: `Nothing was explained: ${problem}.`, failed: true };
        const fresh = this.#begin({ title, scene, board }, steps);
        fresh.end();
        return fresh.done;
    }

    #begin(head, steps) {
        this.cancel("replaced");
        const run = new Run(++this.#count, this.speak);
        this.#run = run;
        for (const step of steps) run.add(step);
        run.done = this.#perform(run, head).finally(() => {
            if (this.#run === run) this.#run = null;
        });
        return run;
    }

    #playable(kind, spec, steps) {
        const actions = steps.map((step) => step?.[kind]);
        return kind === "scene" ? playableSteps(spec, actions) : playableBoardSteps(spec, actions);
    }

    // Sends the stage the actions of steps that arrived after it opened.
    async #extend(run) {
        const { stage } = run;
        const first = stage.sent;
        if (first >= run.steps.length) return;
        stage.sent = run.steps.length;
        const playable = this.#playable(stage.kind, stage.spec, run.steps);
        const labels = run.steps.slice(first).map((_, i) => `${stage.kind} step ${first + i + 1}:`);
        run.notes.push(...playable.dropped.filter((note) => labels.some((label) => note.startsWith(label))));
        const added = await this.surface.addSteps(stage.id, playable.steps.slice(first), { board: stage.kind === "board" ? stage.spec : null, first });
        run.notes.push(...added.problems);
    }

    async #perform(run, { title, scene, board }) {
        const group = `explain-${run.id}`;
        // The stage is a 3D scene or a 2D board, shown in a panel and stepped along with the narration.
        const kind = scene ? "scene" : board ? "board" : null;
        if (kind) {
            const spec = scene ?? board;
            const playable = this.#playable(kind, spec, run.steps);
            const placement = { x: spec.x, y: spec.y, width: spec.width, height: spec.height, over: spec.over };
            const shown = playable.problem ? { failed: true, text: playable.problem } : await this.surface[kind]({ id: `${group}-${kind}`, title: String(title ?? ""), ...placement, [kind]: spec }, playable.steps);
            if (shown.failed) return { text: `Nothing was explained, fix the ${kind} first: ${shown.text}`, failed: true };
            run.stage = { id: shown.id, kind, spec, sent: playable.steps.length };
            run.notes.push(...playable.dropped);
            if (scene && board) run.notes.push("the board was left out because a scene was given; use one stage per explanation");
        }
        this.caption({ type: "start", title: String(title ?? "").slice(0, 120), total: run.steps.length, scene: run.stage?.id ?? null });
        run.goLive();
        let completed = 0;
        try {
            for (let index = 0; index < MAX_STEPS; index++) {
                const step = await run.next(index);
                if (!step) break;
                const text = spoken(step);
                if (!text) {
                    run.notes.push(`step ${index + 1} had nothing to say, so it was skipped`);
                    continue;
                }
                if (run.stage) await this.#extend(run);
                const line = run.lines[index];
                if (line) await Promise.race([line.started, sleep(index === 0 ? 1_500 : 8_000), run.halted]);
                if (run.stopped) break;
                if (step.clear) await this.surface.clearGroup(group);
                const drawing = Array.isArray(step.draw) && step.draw.length ? await this.surface.drawShapes(step.draw, { clear: false, ttl: 0, group }) : { duration: 0, problems: [] };
                if (drawing.problems.length) run.notes.push(`step ${index + 1}: ${drawing.problems.join("; ")}`);
                if (step.panel) {
                    const shown = await this.surface.execute("live_panel", step.panel);
                    if (shown.failed) run.notes.push(`step ${index + 1} panel: ${shown.text}`);
                }
                if (run.stage) await this.surface.sceneStep(run.stage.id, index);
                this.caption({ type: "step", index, total: run.steps.length, text });
                const said = line ? Promise.race([line.ended, sleep(readingTime(text) * 3 + 15_000)]) : Promise.all([sleep(readingTime(text)), sleep(drawing.duration)]);
                await Promise.race([said, run.halted]);
                if (run.stopped) break;
                completed = index + 1;
                if (!line) await Promise.race([sleep(300), run.halted]);
            }
        } finally {
            this.caption({ type: "end", stopped: Boolean(run.stopped) });
            this.surface.expireGroup(group, this.keepSeconds).catch(() => {});
        }
        const total = run.steps.length;
        const summary = run.stopped
            ? `The user interrupted the explanation after ${completed} of ${total} steps.`
            : `Narrated all ${total} steps on the user's screen; the drawings stay up for a while.`;
        return { text: run.notes.length ? `${summary} Some drawings or scene actions were skipped: ${run.notes.join(" | ")}` : summary };
    }
}
