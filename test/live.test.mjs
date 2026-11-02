import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ExplainPlayer } from "../src/main/explain.mjs";
import { clearStaleGrants } from "../src/main/helper.mjs";
import { Voice } from "../src/main/voice.mjs";

function explainer() {
    const log = [];
    const lines = [];
    const surface = {
        drawShapes: async (shapes, options) => {
            log.push(`draw ${shapes.length} ${options.group}`);
            return { drawn: shapes.length, duration: 0, problems: [] };
        },
        clearGroup: async (group) => log.push(`clear ${group}`),
        expireGroup: async (group) => log.push(`expire ${group}`),
        execute: async () => ({ text: "ok" }),
        scene: async (args, steps) => (log.push(`scene ${args.id} ${steps.map((actions) => actions.length)}`), { text: "ok", id: args.id }),
        board: async (args, steps) => (log.push(`board ${args.id} ${steps.map((actions) => actions.length)}`), { text: "ok", id: args.id }),
        sceneStep: async (id, index) => log.push(`step ${id} ${index}`),
    };
    const speak = (text) => {
        const line = {};
        line.started = new Promise((resolve) => (line.start = () => (log.push(`start ${text}`), resolve())));
        line.ended = new Promise((resolve) => (line.end = () => (log.push(`end ${text}`), resolve())));
        lines.push(line);
        return line;
    };
    const player = new ExplainPlayer({ surface, speak, caption: () => {} });
    return { player, log, lines };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("explanations queue all narration up front and draw each step as its narration starts", async () => {
    const { player, log, lines } = explainer();
    const played = player.play({ steps: [{ say: "First", draw: [{ kind: "pulse", x: 1, y: 1 }] }, { say: "Second", clear: true }] });
    await tick();
    assert.equal(lines.length, 2);
    assert.deepEqual(log, []);
    lines[0].start();
    await tick();
    assert.deepEqual(log, ["start First", "draw 1 explain-1"]);
    lines[0].end();
    lines[1].start();
    await tick();
    assert.deepEqual(log.slice(2), ["end First", "start Second", "clear explain-1"]);
    lines[1].end();
    assert.match((await played).text, /Narrated all 2 steps/);
    assert.equal(log.at(-1), "expire explain-1");
});

test("a scene explanation opens the scene once and advances it as each step is spoken, skipping only broken actions", async () => {
    const { player, log, lines } = explainer();
    const scene = { objects: [{ id: "piston", type: "cylinder" }] };
    const steps = [
        { say: "Down", scene: [{ do: "move", target: "piston", by: [0, -1, 0] }] },
        { say: "Up", scene: [{ do: "spin", target: "valve" }] },
    ];
    const played = player.play({ scene, steps });
    await tick();
    assert.deepEqual(log, ["scene explain-1-scene 1,0"]);
    lines[0].start();
    await tick();
    assert.deepEqual(log.slice(1), ["start Down", "step explain-1-scene 0"]);
    lines[0].end();
    lines[1].start();
    await tick();
    assert.deepEqual(log.slice(3), ["end Down", "start Up", "step explain-1-scene 1"]);
    lines[1].end();
    assert.match((await played).text, /scene step 2: spin targets unknown object "valve"/);
});

test("a board explanation opens the board and steps it with the narration, dropping only broken actions", async () => {
    const { player, log, lines } = explainer();
    const board = { elements: [{ id: "eq", type: "tex", tex: "\\part{a}{x} = 1" }] };
    const played = player.play({ board, steps: [{ say: "Look", board: [{ do: "highlight", target: "eq.a" }, { do: "color", target: "eq.b" }] }] });
    await tick();
    assert.deepEqual(log, ["board explain-1-board 1"]);
    lines[0].start();
    await tick();
    assert.deepEqual(log.slice(1), ["start Look", "step explain-1-board 0"]);
    lines[0].end();
    assert.match((await played).text, /board step 1: color targets "eq.b", but "eq" has no \\part\{b\}/);
});

test("interrupting an explanation stops it and reports how far it got", async () => {
    const { player } = explainer();
    const played = player.play({ steps: [{ say: "One" }, { say: "Two" }] });
    await tick();
    player.cancel();
    assert.match((await played).text, /interrupted the explanation after 0 of 2 steps/);
});

test("stale grant cleanup never clears a granted permission or the ones macOS re-prompts for", async () => {
    const cleared = [];
    const reset = async (service) => cleared.push(service);
    await clearStaleGrants({ screen: "missing", control: "granted", microphone: "denied", speech: "notDetermined" }, reset);
    await clearStaleGrants({ screen: "granted", control: "missing", microphone: "granted", speech: "granted" }, reset);
    assert.deepEqual(cleared, ["ScreenCapture", "PostEvent"]);
});

function voice() {
    const helper = new EventEmitter();
    const requests = [];
    helper.request = async (method, params) => requests.push([method, params?.utterance]);
    const worker = new EventEmitter();
    worker.sent = [];
    worker.postMessage = (message) => worker.sent.push(message);
    worker.kill = () => {};
    const v = new Voice({ helper, config: { voice: { engine: "neural", neuralVoice: "af_heart" } }, fork: () => worker, modelsDir: "/tmp" });
    const ends = [];
    v.on("end", (event) => ends.push(event));
    v.start();
    worker.emit("message", { type: "ready" });
    return { v, helper, worker, requests, ends };
}

test("the neural voice stays busy until every queued sentence has played", () => {
    const { v, helper, worker, requests, ends } = voice();
    v.speak("One.", "u1");
    v.speak("Two.", "u2");
    worker.emit("message", { type: "audio", id: "u1", sampleRate: 24000, pcm: new Int16Array([1, 2]) });
    helper.emit("tts.end", { utterance: "u1", idle: true });
    assert.deepEqual(requests, [["play", "u1"]]);
    assert.deepEqual(ends.at(-1), { utterance: "u1", cancelled: false, idle: false });
    worker.emit("message", { type: "error", id: "u2", message: "boom" });
    assert.deepEqual(requests.at(-1), ["speak", "u2"]);
});

test("stopping the voice cancels sentences that are still being generated", () => {
    const { v, worker, requests, ends } = voice();
    v.speak("One.", "u1");
    v.stop();
    worker.emit("message", { type: "audio", id: "u1", sampleRate: 24000, pcm: new Int16Array([1]) });
    assert.deepEqual(ends, [{ utterance: "u1", cancelled: true, idle: true }]);
    assert.equal(worker.sent.at(-1).type, "cancel");
    assert.deepEqual(requests, [["speak.stop", undefined]]);
});
