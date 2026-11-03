import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolCalls } from "../src/main/brain.mjs";
import { Controller } from "../src/main/control.mjs";
import { ExplainPlayer } from "../src/main/explain.mjs";
import { createCheckWaiter, describeAnswer, normalizeCheck, validateCheck } from "../src/main/tutor.mjs";
import { clearStaleGrants } from "../src/main/helper.mjs";
import { readImageFile } from "../src/main/images.mjs";
import { Voice } from "../src/main/voice.mjs";

test("images can only be read from Copilot's own image folders", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ink-brain-images-"));
    const allowed = path.join(root, "session-state");
    fs.mkdirSync(path.join(allowed, "s1", "images"), { recursive: true });
    const image = path.join(allowed, "s1", "images", "render.png");
    fs.writeFileSync(image, "png");
    fs.writeFileSync(path.join(allowed, "s1", "events.jsonl"), "{}");
    fs.writeFileSync(path.join(root, "outside.png"), "png");
    fs.symlinkSync(path.join(root, "outside.png"), path.join(allowed, "s1", "images", "link.png"));

    assert.equal(readImageFile(image, [allowed]), `data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    assert.throws(() => readImageFile(path.join(root, "outside.png"), [allowed]), /Only images made by/);
    assert.throws(() => readImageFile(path.join(allowed, "s1", "images", "link.png"), [allowed]), /Only images made by/);
    assert.throws(() => readImageFile(path.join(allowed, "s1", "events.jsonl"), [allowed]), /Only PNG, JPEG and WebP/);
});

function explainer(caption = () => {}) {
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
        addSteps: async (id, steps) => (log.push(`add ${id} ${steps.map((actions) => actions.length)}`), { problems: [] }),
    };
    const speak = (text) => {
        const line = {};
        line.started = new Promise((resolve) => (line.start = () => (log.push(`start ${text}`), resolve())));
        line.ended = new Promise((resolve) => (line.end = () => (log.push(`end ${text}`), resolve())));
        lines.push(line);
        return line;
    };
    const player = new ExplainPlayer({ surface, speak, caption, hush: () => log.push("hush") });
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

test("a streamed explanation starts once its stage and first step are written, and later steps join as they arrive", async () => {
    const { player, log, lines } = explainer();
    const move = (y) => [{ do: "move", target: "piston", by: [0, y, 0] }];
    const args = { title: "Strokes {1} and [2]", scene: { objects: [{ id: "piston", type: "cylinder" }] }, steps: [{ say: "Down", scene: move(-1) }, { say: "Up", scene: move(1) }] };
    const text = JSON.stringify(args);
    const cut = text.indexOf('{"say":"Up"');
    assert.equal([...text.slice(0, cut)].map((c) => player.feed("call-1", c)).filter(Boolean).length, 1);
    await tick();
    assert.deepEqual(log, ["scene explain-1-scene 1"]);
    lines[0].start();
    await tick();
    assert.deepEqual(log.slice(1), ["start Down", "step explain-1-scene 0"]);
    for (const c of text.slice(cut)) player.feed("call-1", c);
    const played = player.play(args, "call-1");
    lines[0].end();
    lines[1].start();
    await tick();
    assert.deepEqual(log.slice(3), ["end Down", "start Up", "add explain-1-scene 1", "step explain-1-scene 1"]);
    lines[1].end();
    assert.match((await played).text, /Narrated all 2 steps/);
});

test("a streamed explanation whose call never finishes plays the steps it has once the turn closes", async () => {
    const { player, log, lines } = explainer();
    const text = JSON.stringify({ title: "t", steps: [{ say: "Only" }, { say: "Cut off" }] });
    player.feed("call-2", text.slice(0, text.indexOf("Cut off")));
    await tick();
    lines[0].start();
    lines[0].end();
    player.close();
    await tick();
    await tick();
    assert.equal(log.at(-1), "expire explain-1");
});

test("an explanation can be paused, and replay speaks the step again", async () => {
    const events = [];
    const { player, lines } = explainer((event) => events.push(event));
    const played = player.play({ steps: [{ say: "First" }, { say: "Second" }] });
    await tick();
    assert.equal(events.find((event) => event.type === "start").controls, true);
    lines[0].start();
    await tick();
    player.control("pause");
    lines[0].end();
    await tick();
    let done = false;
    played.then(() => (done = true));
    await tick();
    assert.equal(done, false);
    player.control("replay");
    await tick();
    assert.equal(lines.length, 3);
    lines[2].start();
    await tick();
    lines[2].end();
    await tick();
    lines[1].start();
    await tick();
    lines[1].end();
    assert.match((await played).text, /Narrated all 2 steps/);
});

test("resume repeats the interrupted line and next hushes before moving on", async () => {
    const { player, lines, log } = explainer();
    const played = player.play({ steps: [{ say: "First" }, { say: "Second" }] });
    await tick();
    lines[0].start();
    await tick();
    player.control("pause");
    await tick();
    player.control("resume");
    await tick();
    assert.equal(lines.length, 3);
    assert.ok(log.includes("hush"));
    lines[2].start();
    await tick();
    lines[2].end();
    await tick();
    player.control("next");
    assert.ok(log.filter((line) => line === "hush").length >= 2);
    lines[1].start();
    await tick();
    lines[1].end();
    assert.match((await played).text, /Narrated all 2 steps/);
});

test("a check names the misconception behind a spoken wrong answer", async () => {
    const check = normalizeCheck({ question: "Where does it land?", choices: [{ label: "On zero", misconception: "they think the point is the origin" }, { label: "On minus one", correct: true }] });
    assert.equal(validateCheck({ question: "Where?", choices: [{ label: "Only one" }] }), "live_check needs 2 to 4 choices with labels");
    assert.equal(validateCheck(check), null);
    const waiter = createCheckWaiter({ show: async () => {}, pick: () => {}, timeoutMs: 50 });
    const pending = waiter.ask(check);
    await tick();
    assert.equal(waiter.answerText("it lands on zero"), true);
    assert.match(describeAnswer(check, await pending), /origin/);
});

test("interrupting an explanation stops it and reports how far it got", async () => {
    const { player } = explainer();
    const played = player.play({ steps: [{ say: "One" }, { say: "Two" }] });
    await tick();
    player.cancel();
    assert.match((await played).text, /interrupted the explanation after 0 of 2 steps/);
});

function controller({ decision = "once", moves = [] } = {}) {
    const acts = [];
    const asks = [];
    const positions = [{ x: 0, y: 0 }, ...moves];
    const helper = {
        request: async (method, params) => {
            if (method === "input.status") return { allowed: true, ...(positions.length > 1 ? positions.shift() : positions[0]) };
            if (method === "input.act") {
                acts.push(params.action);
                return { x: params.x ?? 0, y: params.y ?? 0 };
            }
            return {};
        },
    };
    const control = new Controller({
        helper,
        config: { control: "ask" },
        look: async () => ({ text: "screen", images: [] }),
        approve: async (request) => (asks.push(request.origin.label), decision),
        setControlling: () => {},
        toScreen: (x, y) => ({ x, y }),
        showPointer: () => {},
    });
    return { control, acts, asks };
}

const click = { action: "click", x: 0, y: 0 };

test("control does nothing unless the user approves, and remembers approval only for that caller", async () => {
    const denied = controller({ decision: "deny" });
    assert.equal((await denied.control.run({ reason: "r", actions: [click] })).failed, true);
    assert.deepEqual(denied.acts, []);

    const allowed = controller({ decision: "always" });
    await allowed.control.run({ reason: "r", actions: [click] }, { id: "cli", label: "CLI" });
    await allowed.control.run({ reason: "r", actions: [click] }, { id: "cli", label: "CLI" });
    await allowed.control.run({ reason: "r", actions: [click] }, { id: "other", label: "Other" });
    assert.deepEqual(allowed.asks, ["CLI", "Other"]);
    assert.deepEqual(allowed.acts, ["click", "click", "click"]);
});

test("control stops as soon as the user moves the mouse", async () => {
    const { control, acts } = controller({ moves: [{ x: 0, y: 0 }, { x: 200, y: 50 }] });
    const result = await control.run({ reason: "r", actions: [click, { action: "type", text: "hi" }] });
    assert.deepEqual(acts, ["click"]);
    assert.match(result.text, /Stopped after 1 of 2 actions because the user moved the mouse/);
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

test("spoken speed is the configured speed times the pace factor", () => {
    const { v, worker } = voice();
    v.config.voice.speed = 1.25;
    v.speak("One.", "u1");
    v.speak("Slow.", "u2", 0.5);
    assert.equal(worker.sent.find((message) => message.id === "u1").speed, 1.25);
    assert.equal(worker.sent.find((message) => message.id === "u2").speed, 0.625);
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

test("tool calls whose request or answer got lost are answered again, once each", async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let runs = 0;
    const calls = new ToolCalls([{ name: "live_read", handler: async () => `read ${++runs}` }], { graceMs: 30 });
    const answered = [];
    const pending = [{ requestId: "lost-request", toolCallId: "c1", toolName: "live_read", arguments: {} }];
    const session = { rpc: { tools: { listPendingRequests: async () => ({ items: pending }), handlePendingToolCall: async (answer) => answered.push(answer) } } };

    await calls.rescue(session);
    assert.equal(answered.length, 0);
    await sleep(40);
    await calls.rescue(session);
    assert.deepEqual(answered, [{ requestId: "lost-request", result: "read 1" }]);

    pending[0] = { ...pending[0], requestId: "lost-answer" };
    assert.equal(await calls.tools[0].handler({}, { requestId: "lost-answer" }), "read 2");
    await calls.rescue(session);
    await sleep(40);
    await calls.rescue(session);
    assert.deepEqual(answered.at(-1), { requestId: "lost-answer", result: "read 2" });
    assert.equal(runs, 2);
});

test("a follow-up explanation carries on with the stage it is given and says which one that is", async () => {
    const { player, log, lines } = explainer();
    const board = { elements: [{ id: "eq", type: "tex", tex: "x = 1" }] };
    const first = player.play({ board, steps: [{ say: "Here" }] });
    await tick();
    lines[0].start();
    lines[0].end();
    assert.match((await first).text, /the panel "explain-1-board": to carry on, pass that id/);
    const again = player.play({ id: "explain-1-board", board, steps: [{ say: "Again" }] });
    await tick();
    assert.deepEqual(log.filter((line) => line.startsWith("board ")), ["board explain-1-board 0", "board explain-1-board 0"]);
    lines[1].start();
    lines[1].end();
    await again;
});

test("an explanation given only a stage id plays on it from where it stopped, without building it again", async () => {
    const { player, log, lines } = explainer();
    const scene = { objects: [{ id: "cage", type: "box" }] };
    const first = player.play({ scene, steps: [{ say: "One" }, { say: "Two" }] });
    await tick();
    for (const line of lines.slice(0, 2)) {
        line.start();
        line.end();
        await tick();
    }
    await first;
    log.length = 0;
    const more = player.play({ id: "explain-1-scene", steps: [{ say: "Slower", scene: [{ do: "spin", target: "cage" }] }] });
    await tick();
    lines[2].start();
    lines[2].end();
    const result = await more;
    assert.deepEqual(log.filter((line) => !line.startsWith("start") && !line.startsWith("end")), ["add explain-1-scene 1", "step explain-1-scene 2", "expire explain-2"]);
    assert.doesNotMatch(result.text, /no stage/);
    assert.match((await player.play({ id: "nope", steps: [{ say: "Hm" }] }, "x")).text, /there is no stage "nope" to carry on with/);
});
