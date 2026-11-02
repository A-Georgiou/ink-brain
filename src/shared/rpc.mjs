// Bidirectional request/response/event peer over newline-delimited JSON (Unix socket bridge).
import { EventEmitter } from "node:events";

const MAX_LINE_BYTES = 64 * 1024 * 1024;

export class RpcPeer extends EventEmitter {
    #nextId = 1;
    #pending = new Map();
    #buffer = "";

    constructor(socket, { onRequest } = {}) {
        super();
        this.socket = socket;
        this.onRequest = onRequest;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.#read(chunk));
        socket.on("error", (error) => this.emit("socket-error", error));
        socket.on("close", () => {
            for (const { reject, timer } of this.#pending.values()) {
                clearTimeout(timer);
                reject(new Error("Connection closed"));
            }
            this.#pending.clear();
            this.emit("close");
        });
    }

    get closed() {
        return this.socket.destroyed;
    }

    request(method, params = {}, { timeoutMs = 60_000 } = {}) {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`"${method}" timed out`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#write({ type: "req", id, method, params });
        });
    }

    notify(event, data = {}) {
        this.#write({ type: "event", event, data });
    }

    close() {
        this.socket.end();
    }

    #write(message) {
        if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(message)}\n`);
    }

    #read(chunk) {
        this.#buffer += chunk;
        if (this.#buffer.length > MAX_LINE_BYTES) {
            this.socket.destroy(new Error("Message too large"));
            return;
        }
        let index;
        while ((index = this.#buffer.indexOf("\n")) >= 0) {
            const line = this.#buffer.slice(0, index);
            this.#buffer = this.#buffer.slice(index + 1);
            if (!line.trim()) continue;
            try {
                this.#dispatch(JSON.parse(line));
            } catch {
                // Ignore malformed lines rather than tearing down the connection.
            }
        }
    }

    async #dispatch(message) {
        if (message.type === "event") {
            this.emit("event", message.event, message.data ?? {});
        } else if (message.type === "res") {
            const pending = this.#pending.get(message.id);
            if (!pending) return;
            this.#pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.ok) pending.resolve(message.result);
            else pending.reject(new Error(message.error || "Request failed"));
        } else if (message.type === "req") {
            try {
                if (!this.onRequest) throw new Error("Requests are not supported");
                const result = await this.onRequest(message.method, message.params ?? {});
                this.#write({ type: "res", id: message.id, ok: true, result: result ?? null });
            } catch (error) {
                this.#write({ type: "res", id: message.id, ok: false, error: error?.message ?? String(error) });
            }
        }
    }
}
