// The brains the overlay talks to: an embedded Copilot SDK session or a linked CLI/App session.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

const FALLBACK_MODELS = ["gpt-6.1-terra", "claude-opus-5.5", "claude-sonnet-5.5", "gpt-6.1-sol", "claude-haiku-5.5"];
// Automatic model selection, the only choice on Copilot Free and Student.
const AUTO = "auto";
// Models whose best balance of speed and quality in the evals is not low effort.
const EFFORTS = { "gpt-6.1-terra": "medium" };

// The configured reasoning effort, or the one the evals found best for this model; Auto rejects any effort.
export const effortFor = (model, configured) => (model === AUTO ? undefined : (configured ?? EFFORTS[model] ?? "low"));

// The wanted model if this account can use it with images, else a fallback, else Auto.
export function chooseModel(models, wanted) {
    const vision = models.filter((model) => model.capabilities?.supports?.vision && model.policy?.state !== "disabled").map((model) => model.id);
    if (wanted === AUTO || vision.includes(wanted)) return wanted;
    return FALLBACK_MODELS.find((id) => vision.includes(id)) ?? vision[0] ?? AUTO;
}

// A Terminal script that installs Copilot CLI if it is missing, signs in and touches marker once signed in.
export function signInScript({ searchPath, marker }) {
    const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
    return [
        "#!/bin/bash",
        `export PATH=${quote(searchPath)}:/opt/homebrew/bin:/usr/local/bin:"$PATH"`,
        'echo "Signing in to GitHub Copilot for Ink Brain."',
        "command -v copilot >/dev/null || npm install -g @github/copilot || exit 1",
        `copilot login && touch ${quote(marker)} && echo "Signed in. You can close this window."`,
        "",
    ].join("\n");
}

// Emits delta(text), message(text), preparing({ name }), input({ id, name, delta }), tool({ name }), idle() and error(Error).
export class EmbeddedBrain extends EventEmitter {
    id = "standalone";
    label = "Ink Brain";
    model = null;
    sessionId = null;
    // True until the first message of a new (not resumed) conversation is sent.
    fresh = true;
    #client = null;
    #session = null;
    #starting = null;
    #recent = null;
    #calls;

    // extraTools are built-in tools such as image_generation; resumeFrom() names a conversation to resume.
    constructor({ config, tools, extraTools = [], systemMessage, workspace, resumeFrom = () => null }) {
        super();
        Object.assign(this, { config, tools, extraTools, systemMessage, workspace, resumeFrom });
        this.#calls = new ToolCalls(tools);
    }

    ensure() {
        if (this.#session) return Promise.resolve(this.#session);
        this.#starting ??= this.#create().finally(() => {
            this.#starting = null;
        });
        return this.#starting;
    }

    async #create() {
        const { CopilotClient } = await import("@github/copilot-sdk");
        fs.mkdirSync(this.workspace, { recursive: true });
        if (!this.#client) {
            const client = new CopilotClient({ logLevel: "error", workingDirectory: this.workspace });
            await client.start();
            this.#client = client;
        }
        this.model = await this.#pickModel();
        // MCP tools are never exposed here, so not starting the user's servers saves ~15 s on the first turn.
        const mcp = await this.#mcpServers();
        const options = {
            clientName: "ink-brain",
            model: this.model,
            reasoningEffort: effortFor(this.model, this.config.reasoningEffort),
            streaming: true,
            workingDirectory: this.workspace,
            tools: this.#calls.tools,
            availableTools: [...this.tools.map((tool) => tool.name), ...this.extraTools],
            disabledMcpServers: [...mcp, "github-mcp-server"],
            imageGeneration: { enabled: this.extraTools.includes("image_generation") },
            skipCustomInstructions: !this.config.useCustomInstructions,
            systemMessage: this.systemMessage,
            onPermissionRequest: async () => ({ kind: "reject" }),
        };
        const previous = this.resumeFrom();
        let session = previous ? await this.#client.resumeSession(previous, options).catch(() => null) : null;
        this.fresh = !session;
        session ??= await this.#client.createSession(options);
        this.sessionId = session.sessionId;
        session.on("assistant.message_delta", (event) => this.emit("delta", event.data.deltaContent ?? ""));
        session.on("assistant.message", (event) => this.emit("message", event.data.content ?? ""));
        // Tool names and arguments stream long before a call finishes, so the overlay can show and start what is coming.
        const calls = new Map();
        session.on("assistant.tool_call_delta", ({ data }) => {
            const call = calls.get(data.toolCallId) ?? { name: null, pending: "" };
            calls.set(data.toolCallId, call);
            if (!call.name && data.toolName) {
                call.name = data.toolName;
                this.emit("preparing", { name: call.name });
            }
            call.pending += data.inputDelta ?? "";
            if (!call.name || !call.pending) return;
            this.emit("input", { id: data.toolCallId, name: call.name, delta: call.pending });
            call.pending = "";
        });
        session.on("tool.execution_start", (event) => this.emit("tool", { name: event.data.toolName }));
        session.on("session.idle", () => {
            this.#calls.stop();
            this.emit("idle");
        });
        session.on("session.error", (event) => this.emit("error", new Error(event.data.message || "Copilot reported an error")));
        this.#session = session;
        return session;
    }

    async #pickModel() {
        try {
            return chooseModel(await this.#client.listModels(), this.config.model);
        } catch {
            return this.config.model;
        }
    }

    // The Copilot account answering, as { isAuthenticated, login, statusMessage }.
    async account() {
        await this.ensure();
        return this.#client.getAuthStatus();
    }

    async #mcpServers() {
        try {
            const { servers } = await this.#client.rpc.mcp.discover({ workingDirectory: this.workspace });
            return servers.map((server) => server.name);
        } catch {
            return [];
        }
    }

    async send({ prompt, attachments }) {
        const session = await this.ensure();
        this.fresh = false;
        this.#calls.watch(session);
        await session.send({ prompt, attachments });
    }

    get cachedSessions() {
        return this.#recent?.list ?? [];
    }

    // Recent CLI and App sessions as { at, where, summary }, newest first, cached for ten minutes.
    async recentSessions() {
        if (!this.#client || (this.#recent && Date.now() - this.#recent.at < 600_000)) return this.cachedSessions;
        const own = (dir = "") => dir.startsWith(this.workspace) || /^(\/private)?\/(var\/folders\/|tmp(\/|$))/.test(dir);
        const list = (await this.#client.listSessions().catch(() => []))
            .filter((s) => s.sessionId !== this.sessionId && s.summary && !/<\w+_context turn=/.test(s.summary) && !own(s.context?.workingDirectory))
            .filter((s) => Date.now() - new Date(s.modifiedTime).getTime() < 7 * 86_400_000)
            .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))
            .slice(0, 8)
            .map((s) => {
                const { repository, branch, workingDirectory = "" } = s.context ?? {};
                return { at: new Date(s.modifiedTime).toISOString(), where: repository ? `${repository}${branch ? ` (${branch})` : ""}` : path.basename(workingDirectory) || "a session", summary: s.summary };
            });
        this.#recent = { at: Date.now(), list };
        return list;
    }

    async abort() {
        await this.#session?.abort().catch(() => {});
    }

    // Forget the conversation; the next turn starts a fresh session.
    async reset() {
        const session = this.#session;
        this.#session = null;
        this.fresh = true;
        this.#calls.stop();
        await session?.disconnect().catch(() => {});
    }

    async stop() {
        await this.reset();
        await this.#client?.stop().catch(() => {});
        this.#client = null;
    }
}

