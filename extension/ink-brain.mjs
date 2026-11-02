// Copilot CLI and App session extension: adds the live_* tools and runs overlay questions in the session.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_PATH } from "../src/main/config.mjs";
import { EXTENSION_TOOLS, LONG_RUNNING_TOOLS, toToolResult } from "../src/shared/live-tools.mjs";
import { RpcPeer } from "../src/shared/rpc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TURN_MARKER = /<ink_brain_context turn="([\w-]+)">/;
const MAX_ATTACHMENT_CHARS = 12 * 1024 * 1024;

const sessionLabel = () => `${process.env.TERM_PROGRAM || process.env.TERM ? "CLI" : "App"} · ${path.basename(process.cwd()) || "~"}`;

function cleanAttachments(list) {
    if (!Array.isArray(list)) return undefined;
    return list
        .slice(0, 4)
        .filter((a) => a?.type === "blob" && typeof a.data === "string" && a.data.length <= MAX_ATTACHMENT_CHARS && /^image\/(png|jpeg)$/.test(a.mimeType))
        .map((a) => ({ type: "blob", data: a.data, mimeType: a.mimeType, displayName: String(a.displayName ?? "screen.jpg").slice(0, 60) }));
}

function launchOverlay() {
    const pathFile = path.join(root, "node_modules/electron/path.txt");
    if (!fs.existsSync(pathFile)) throw new Error(`run "npm start" once in ${root} to finish installing it`);
    const build = spawnSync("bash", [path.join(root, "native/build.sh")], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`building the native helper failed: ${build.stderr?.trim() || build.error?.message}`);
    const relative = fs.readFileSync(pathFile, "utf8").trim();
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(path.join(root, "node_modules/electron/dist", relative), [root], { cwd: root, env, detached: true, stdio: "ignore" }).unref();
}

export async function start({ joinSession, socketPath = SOCKET_PATH, autoLaunch = process.env.INK_BRAIN_AUTOLAUNCH !== "0", reconnectMs = 5_000 }) {
    let peer = null;
    let connecting = null;
    let relayTurn = null;
    let busy = false;
    const pendingTurns = new Set();

    const tools = EXTENSION_TOOLS.map((spec) => ({
        ...spec,
        skipPermission: true,
        defer: "never",
        handler: async (args) => toToolResult(await callTool(spec.name, args)),
    }));
    const session = await joinSession({ tools });
    const notify = (event, data = {}) => peer?.notify(event, data);

    function connect() {
        if (peer && !peer.closed) return Promise.resolve(peer);
        connecting ??= new Promise((resolve, reject) => {
            const socket = net.connect(socketPath);
            socket.once("error", reject);
            socket.once("connect", async () => {
                socket.off("error", reject);
                const rpc = new RpcPeer(socket, { onRequest: handleRequest });
                rpc.on("socket-error", () => {});
                rpc.on("close", () => {
                    if (peer !== rpc) return;
                    peer = null;
                    relayTurn = null;
                });
                try {
                    await rpc.request("hello", { sessionId: session.sessionId, cwd: process.cwd(), label: sessionLabel(), pid: process.pid }, { timeoutMs: 5_000 });
                    peer = rpc;
                    rpc.notify("status", { busy });
                    resolve(rpc);
                } catch (error) {
                    socket.destroy();
                    reject(error);
                }
            });
        }).finally(() => {
            connecting = null;
        });
        return connecting;
    }

    async function launchAndConnect() {
        await session.log("Starting the Ink Brain overlay...", { ephemeral: true });
        launchOverlay();
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                return await connect();
            } catch {
                // Still starting up.
            }
        }
        throw new Error("the overlay did not start within 25 seconds");
    }

    async function callTool(name, args) {
        let rpc;
        try {
            rpc = await connect();
        } catch {
            if (!autoLaunch) return { text: `Ink Brain is not running. Start it with "npm start" in ${root}.`, failed: true };
            try {
                rpc = await launchAndConnect();
            } catch (error) {
                return { text: `Could not start Ink Brain: ${error.message}`, failed: true };
            }
        }
        return rpc.request("tool", { name, args }, { timeoutMs: LONG_RUNNING_TOOLS.has(name) ? 900_000 : 180_000 });
    }

    async function handleRequest(method, params) {
        if (method === "prompt") {
            const prompt = String(params.prompt ?? "");
            const turn = TURN_MARKER.exec(prompt)?.[1];
            if (turn) pendingTurns.add(turn);
            const displayPrompt = params.displayPrompt ? `[Ink Brain] ${String(params.displayPrompt).slice(0, 500)}` : undefined;
            await session.send({ prompt, attachments: cleanAttachments(params.attachments), displayPrompt });
            return { accepted: true };
        }
        if (method === "abort") {
            const turn = String(params.turn ?? "");
            pendingTurns.delete(turn);
            // Only stop the session while it is answering that overlay question, never the user's own work.
            if (turn && relayTurn === turn) await session.abort();
            return {};
        }
        throw new Error(`Unknown method: ${method}`);
    }

    const setBusy = (value) => {
        if (busy === value) return;
        busy = value;
        notify("status", { busy });
    };
    const isSubagent = (event) => Boolean(event.agentId || event.data?.parentToolCallId);
    const relay = (type, data = {}) => relayTurn && notify(type, { ...data, turn: relayTurn });

    // Relay only the turns that started from the overlay; terminal-typed turns stay in the terminal.
    session.on("user.message", (event) => {
        if (isSubagent(event)) return;
        const marker = TURN_MARKER.exec(`${event.data?.content ?? ""}\n${event.data?.transformedContent ?? ""}`)?.[1];
        const turn = marker && pendingTurns.delete(marker) ? marker : null;
        // Another message (such as an autopilot continuation) means the overlay's answer is complete.
        if (relayTurn && relayTurn !== turn) relay("turn.idle");
        relayTurn = turn;
    });
    session.on("assistant.turn_start", () => setBusy(true));
    session.on("assistant.message_delta", (event) => !isSubagent(event) && relay("turn.delta", { text: event.data?.deltaContent ?? "" }));
    session.on("assistant.message", (event) => !isSubagent(event) && relay("turn.message", { text: event.data?.content ?? "" }));
    session.on("tool.execution_start", (event) => !isSubagent(event) && relay("turn.tool", { name: event.data?.toolName ?? "" }));
    session.on("session.error", (event) => relay("turn.error", { message: event.data?.message ?? "Copilot reported an error" }));
    session.on("session.idle", () => {
        setBusy(false);
        relay("turn.idle");
        relayTurn = null;
    });

    connect().catch(() => {});
    const timer = setInterval(() => connect().catch(() => {}), reconnectMs);
    timer.unref?.();

    return {
        session,
        stop() {
            clearInterval(timer);
            peer?.close();
        },
    };
}
