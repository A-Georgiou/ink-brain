// Kokoro neural voice, run as an Electron utility process or a Node child process.
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const port = process.parentPort;
const post = (message) => (port ? port.postMessage(message) : process.send?.(message));
const onMessage = (handler) => (port ? port.on("message", (event) => handler(event.data)) : process.on("message", handler));

if (process.env.INK_BRAIN_MODELS) env.cacheDir = process.env.INK_BRAIN_MODELS;

let tts = null;
let generation = 0;
let running = false;
const jobs = [];

async function load(dtype) {
    const files = new Map();
    tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype,
        device: "cpu",
        progress_callback: (progress) => {
            if (progress.status !== "progress" || !progress.total) return;
            files.set(progress.file, [progress.loaded, progress.total]);
            const [loaded, total] = [...files.values()].reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0]);
            post({ type: "progress", loaded, total });
        },
    });
    post({ type: "ready" });
    pump();
}

async function pump() {
    if (running || !tts) return;
    running = true;
    while (jobs.length) {
        const job = jobs.shift();
        if (job.generation !== generation) continue;
        try {
            const audio = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
            if (job.generation !== generation) continue;
            const samples = audio.audio;
            const pcm = new Int16Array(samples.length);
            for (let index = 0; index < samples.length; index++) pcm[index] = Math.max(-1, Math.min(1, samples[index])) * 32767;
            post({ type: "audio", id: job.id, sampleRate: audio.sampling_rate, pcm });
        } catch (error) {
            post({ type: "error", id: job.id, message: error?.message ?? String(error) });
        }
    }
    running = false;
}

onMessage((message) => {
    if (message?.type === "load") {
        load(message.dtype ?? "q8").catch((error) => post({ type: "failed", message: error?.message ?? String(error) }));
    } else if (message?.type === "speak") {
        jobs.push({ ...message, generation });
        pump();
    } else if (message?.type === "cancel") {
        generation++;
        jobs.length = 0;
    }
});