// Runs each tool request once and answers any Copilot is still waiting on because its request or answer got lost.
export class ToolCalls {
    #handlers;
    #calls = new Map();
    #timer = 0;

    constructor(tools, { graceMs = 5_000 } = {}) {
        this.graceMs = graceMs;
        this.#handlers = new Map(tools.map((tool) => [tool.name, tool.handler]));
        this.tools = tools.map((tool) => ({ ...tool, handler: (args, invocation) => this.run(tool.name, args, invocation) }));
    }

    run(name, args, invocation) {
        const id = invocation?.requestId;
        const call = this.#calls.get(id) ?? { seen: Date.now() };
        if (!call.answer) {
            call.answer = Promise.resolve(this.#handlers.get(name)(args, invocation)).finally(() => (call.done = Date.now()));
            if (id) this.#calls.set(id, call);
        }
        return call.answer;
    }

    // A lost request or answer would leave the turn waiting forever, so check while one runs.
    watch(session) {
        this.stop();
        this.#timer = setInterval(() => this.rescue(session), this.graceMs / 2);
    }

    stop() {
        clearInterval(this.#timer);
        this.#calls.clear();
    }

    async rescue(session) {
        const { items = [] } = await session.rpc.tools.listPendingRequests().catch(() => ({}));
        for (const item of items) {
            if (!this.#handlers.has(item.toolName)) continue;
            const call = this.#calls.get(item.requestId) ?? { seen: Date.now() };
            this.#calls.set(item.requestId, call);
            if ((call.answer && !call.done) || Date.now() - (call.done ?? call.seen) < this.graceMs) continue;
            console.warn(call.answer ? `The ${item.toolName} answer never reached Copilot, so sending it again` : `The ${item.toolName} request never arrived, so running it now`);
            const answer = await this.run(item.toolName, item.arguments ?? {}, item).then(
                (result) => ({ result }),
                (error) => ({ error: String(error?.message ?? error) }),
            );
            call.done = Date.now();
            await session.rpc.tools.handlePendingToolCall({ requestId: item.requestId, ...answer }).catch(() => {});
        }
    }
}

// A linked CLI/App session, emitting the same events except preparing.
export class LinkedBrain extends EventEmitter {
    constructor(peer) {
        super();
        this.peer = peer;
        this.id = peer.id;
        // Every event carries the overlay turn it belongs to, so stale events never leak into a newer turn.
        peer.rpc.on("event", (event, data) => {
            const turn = data.turn ? String(data.turn) : undefined;
            if (event === "turn.delta") this.emit("delta", String(data.text ?? ""), turn);
            else if (event === "turn.message") this.emit("message", String(data.text ?? ""), turn);
            else if (event === "turn.tool") this.emit("tool", { name: String(data.name ?? "") }, turn);
            else if (event === "turn.idle") this.emit("idle", turn);
            else if (event === "turn.error") this.emit("error", new Error(String(data.message ?? "Linked session error")), turn);
        });
    }

    get label() {
        return this.peer.label;
    }

    async send({ prompt, attachments, displayPrompt }) {
        await this.peer.rpc.request("prompt", { prompt, attachments, displayPrompt }, { timeoutMs: 30_000 });
    }

    async abort(turn) {
        await this.peer.rpc.request("abort", { turn }, { timeoutMs: 5_000 }).catch(() => {});
    }
}
