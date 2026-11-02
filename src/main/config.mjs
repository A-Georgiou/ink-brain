// User settings: ~/.ink-brain/config.json merged over defaults, with environment overrides.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = process.env.INK_BRAIN_HOME || path.join(os.homedir(), ".ink-brain");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const SOCKET_PATH = path.join(CONFIG_DIR, "bridge.sock");
export const WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");
export const CUTOUTS_DIR = path.join(WORKSPACE_DIR, "cutouts");
export const MEMORY_DIR = path.join(CONFIG_DIR, "memory");
// Shared by test instances so the voice model downloads once.
export const MODELS_DIR = path.join(os.homedir(), ".ink-brain", "models");

export const DEFAULTS = {
    hotkey: "Alt+Shift+Space",
    model: "claude-opus-5.5",
    reasoningEffort: "low",
    useCustomInstructions: false,
    defaultTarget: "auto",
    stayLive: false,
    hearScreen: false,
    inheritPermissions: false,
    maxScreenshotEdge: 1568,
    annotationTtlSeconds: 45,
    explanationTtlSeconds: 90,
    followUpSeconds: 12,
    wakeWord: "ink brain",
    control: "ask",
    // "ask" before reading each new site, or "off"; sites allowed with "Always allow" are kept in webSites.
    web: "ask",
    webSites: [],
    imageGeneration: true,
    // What Ink Brain remembers between conversations, kept in MEMORY_DIR on this Mac.
    memory: {
        enabled: true,
        screen: true,
        copilotSessions: true,
        resumeHours: 6,
        keepDays: 30,
    },
    voice: {
        input: true,
        output: true,
        engine: "neural",
        neuralVoice: "af_heart",
        neuralQuality: "q8",
        speed: 1,
        voiceId: null,
        rate: null,
        locale: null,
        silenceMs: 1100,
        allowServerSpeech: false,
        maxSpokenChars: 700,
    },
};

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

export function merge(base, override) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override ?? {})) {
        out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
    }
    return out;
}

function readUserConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`Ignoring unreadable ${CONFIG_PATH}: ${error.message}`);
        return {};
    }
}

export function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(CONFIG_DIR, 0o700);
}

export function loadConfig() {
    const config = merge(DEFAULTS, readUserConfig());
    if (process.env.INK_BRAIN_MODEL) config.model = process.env.INK_BRAIN_MODEL;
    if (process.env.INK_BRAIN_HOTKEY) config.hotkey = process.env.INK_BRAIN_HOTKEY;
    if (process.env.INK_BRAIN_INHERIT_TCC === "1") config.inheritPermissions = true;
    return config;
}

// Persists a partial change (for example a tray toggle) into the user's config file.
export function saveConfig(patch) {
    ensureConfigDir();
    const next = merge(readUserConfig(), patch);
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
