// Speech output: the Kokoro neural voice in a background process, with the macOS voice as a fallback.
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "voice-worker.mjs");

// Emits start({ utterance }) and end({ utterance, cancelled, idle }) for both engines.
export class Voice extends EventEmitter {
    #worker = null;
    #ready = false;
    #pending = new Map();
    #helperBusy = false;
    // Lowered only by diagnostics, to exercise the voice without sound.
    volume = 1;

    // fork(modulePath, env) starts the worker: an object with postMessage, kill and on("message" | "exit").
    constructor({ helper, config, fork, modelsDir }) {
        super();
        this.helper = helper;
        this.config = config;
        this.fork = fork;
        this.modelsDir = modelsDir;
        helper.on("tts.start", ({ utterance }) => {
            this.#helperBusy = true;
            this.emit("start", { utterance });
        });
        helper.on("tts.end", ({ utterance, cancelled, idle }) => {
            if (idle) this.#helperBusy = false;
            this.emit("end", { utterance, cancelled: Boolean(cancelled), idle: Boolean(idle) && this.#pending.size === 0 });
        });
    }

    get engine() {
        return this.#ready ? "neural" : "system";
    }

    start() {
        if (this.config.voice.engine !== "neural" || this.#worker) return;
        try {
            this.#worker = this.fork(WORKER, { INK_BRAIN_MODELS: this.modelsDir });
        } catch (error) {
            this.emit("warn", `The neural voice could not start (${error.message}); using the macOS voice.`);
            return;
        }
        this.#worker.on("message", (message) => this.#onMessage(message));
        this.#worker.on("exit", () => {
            this.#worker = null;
            this.#ready = false;
            this.#fallBackPending();
        });
        this.#worker.postMessage({ type: "load", dtype: this.config.voice.neuralQuality ?? "q8" });
    }

    stopWorker() {
        this.#worker?.kill();
    }

    speak(text, utterance) {
        if (!this.#ready) return this.#system(text, utterance);
        this.#pending.set(utterance, text);
        this.#worker.postMessage({ type: "speak", id: utterance, text, voice: this.config.voice.neuralVoice, speed: this.config.voice.speed ?? 1 });
    }

    stop() {
        const dropped = [...this.#pending.keys()];
        this.#pending.clear();
        this.#worker?.postMessage({ type: "cancel" });
        dropped.forEach((utterance, index) => this.emit("end", { utterance, cancelled: true, idle: index === dropped.length - 1 && !this.#helperBusy }));
        this.helper.request("speak.stop").catch(() => {});
    }

    #system(text, utterance) {
        const { voiceId, rate } = this.config.voice;
        this.helper.request("speak", { text, utterance, voice: voiceId ?? undefined, rate: rate ?? undefined, volume: this.volume }).catch(() => this.#dropped(utterance));
    }

    // Ends an utterance the helper could not play.
    #dropped(utterance) {
        this.emit("end", { utterance, cancelled: true, idle: !this.#helperBusy && this.#pending.size === 0 });
    }

    #fallBackPending() {
        const pending = [...this.#pending];
        this.#pending.clear();
        for (const [utterance, text] of pending) this.#system(text, utterance);
    }

    #onMessage(message) {
        if (message.type === "ready") {
            this.#ready = true;
            this.emit("ready");
        } else if (message.type === "progress") {
            if (message.total > 5_000_000) this.emit("progress", message);
        } else if (message.type === "failed") {
            this.emit("warn", `The neural voice could not load (${message.message}); using the macOS voice.`);
            this.#worker?.kill();
        } else if (message.type === "audio") {
            if (!this.#pending.delete(message.id)) return;
            const pcm = Buffer.from(message.pcm.buffer, message.pcm.byteOffset, message.pcm.byteLength).toString("base64");
            this.helper.request("play", { utterance: message.id, sampleRate: message.sampleRate, pcm, volume: this.volume }).catch(() => this.#dropped(message.id));
        } else if (message.type === "error") {
            const text = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            if (text) this.#system(text, message.id);
        }
    }
}
