// Unix-socket bridge through which Copilot CLI and App sessions use the overlay, via the extension.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { RpcPeer } from "../shared/rpc.mjs";
import { SOCKET_PATH, ensureConfigDir } from "./config.mjs";

export class Bridge extends EventEmitter {
    peers = new Map();

    constructor({ onTool, onDebug = null }) {
        super();
        this.onTool = onTool;
        this.onDebug = onDebug;
    }

    // The socket is 0600 in a 0700 folder; screen access still needs the user's approval per connection.
    async start() {
        ensureConfigDir();
        fs.rmSync(SOCKET_PATH, { force: true });
        this.server = net.createServer((socket) => this.#accept(socket));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(SOCKET_PATH, resolve);
        });
        fs.chmodSync(SOCKET_PATH, 0o600);
    }

    stop() {
        this.server?.close();
        for (const peer of this.peers.values()) peer.rpc.close();
        fs.rmSync(SOCKET_PATH, { force: true });
    }

    // Sessions that can receive overlay questions (debug clients only call tools).
    list() {
        return [...this.peers.values()]
            .filter((peer) => peer.ready && !peer.debug)
            .map(({ id, label, cwd, busy, approved, connectedAt }) => ({ id, label, cwd, busy, approved, connectedAt }));
    }

    get(id) {
        return this.peers.get(id);
    }

    #accept(socket) {
        const peer = { id: randomUUID().slice(0, 8), ready: false, busy: false, approved: false, label: "Copilot session", cwd: "", connectedAt: Date.now() };
        peer.rpc = new RpcPeer(socket, { onRequest: (method, params) => this.#request(peer, method, params) });
        peer.rpc.on("event", (event, data) => {
            if (event === "status") {
                peer.busy = Boolean(data.busy);
                this.emit("peers");
            }
        });
        peer.rpc.on("close", () => {
            this.peers.delete(peer.id);
            this.emit("peers");
        });
        this.peers.set(peer.id, peer);
    }

    async #request(peer, method, params) {
        if (method === "hello") {
            peer.ready = true;
            peer.debug = Boolean(params.debug);
            peer.label = String(params.label || "Copilot session").slice(0, 60);
            peer.cwd = String(params.cwd || "").slice(0, 300);
            peer.pid = Number(params.pid) || null;
            this.emit("peers");
            this.emit("hello", peer);
            return { app: "ink-brain", pid: process.pid, peerId: peer.id };
        }
        if (!peer.ready) throw new Error("Say hello first");
        if (method === "tool") return this.onTool(String(params.name), params.args ?? {}, peer);
        if (method === "debug" && this.onDebug) return this.onDebug(params, peer);
        throw new Error(`Unknown method: ${method}`);
    }
}
