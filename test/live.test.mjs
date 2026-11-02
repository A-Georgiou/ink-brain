import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { clearStaleGrants } from "../src/main/helper.mjs";
import { Voice } from "../src/main/voice.mjs";

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
