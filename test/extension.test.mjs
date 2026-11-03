import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.INK_BRAIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ib-"));
const { Bridge } = await import("../src/main/bridge.mjs");
const { LinkedBrain } = await import("../src/main/brain.mjs");
const { start } = await import("../extension/ink-brain.mjs");

class FakeSession extends EventEmitter {
    sessionId = "session-1";
    sent = [];
    aborts = 0;
    on(type, handler) {
        super.on(type, handler);
        return () => this.off(type, handler);
    }
    async send(options) {
        this.sent.push(options);
        return "message-1";
    }
    async abort() {
        this.aborts++;
    }
    async log() {}
    fire(type, data = {}, envelope = {}) {
        this.emit(type, { type, data, ...envelope });
    }
}

const overlayPrompt = (turn) => `what is this?\n<ink_brain_context turn="${turn}">\n</ink_brain_context>`;

// Starts a bridge and a session extension linked to it, returning the overlay's view of that session.
async function link(t, onTool = async () => ({ text: "ok" })) {
    const bridge = new Bridge({ onTool });
    await bridge.start();
    t.after(() => bridge.stop());
    const session = new FakeSession();
    let tools;
    const hello = once(bridge, "hello");
    const extension = await start({
        joinSession: async (config) => {
            tools = config.tools;
            return session;
        },
        autoLaunch: false,
    });
    t.after(() => extension.stop());
    const [peer] = await hello;
    return { session, tools, brain: new LinkedBrain(peer) };
}

test("session extension tools reach the overlay and overlay questions run in the linked session", async (t) => {
    const toolCalls = [];
    const { session, tools, brain } = await link(t, async (name, args, peer) => {
        toolCalls.push({ name, args, label: peer.label });
        return { text: "drawn", images: [{ data: "aGk=", mimeType: "image/png" }] };
    });

    assert.deepEqual(tools.map((tool) => tool.name), ["live_annotate", "live_explain", "live_check", "live_panel", "live_cutout", "live_image", "live_control", "live_clear", "live_look", "live_speak"]);
    assert.ok(tools.every((tool) => tool.skipPermission));

    const result = await tools[0].handler({ shapes: [{ kind: "circle", x: 1, y: 2, w: 3, h: 4 }] });
    assert.equal(toolCalls[0].name, "live_annotate");
    assert.deepEqual(result, { textResultForLlm: "drawn", resultType: "success", binaryResultsForLlm: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });

    const deltas = [];
    brain.on("delta", (text, turn) => deltas.push([text, turn]));
    const idle = once(brain, "idle");
    await brain.send({
        prompt: overlayPrompt("abc-1"),
        attachments: [{ type: "blob", data: "aGk=", mimeType: "image/jpeg" }, { type: "file", path: "/etc/passwd" }],
        displayPrompt: "what is this?",
    });
    assert.equal(session.sent[0].displayPrompt, "[Ink Brain] what is this?");
    assert.deepEqual(session.sent[0].attachments.map((attachment) => attachment.type), ["blob"]);

    session.fire("user.message", { content: "typed in the terminal" });
    session.fire("assistant.message_delta", { deltaContent: "not for the overlay" });
    session.fire("session.idle");
    session.fire("user.message", { content: "[Ink Brain] what is this?", transformedContent: session.sent[0].prompt });
    session.fire("assistant.message_delta", { deltaContent: "from a sub-agent" }, { agentId: "explore-1" });
    session.fire("assistant.message_delta", { deltaContent: "It is a chart." });
    session.fire("session.idle");
    assert.deepEqual(await idle, ["abc-1"]);
    assert.deepEqual(deltas, [["It is a chart.", "abc-1"]]);
});

test("cancelling a queued overlay question never aborts the session's own work", async (t) => {
    const { session, brain } = await link(t);
    // A request round trip guarantees that any events relayed before it have arrived.
    const barrier = () => brain.abort("barrier");
    session.fire("user.message", { content: "fix the failing test" });
    await brain.send({ prompt: overlayPrompt("q-1") });
    await brain.abort("q-1");
    assert.equal(session.aborts, 0);

    const deltas = [];
    brain.on("delta", (text) => deltas.push(text));
    session.fire("session.idle");
    session.fire("user.message", { content: session.sent[0].prompt });
    session.fire("assistant.message_delta", { deltaContent: "answered in the terminal only" });
    await barrier();
    assert.deepEqual(deltas, []);

    await brain.send({ prompt: overlayPrompt("q-2") });
    session.fire("user.message", { content: session.sent[1].prompt });
    await brain.abort("q-2");
    assert.equal(session.aborts, 1);
});

test("tools explain how to start the overlay when it is not running", async () => {
    let tools;
    const extension = await start({
        joinSession: async (config) => {
            tools = config.tools;
            return new FakeSession();
        },
        socketPath: path.join(process.env.INK_BRAIN_HOME, "missing.sock"),
        autoLaunch: false,
    });
    const result = await tools.find((tool) => tool.name === "live_look").handler({});
    extension.stop();
    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /Ink Brain is not running/);
});
