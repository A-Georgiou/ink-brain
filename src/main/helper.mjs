// JSON-lines client for the native macOS helper (native/Helper.swift).
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HELPER_PATH = path.join(root, "native/build/Ink Brain Helper.app/Contents/MacOS/ink-brain-helper");
const BUNDLE_ID = "io.github.a-georgiou.ink-brain.helper";
// After a rebuild macOS lists these as allowed instead of asking again; microphone and speech re-prompt.
const STALE_PRONE = { screen: "ScreenCapture", control: "PostEvent" };
const tccReset = (service) => new Promise((resolve) => execFile("/usr/bin/tccutil", ["reset", service, BUNDLE_ID], () => resolve()));

// Ad-hoc signing ties approvals to one build, so a new build's missing grants are stale toggles.
export function clearStaleGrants(permissions, reset = tccReset) {
    return Promise.all(Object.entries(STALE_PRONE).filter(([kind]) => permissions?.[kind] && permissions[kind] !== "granted").map(([, service]) => reset(service)));
}

export class Helper extends EventEmitter {
    #proc = null;
    #ready = null;
    #nextId = 1;
    #pending = new Map();

    constructor({ executable = HELPER_PATH, inheritPermissions = false } = {}) {
        super();
        this.executable = executable;
        this.inheritPermissions = inheritPermissions;
    }

    get running() {
        return Boolean(this.#proc);
    }

    start() {
        if (this.#ready) return this.#ready;
        const env = { ...process.env };
        if (this.inheritPermissions) env.INK_BRAIN_INHERIT_TCC = "1";
        const proc = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"], env });
        this.#proc = proc;
        this.#ready = new Promise((resolve, reject) => {
            this.once("ready", () => resolve());
            proc.once("error", reject);
            proc.once("exit", (code) => reject(new Error(`Helper exited before it was ready (code ${code})`)));
        });
        this.#ready.catch(() => {});
        readline.createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
        proc.stderr.on("data", (chunk) => this.emit("log", chunk.toString()));
        proc.stdin.on("error", () => {});
        proc.on("exit", (code, signal) => {
            for (const { reject, timer } of this.#pending.values()) {
                clearTimeout(timer);
                reject(new Error("Helper exited"));
            }
            this.#pending.clear();
            this.#proc = null;
            this.#ready = null;
            this.emit("exit", { code, signal });
        });
        return this.#ready;
    }

    #onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        if (message.event) {
            this.emit(message.event, message);
            return;
        }
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error));
    }

    async request(cmd, args = {}, { timeoutMs = 15_000 } = {}) {
        await this.start();
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Helper command "${cmd}" timed out`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#proc.stdin.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
        });
    }

    stop() {
        const proc = this.#proc;
        if (!proc) return;
        proc.stdin.end();
        setTimeout(() => proc.kill(), 1500).unref();
    }
}
