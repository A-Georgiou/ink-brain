// Ink Brain's main process: overlay window, hotkey, tray, native helper, brains and the CLI/App bridge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, protocol, screen, session, shell, Tray, utilityProcess } from "electron";
import { installExtension } from "../../scripts/install-extension.mjs";
import { pageTitle } from "../shared/anchors.mjs";
import { hasCallouts, inkGrid, settleCallouts } from "../shared/calm.mjs";
import { boundsOfMarks, cropAround, isRegion, modelImageSize, panelRect, snapPoint, snapShape } from "../shared/geometry.mjs";
import { STANDALONE_TOOLS, TOOL_NAMES, toToolResult } from "../shared/live-tools.mjs";
import { SpeechChunker } from "../shared/speech.mjs";
import { EmbeddedBrain, LinkedBrain } from "./brain.mjs";
import { Bridge } from "./bridge.mjs";
import { CONFIG_PATH, CUTOUTS_DIR, DEFAULTS, MEMORY_DIR, MODELS_DIR, WORKSPACE_DIR, ensureConfigDir, loadConfig, saveConfig } from "./config.mjs";
import { Controller } from "./control.mjs";
import { ExplainPlayer, readingTime } from "./explain.mjs";
import { clearStaleGrants, Helper } from "./helper.mjs";
import { trayIcon } from "./icon.mjs";
import { readImageFile, saveCutout } from "./images.mjs";
import { Memory } from "./memory.mjs";
import { APP_SCHEME, registerAppProtocol } from "./protocol.mjs";
import { buildTurnPrompt, systemMessage } from "./prompt.mjs";
import { describePage, Reader, siteAllowed, siteOf } from "./reader.mjs";
import { cleanId, Surface } from "./surface.mjs";
import { createCheckWaiter, publicChoices } from "./tutor.mjs";
import { Voice } from "./voice.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEBUG = process.env.INK_BRAIN_DEBUG === "1";
const STANDALONE = { id: "standalone", label: "Ink Brain" };

protocol.registerSchemesAsPrivileged([APP_SCHEME]);

const config = loadConfig();
const memory = new Memory({ dir: MEMORY_DIR, keepDays: config.memory.keepDays });
const helper = new Helper({ inheritPermissions: config.inheritPermissions });
const voice = new Voice({
    helper,
    config,
    modelsDir: MODELS_DIR,
    fork: (modulePath, env) => utilityProcess.fork(modulePath, [], { env: { ...process.env, ...env }, serviceName: "Ink Brain voice" }),
});
const state = {
    pen: false,
    listening: false,
    hearing: false,
    thinking: false,
    speaking: false,
    controlling: false,
    stayLive: config.stayLive,
    voiceIn: config.voice.input,
    voiceOut: config.voice.output,
    target: config.defaultTarget,
    model: config.model,
    permissions: null,
};

let overlay = null;
let tray = null;
let bridge = null;
let embedded = null;
let surface = null;
let reader = null;
let explainer = null;
let checks = null;
let controller = null;

let geometry = null;
let windows = null;
let debugWindows = null;
let frontKey = "";
let penFront = null;
let currentTurn = null;
let followUpUntil = 0;
let listenTimer = null;
let syntheticEscapeUntil = 0;
let webEpoch = 0;
let webQueue = Promise.resolve();
let helperRestarts = 0;
let restartRequested = false;
let setupShown = false;
let quitting = false;

let callCount = 0;
let turnCount = 0;
let utteranceCount = 0;
let cutoutCount = 0;
let imageCount = 0;
let controlRequestCount = 0;
let webRequestCount = 0;
const calls = new Map();
const linked = new Map();
const approvals = new Map();
const controlRequests = new Map();
const webRequests = new Map();
const panelArtefacts = new Map();
const heard = [];

const send = (channel, payload) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
};
const toast = (message, level = "info") => send("live:toast", { message, level });
// Memory must never break a turn, so its reads and writes fall back quietly.
const safely = (fn, fallback = "") => {
    try {
        return fn();
    } catch (error) {
        console.warn(`Ink Brain memory: ${error.message}`);
        return fallback;
    }
};
const memoryOn = (part = "enabled") => config.memory.enabled && (part === "enabled" || Boolean(config.memory[part]));
// The { app, page } memory keeps for a frontmost window, or null.
const pageOf = (front) => (front?.app ? { app: front.app, page: pageTitle(front.title) } : null);
const frontmost = () => helper.request("frontmost", { excludePids: [process.pid] }).catch(() => ({}));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hotkeyLabel = () => config.hotkey.replace(/\b(CommandOrControl|CmdOrCtrl|Command)\b/g, "Cmd").replace(/\bAlt\b/g, "Option");
const imageRoots = () => [path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "session-state"), WORKSPACE_DIR];

// ---------------------------------------------------------------- overlay window

function createOverlay() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlay = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        type: "panel",
        enableLargerThanScreen: true,
        roundedCorners: false,
        webPreferences: {
            preload: path.join(here, "../preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    overlay.webContents.on("will-frame-navigate", (event) => {
        if (!event.url.startsWith("app://live/")) event.preventDefault();
    });
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("render-process-gone", () => setTimeout(() => overlay?.webContents.reload(), 1000));
    overlay.once("ready-to-show", () => overlay.showInactive());
    overlay.loadURL("app://live/overlay/index.html");
    if (DEBUG) {
        overlay.webContents.on("console-message", (event) => console.log(`[overlay:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`));
        if (process.env.INK_BRAIN_DEVTOOLS === "1") overlay.webContents.openDevTools({ mode: "detach" });
    }
    setGeometry(display);
}

function lockDownSession() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (_details, callback) => callback({ cancel: true }));
}

function setGeometry(display) {
    const { width, height } = display.bounds;
    const model = modelImageSize(width, height, config.maxScreenshotEdge);
    geometry = { displayId: display.id, bounds: display.bounds, width, height, scale: model.scale, modelWidth: model.width, modelHeight: model.height };
    sendWindows();
}

// Sends the windows on the overlay's display, front to back, so drawings can stay with their page.
function sendWindows() {
    if (!geometry || !windows || debugWindows) return;
    const { x, y, width, height } = geometry.bounds;
    const list = windows
        .map((w) => ({ id: w.id, page: pageTitle(w.title), x: w.x - x, y: w.y - y, w: w.w, h: w.h }))
        .filter((w) => w.x < width && w.y < height && w.x + w.w > 0 && w.y + w.h > 0);
    send("live:windows", list);
}

function moveOverlayTo(display) {
    const b = geometry?.bounds;
    if (geometry?.displayId === display.id && b.x === display.bounds.x && b.y === display.bounds.y && b.width === display.bounds.width) return;
    overlay.setBounds(display.bounds);
    setGeometry(display);
    overlayCall("clear", { target: "annotations" }).catch(() => {});
}

function watchDisplays() {
    const refit = () => {
        const display = screen.getAllDisplays().find((d) => d.id === geometry.displayId) ?? screen.getPrimaryDisplay();
        overlay.setBounds(display.bounds);
        setGeometry(display);
    };
    screen.on("display-removed", refit);
    screen.on("display-metrics-changed", (_event, display) => display.id === geometry.displayId && refit());
}

function cursorInDisplay() {
    const point = screen.getCursorScreenPoint();
    const { x, y, width, height } = geometry.bounds;
    if (point.x < x || point.y < y || point.x >= x + width || point.y >= y + height) return null;
    return { x: point.x - x, y: point.y - y };
}

function overlayCall(method, params = {}, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        if (!overlay || overlay.isDestroyed()) return reject(new Error("The overlay is not available"));
        const id = ++callCount;
        const timer = setTimeout(() => {
            calls.delete(id);
            reject(new Error(`The overlay did not finish "${method}" in time`));
        }, timeoutMs);
        calls.set(id, { resolve, reject, timer });
        overlay.webContents.send("live:call", { id, method, params });
    });
}

// ---------------------------------------------------------------- renderer IPC

const fromOverlay = (event) => Boolean(overlay) && event.sender === overlay.webContents && event.senderFrame === overlay.webContents.mainFrame;

ipcMain.on("live:ready", (event) => {
    if (!fromOverlay(event)) return;
    pushState();
    sendWindows();
    if (needsSetup()) showSetup();
});

ipcMain.on("live:call-result", (event, message) => {
    if (!fromOverlay(event)) return;
    const pending = calls.get(message?.id);
    if (!pending) return;
    calls.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Overlay error"));
});

ipcMain.on("live:submit", (event, turn) => fromOverlay(event) && runTurn(sanitizeTurn(turn)));
ipcMain.on("live:pen", (event, on) => fromOverlay(event) && setPen(Boolean(on)));
ipcMain.on("live:interactive", (event, on) => {
    if (fromOverlay(event) && !state.pen) overlay.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on("live:command", (event, message) => fromOverlay(event) && runCommand(message?.name, message?.value));

function sanitizeTurn(turn) {
    const text = typeof turn?.text === "string" ? turn.text.slice(0, 4000) : "";
    const marks = [];
    for (const mark of Array.isArray(turn?.marks) ? turn.marks.slice(0, 50) : []) {
        if (mark?.type === "pin" && Number.isFinite(mark.x) && Number.isFinite(mark.y)) {
            marks.push({ type: "pin", x: mark.x, y: mark.y });
        } else if (mark?.type === "stroke" && Array.isArray(mark.points)) {
            const points = mark.points.slice(0, 4000).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
            if (points.length >= 2) marks.push({ type: "stroke", points: points.map(([x, y]) => [x, y]) });
        }
    }
    return { text, marks };
}

function runCommand(name, value) {
    switch (name) {
        case "stopSpeaking":
            return stopSpeaking();
        case "cancelTurn":
            return cancelTurn();
        case "toggleListening":
            return state.listening ? stopListening() : startListening();
        case "toggleStayLive":
            return toggle("stayLive");
        case "toggleVoiceOut":
            return toggle("voiceOut");
        case "toggleHearing":
            return setHearing(!state.hearing);
        case "cycleTarget":
            return cycleTarget();
        case "approvePeer":
            return decideApproval(String(value), true);
        case "denyPeer":
            return decideApproval(String(value), false);
        case "requestPermission":
            return requestPermission(String(value));
        case "controlDecision":
            return decide(controlRequests, value);
        case "webDecision":
            return decide(webRequests, value);
        case "stopControl":
            return controller?.stop("the user stopped it");
        case "checkAnswer":
            return checks?.answer(value);
        case "explainControl":
            return explainer?.control(String(value ?? ""));
        case "restartHelper":
            return restartHelper();
        case "clearAll":
            return clearScreen("all");
        case "dismiss":
            return clearScreen("visible");
        case "newConversation":
            return newConversation();
        case "openExternal":
            if (/^https:\/\/[^\s]+$/i.test(String(value))) shell.openExternal(String(value));
            return;
        default:
            return;
    }
}

// Shows an approval card; resolves to "once", "always" or "deny" (also when unanswered for 90 s).
function askUser(channel, pending, id, card) {
    return new Promise((resolve) => {
        const finish = (decision) => {
            clearTimeout(timer);
            pending.delete(id);
            send(channel, { type: "ask-done", id });
            resolve(decision);
        };
        const timer = setTimeout(() => finish("deny"), 90_000);
        pending.set(id, finish);
        send(channel, { type: "ask", id, ...card });
    });
}

// Answers an approval card; anything but "once" or "always" denies.
function decide(pending, value) {
    return pending.get(Number(value?.id))?.(["once", "always"].includes(value?.decision) ? value.decision : "deny");
}

function pushState() {
    send("live:state", {
        ...state,
        hotkey: config.hotkey,
        wakeWord: config.wakeWord,
        targets: targetList(),
        resolvedTarget: embedded ? resolveTarget().label : "Ink Brain",
    });
    updateTrayMenu();
}

// ---------------------------------------------------------------- pen mode, listening and speech

function setPen(on, { submitted = false } = {}) {
    if (on === state.pen || !overlay) return;
    state.pen = on;
    if (on) {
        moveOverlayTo(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
        overlay.setIgnoreMouseEvents(false);
        overlay.focus();
        stopSpeaking();
        penFront = null;
        frontmost().then((front) => {
            prepareElements(front);
            if (state.pen) penFront = front;
        });
        if (state.voiceIn) startListening();
    } else {
        overlay.setIgnoreMouseEvents(true, { forward: true });
        if (penFront?.pid) helper.request("activate", { pid: penFront.pid }).catch(() => {});
        if (!submitted) penFront = null;
        scheduleListenStop();
    }
    pushState();
}

async function startListening() {
    clearTimeout(listenTimer);
    if (state.listening || !state.voiceIn) return;
    state.listening = true;
    pushState();
    try {
        await helper.request(
            "listen.start",
            { locale: config.voice.locale ?? undefined, silenceMs: config.voice.silenceMs, allowServer: config.voice.allowServerSpeech },
            { timeoutMs: 120_000 },
        );
    } catch (error) {
        state.listening = false;
        pushState();
        toast(`Voice input is unavailable: ${error.message}`, "warn");
    }
}

async function stopListening() {
    clearTimeout(listenTimer);
    if (!state.listening) return;
    state.listening = false;
    pushState();
    await helper.request("listen.stop", { flush: false }).catch(() => {});
}

// Keep the mic open for a short follow-up window after an answer, then close it unless hands-free is on.
function scheduleListenStop() {
    clearTimeout(listenTimer);
    if (!state.listening || state.pen || state.stayLive || state.thinking || state.speaking) return;
    listenTimer = setTimeout(() => {
        if (!state.pen && !state.stayLive && !state.thinking && !state.speaking) stopListening();
    }, Math.max(0, followUpUntil - Date.now()));
}

function acceptUtterance(text) {
    if (state.pen || Date.now() < followUpUntil) return true;
    if (!state.stayLive) return false;
    const wake = config.wakeWord?.trim();
    // A multi-word wake phrase also matches when speech recognition runs its words together.
    return !wake || new RegExp(`\\b${escapeRegExp(wake).replace(/\s+/g, "\\s*")}\\b`, "i").test(text);
}

function speak(chunks, base) {
    if (!state.voiceOut) return;
    for (const text of chunks) voice.speak(text, `${base}-${++utteranceCount}`);
}

// Queues a line of narration; returns { started, ended } promises, or null with the voice off.
function narrate(text, utterance, pace = 1) {
    if (!state.voiceOut) return null;
    let started;
    let ended;
    const line = { started: new Promise((resolve) => (started = resolve)), ended: new Promise((resolve) => (ended = resolve)) };
    const cleanup = () => {
        clearTimeout(timer);
        voice.off("start", onStart);
        voice.off("end", onEnd);
        started();
        ended();
    };
    const onStart = (event) => event.utterance === utterance && started();
    const onEnd = (event) => event.utterance === utterance && cleanup();
    const timer = setTimeout(cleanup, readingTime(text) * 3 + 60_000);
    voice.on("start", onStart);
    voice.on("end", onEnd);
    voice.speak(text, utterance, pace);
    return line;
}

// Speaks text and resolves once it has been said (or would have been, with the voice off).
function speakAndWait(text, utterance) {
    return narrate(text, utterance)?.ended ?? sleep(readingTime(text));
}

function stopSpeaking() {
    explainer?.cancel("interrupted");
    voice.stop();
}

// Stops narration first so a playing explanation cannot draw its next step on the cleared screen.
function clearScreen(scope) {
    stopSpeaking();
    return overlayCall("clear", { target: "all", scope }).catch(() => {});
}

async function say(text) {
    send("live:turn", { type: "say", text });
    speak([text], "say");
}

function toggle(key) {
    state[key] = !state[key];
    if (key === "stayLive") {
        saveConfig({ stayLive: state.stayLive });
        if (state.stayLive) startListening();
        else scheduleListenStop();
    } else if (key === "voiceOut") {
        saveConfig({ voice: { output: state.voiceOut } });
        if (!state.voiceOut) stopSpeaking();
    } else if (key === "voiceIn") {
        saveConfig({ voice: { input: state.voiceIn } });
        if (!state.voiceIn) stopListening();
        else if (state.pen || state.stayLive) startListening();
    }
    pushState();
}

async function setHearing(on, { persist = true } = {}) {
    if (on === state.hearing) return;
    if (on) {
        try {
            await helper.request("hear.start", { locale: config.voice.locale ?? undefined, allowServer: config.voice.allowServerSpeech, silenceMs: 1500 }, { timeoutMs: 120_000 });
            state.hearing = true;
        } catch (error) {
            toast(`Hear my screen is unavailable: ${error.message}`, "warn");
        }
    } else {
        await helper.request("hear.stop").catch(() => {});
        state.hearing = false;
        heard.length = 0;
    }
    if (persist) saveConfig({ hearScreen: state.hearing });
    pushState();
}

function recentHeard() {
    const cutoff = Date.now() - 120_000;
    const text = heard.filter((entry) => entry.at >= cutoff).map((entry) => entry.text).join(" ");
    if (!text) return null;
    return text.length > 1500 ? `...${text.slice(-1500)}` : text;
}

// ---------------------------------------------------------------- native helper and voice

function wireHelper() {
    helper.on("stt.partial", ({ text }) => send("live:transcript", { text, final: false }));
    helper.on("stt.final", ({ text }) => {
        if (checks?.answerText(text)) return send("live:transcript", { text, final: true, submit: false });
        send("live:transcript", { text, final: true, submit: acceptUtterance(text) });
    });
    helper.on("stt.level", ({ level }) => send("live:level", { level }));
    helper.on("stt.state", ({ listening }) => {
        if (!listening && state.listening) {
            state.listening = false;
            pushState();
        }
    });
    helper.on("stt.error", ({ message, fatal }) => fatal && toast(message, "warn"));
    helper.on("hear.final", ({ text }) => {
        heard.push({ at: Date.now(), text });
        if (heard.length > 300) heard.shift();
    });
    helper.on("hear.state", ({ hearing, error }) => {
        state.hearing = Boolean(hearing);
        if (error) toast(`Hear my screen stopped: ${error}`, "warn");
        pushState();
    });
    helper.on("hear.error", ({ message, fatal }) => fatal && toast(message, "warn"));
    helper.on("log", (text) => DEBUG && console.error(`[helper] ${text.trim()}`));
    helper.on("windows", ({ windows: list }) => {
        windows = Array.isArray(list) ? list : null;
        sendWindows();
        const top = windows?.[0];
        const key = top ? `${top.pid}|${top.title}` : "";
        if (key !== frontKey) {
            frontKey = key;
            noteScreen();
        }
    });
    helper.on("exit", () => {
        Object.assign(state, { listening: false, hearing: false, speaking: false });
        pushState();
        if (quitting) return;
        const delay = restartRequested ? 0 : Math.min(30_000, 1000 * 2 ** helperRestarts++);
        restartRequested = false;
        setTimeout(startHelper, delay);
    });
}

function wireVoice() {
    voice.on("start", () => {
        if (state.speaking) return;
        state.speaking = true;
        pushState();
    });
    voice.on("end", ({ idle }) => {
        if (!idle) return;
        state.speaking = false;
        followUpUntil = Date.now() + config.followUpSeconds * 1000;
        pushState();
        scheduleListenStop();
    });
    let lastProgress = 0;
    voice.on("progress", ({ loaded, total }) => {
        if (Date.now() - lastProgress < 4000) return;
        lastProgress = Date.now();
        toast(`Downloading Ink Brain's voice: ${Math.round((loaded / total) * 100)}% of ${Math.round(total / 1e6)} MB`);
    });
    voice.on("ready", () => DEBUG && console.log("[voice] neural voice ready"));
    voice.on("warn", (message) => toast(message, "warn"));
}

async function startHelper() {
    try {
        await helper.start();
        helperRestarts = 0;
        const fresh = await refreshPermissions();
        if (fresh && !config.inheritPermissions) await clearStaleGrants(fresh);
        helper.request("windows.watch", { excludePids: [process.pid], intervalMs: 250 }).catch(() => {});
        if (needsSetup()) showSetup();
        if (config.hearScreen && !state.hearing) setHearing(true, { persist: false });
        if (state.stayLive) startListening();
    } catch (error) {
        toast(`The native helper did not start (${error.message}). Run "npm run build:helper" and restart Ink Brain.`, "error");
    }
}

function restartHelper() {
    if (helper.running) {
        restartRequested = true;
        helper.stop();
    } else {
        startHelper();
    }
}

async function refreshPermissions() {
    try {
        state.permissions = await helper.request("permissions");
        pushState();
        return state.permissions;
    } catch {
        // The helper is restarting; the next start refreshes permissions.
        return null;
    }
}

function needsSetup() {
    const p = state.permissions;
    if (!p) return false;
    return p.screen !== "granted" || (state.voiceIn && (p.microphone !== "granted" || p.speech !== "granted"));
}

function showSetup(force = false) {
    if (setupShown && !force) return;
    setupShown = true;
    send("live:setup", { show: true });
}

const SETTINGS_PANES = { screen: "Privacy_ScreenCapture", microphone: "Privacy_Microphone", speech: "Privacy_SpeechRecognition", control: "Privacy_Accessibility" };

async function requestPermission(kind) {
    if (!SETTINGS_PANES[kind]) return;
    try {
        state.permissions = await helper.request("requestPermissions", { [kind]: true }, { timeoutMs: 120_000 });
    } catch (error) {
        toast(error.message, "warn");
    }
    if (state.permissions?.[kind] !== "granted") {
        shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANES[kind]}`);
    }
    pushState();
}

// ---------------------------------------------------------------- screen capture and tools

// Some apps (Chromium, Electron) build their accessibility tree only when asked, so ask as soon as a question starts.
const prepareElements = (front) => front?.pid && helper.request("elements.prepare", { pid: front.pid }).catch(() => {});

// Marks that pick out one control snap onto it, using the accessibility elements on top of the screen there.
async function snapShapes(shapes) {
    const wanted = shapes.map(snapPoint);
    if (!wanted.some(Boolean)) return shapes;
    const g = geometry;
    const points = wanted.filter(Boolean).map(([x, y]) => [g.bounds.x + x / g.scale, g.bounds.y + y / g.scale]);
    const found = await helper.request("elements.at", { points, excludePid: process.pid }, { timeoutMs: 4_000 }).catch(() => null);
    if (!found?.allowed) return shapes;
    const model = ({ role, frame: [x, y, w, h] }) => ({ role, x: (x - g.bounds.x) * g.scale, y: (y - g.bounds.y) * g.scale, w: w * g.scale, h: h * g.scale });
    let next = 0;
    return shapes.map((shape, index) => (wanted[index] ? snapShape(shape, (found.elements[next++] ?? []).map(model)) : shape));
}

// Callouts settle onto quiet parts of the screen, judged from a fresh look at it.
async function quietCallouts(shapes) {
    if (!hasCallouts(shapes)) return shapes;
    const g = geometry;
    const shot = await helper.request("capture", { displayId: g.displayId, excludePids: [process.pid], format: "jpeg", quality: 0.8, maxLongEdge: Math.max(g.modelWidth, g.modelHeight) }, { timeoutMs: 8_000 });
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    const { width, height } = image.getSize();
    return settleCallouts(shapes, inkGrid({ width, height, data: image.toBitmap() }), { width, height });
}

// A region in screenshot pixels as overlay pixels, clamped to the display.
function displayRect(region) {
    const s = geometry.scale;
    const x = Math.max(0, Math.min(region.x / s, geometry.width - 1));
    const y = Math.max(0, Math.min(region.y / s, geometry.height - 1));
    return { x, y, w: Math.max(1, Math.min(region.w / s, geometry.width - x)), h: Math.max(1, Math.min(region.h / s, geometry.height - y)) };
}

// Captures the display without the overlay, adding the user's marks and a zoomed crop when useful.
async function captureScreen({ marks = [], region } = {}) {
    const g = geometry;
    let crop = null;
    if (region && ["x", "y", "w", "h"].every((key) => Number.isFinite(region[key]))) {
        crop = displayRect(region);
    } else if (marks.length) {
        crop = cropAround(boundsOfMarks(marks), g.width, g.height);
    }
    const compose = Boolean(crop || marks.length);
    const shot = await helper.request(
        "capture",
        {
            displayId: g.displayId,
            excludePids: [process.pid],
            format: "jpeg",
            quality: compose ? 0.92 : 0.85,
            maxLongEdge: compose ? 0 : Math.max(g.modelWidth, g.modelHeight),
        },
        { timeoutMs: 20_000 },
    );
    if (!compose) return { images: [{ data: shot.data, mimeType: shot.mime }], crop: null };
    const composed = await overlayCall("compose", { image: `data:${shot.mime};base64,${shot.data}`, marks, crop, modelWidth: g.modelWidth, modelHeight: g.modelHeight }, 15_000);
    const images = [{ data: composed.full, mimeType: "image/jpeg" }];
    if (composed.crop) images.push({ data: composed.crop, mimeType: "image/jpeg" });
    return { images, crop };
}

async function look({ region } = {}) {
    send("live:flash", {});
    const [shot, front] = await Promise.all([captureScreen({ region }), frontmost()]);
    const s = geometry.scale;
    const parts = [`Fresh screenshot of the user's display: image 1 is ${geometry.modelWidth}x${geometry.modelHeight} px.`];
    if (shot.crop) {
        const c = shot.crop;
        parts.push(`Image 2 zooms into x=${Math.round(c.x * s)}, y=${Math.round(c.y * s)}, w=${Math.round(c.w * s)}, h=${Math.round(c.h * s)}; keep using image 1 coordinates.`);
    }
    if (front.app) parts.push(`Frontmost app: ${front.app}${front.title ? `, window "${front.title}"` : ""}.`);
    const cursor = cursorInDisplay();
    if (cursor) parts.push(`Mouse cursor: (${Math.round(cursor.x * s)}, ${Math.round(cursor.y * s)}).`);
    return { text: parts.join(" "), images: shot.images };
}

async function runTool(name, args, origin = STANDALONE, callId = undefined) {
    send("live:activity", { name, origin: origin.label });
    try {
        const result = await surface.execute(name, args, origin, callId);
        try {
            keepArtefact(name, args, result);
        } catch (error) {
            console.warn(`Could not remember the ${name} visual: ${error.message}`);
        }
        return result;
    } catch (error) {
        return { text: `${name} failed: ${error.message}`, failed: true };
    }
}

function sdkTools() {
    return STANDALONE_TOOLS.map((spec) => ({
        ...spec,
        skipPermission: true,
        defer: "never",
        handler: async (args, invocation) => toToolResult(await runTool(spec.name, args, STANDALONE, invocation?.toolCallId)),
    }));
}

// Pixels of a screenshot-pixel region at full resolution, without the overlay.
async function captureRegion(region, { format = "png", maxLongEdge = 0 } = {}) {
    const rect = displayRect(region);
    const shot = await helper.request("capture", { displayId: geometry.displayId, excludePids: [process.pid], rect, format, quality: 0.9, maxLongEdge }, { timeoutMs: 20_000 });
    return { ...shot, rect };
}

async function regionImage(region) {
    const shot = await captureRegion(region, { format: "jpeg", maxLongEdge: 2048 });
    return `data:${shot.mime};base64,${shot.data}`;
}

async function cutout(args) {
    if (!isRegion(args)) return { text: "live_cutout needs x, y, w and h.", failed: true };
    const [shot, preview] = await Promise.all([captureRegion(args, { format: "png" }), captureRegion(args, { format: "jpeg", maxLongEdge: 1400 })]);
    const id = cleanId(args.id) || `cutout-${++cutoutCount}`;
    const file = saveCutout(CUTOUTS_DIR, id, shot.data);
    const s = geometry.scale;
    const auto = Math.min(2.2, Math.max(1, 340 / Math.max(shot.rect.w, shot.rect.h)));
    const scale = Number.isFinite(args.scale) ? Math.min(3, Math.max(0.5, args.scale)) : auto;
    const to = Array.isArray(args.to) && args.to.every(Number.isFinite) ? [args.to[0] / s, args.to[1] / s] : null;
    const placed = await overlayCall("cutout", { id, image: `data:${shot.mime};base64,${shot.data}`, from: shot.rect, to, scale, title: String(args.title ?? "").slice(0, 120) });
    const where = placed ? ` It is now at x=${Math.round(placed.x * s)}, y=${Math.round(placed.y * s)}, w=${Math.round(placed.w * s)}, h=${Math.round(placed.h * s)}.` : "";
    return {
        text: `Pulled the region out into the card "${id}".${where} Saved as ${file}; give that path to image_generation as an input image to rework or re-render it.`,
        images: [{ data: preview.data, mimeType: preview.mime }],
    };
}

async function showImage(args) {
    let image;
    try {
        image = readImageFile(args.path, imageRoots());
    } catch (error) {
        return { text: error.message, failed: true };
    }
    const id = cleanId(args.id) || `image-${++imageCount}`;
    const over = isRegion(args.over) ? args.over : null;
    const rect = panelRect(args, over, geometry.scale);
    const before = over && args.compare !== false ? await regionImage(over).catch(() => null) : null;
    await overlayCall("image", { id, image, before, rect, frameless: Boolean(over), title: String(args.title ?? "").slice(0, 120) }, 20_000);
    return { text: over ? `Showing the image over the region${before ? " with a before/after slider" : ""}.` : `Showing the image "${id}".` };
}

// Asks the user before Ink Brain takes control, showing what it wants to do.
function askToControl({ origin, reason, actions }) {
    const s = geometry.scale;
    const steps = actions.map((action) => ({
        action: action.action,
        label: action.label,
        text: action.action === "type" ? String(action.text ?? "").slice(0, 80) : undefined,
        keys: action.keys,
        x: Number.isFinite(action.x) ? action.x / s : undefined,
        y: Number.isFinite(action.y) ? action.y / s : undefined,
    }));
    return askUser("live:control", controlRequests, ++controlRequestCount, { origin: origin.label, reason, steps });
}

function setControlling(on) {
    state.controlling = on;
    if (on) {
        if (state.pen) setPen(false);
        globalShortcut.register("Escape", () => {
            if (Date.now() > syntheticEscapeUntil) controller.stop("the user pressed Esc");
        });
    } else {
        globalShortcut.unregister("Escape");
    }
    send("live:control", { type: on ? "start" : "end" });
    pushState();
}

// ---------------------------------------------------------------- reading the web

// Asks before Ink Brain reads a site it has not been allowed to read; one card at a time.
function askToRead(site, url) {
    const epoch = webEpoch;
    const ask = webQueue.then(async () => {
        if (epoch !== webEpoch) return "deny";
        if (siteAllowed(url, config.webSites)) return "always";
        const decision = await askUser("live:web", webRequests, ++webRequestCount, { site, url: url.slice(0, 300) });
        if (decision === "always") setWebSites([...config.webSites, site]);
        return decision;
    });
    webQueue = ask.catch(() => {});
    return ask;
}

async function readWeb(args) {
    if (config.web === "off") return { text: "The user has turned off web reading. Answer from what is on screen.", failed: true };
    const url = String(args.url ?? "").trim();
    const site = siteOf(url);
    if (!site) return { text: "live_read needs a full http or https address.", failed: true };
    const asking = config.web === "ask";
    const granted = [];
    if (asking && !siteAllowed(url, config.webSites)) {
        if ((await askToRead(site, url)) === "deny") return { text: `The user did not allow reading ${site}. Answer from what is on screen.`, failed: true };
        granted.push(site);
    }
    // Asking keeps every navigation on approved sites; otherwise a page may redirect anywhere on the web.
    const allowed = asking ? (target) => siteAllowed(target, [...granted, ...config.webSites]) : (target) => Boolean(siteOf(target));
    try {
        const page = await reader.read(url, { allowed, refresh: args.refresh === true });
        return { text: describePage(page, { from: args.from, find: args.find }), ...(page.image ? { images: [page.image] } : {}) };
    } catch (error) {
        return { text: `Could not read ${url}: ${error.message}. Answer from what is on screen.`, failed: true };
    }
}

function setWebMode(mode) {
    config.web = mode;
    saveConfig({ web: mode });
    updateTrayMenu();
}

function setWebSites(sites) {
    config.webSites = [...new Set(sites)];
    saveConfig({ webSites: config.webSites });
    updateTrayMenu();
}

// ---------------------------------------------------------------- memory

// live_remember, live_recall and live_reopen.
async function memoryTool(name, args, origin) {
    if (!memoryOn()) return { text: "The user has turned memory off, so nothing is saved or looked up.", failed: true };
    if (name === "live_remember") {
        if (args.forget) return memory.forget(String(args.forget)) ? { text: `Forgot ${args.forget}.` } : { text: `There is no memory ${args.forget}.`, failed: true };
        return { text: `Remembered as ${memory.remember({ text: args.text, topic: args.topic, replaces: args.replaces }).id}.` };
    }
    if (name === "live_recall") {
        const sessions = memoryOn("copilotSessions") ? await embedded.recentSessions() : [];
        const lines = memory.recall({ query: args.query, days: Math.min(365, Math.max(1, Number(args.days) || 30)), sessions, screen: memoryOn("screen") });
        return { text: lines.length ? lines.join("\n") : "Nothing matching was found." };
    }
    const record = memory.artefact(String(args.id ?? ""));
    if (!record) return { text: `There is no visual "${args.id}". Use live_recall to find its id.`, failed: true };
    // Renders laid over a region would cover whatever is there now, so they come back as ordinary panels.
    const replay = { ...record.args };
    delete replay.over;
    delete replay.image_region;
    return surface.execute(record.tool, replay, origin);
}

const ARTEFACT_TOOLS = new Set(["live_panel", "live_explain"]);

// Remembers a visual so it can be found and reopened later; a panel updated in place keeps one entry.
function keepArtefact(name, args, result) {
    if (!memoryOn() || result?.failed || !ARTEFACT_TOOLS.has(name)) return;
    const turn = currentTurn && !currentTurn.done ? currentTurn : null;
    const panel = name === "live_panel" ? result.id : null;
    const title = String(args.title ?? "").trim() || (name === "live_explain" ? String(args.steps?.[0]?.say ?? "Explanation") : `${args.kind} panel`);
    const id = memory.saveArtefact({ id: panel && panelArtefacts.get(panel), tool: name, title, page: pageOf(turn?.front), args });
    if (panel) panelArtefacts.set(panel, id);
    if (turn && !turn.made.includes(id)) turn.made.push(id);
    result.text += ` Saved as ${id}.`;
}

// Records which window and page are in front, so Ink Brain knows what the user has been looking at.
async function noteScreen() {
    const front = memoryOn("screen") ? await frontmost() : {};
    safely(() => memory.observe(pageOf(front), powerMonitor.getSystemIdleTime()));
}

// Memory for a turn's prompt: a digest for a fresh conversation, and what else was on screen.
function memoryContext(brain, front) {
    const remembered = memoryOn() && brain === embedded && embedded.fresh ? safely(() => memory.digest({ sessions: memoryOn("copilotSessions") ? embedded.cachedSessions : [], screen: memoryOn("screen") })) : "";
    const recent = memoryOn("screen") ? safely(() => memory.recentScreen(pageOf(front))) : "";
    return { remembered, recent };
}

function setMemory(part, on) {
    config.memory[part] = on;
    saveConfig({ memory: { [part]: on } });
    if (part !== "copilotSessions") noteScreen();
    updateTrayMenu();
}

function showMemory() {
    const facts = memory.facts();
    const lines = ["### What Ink Brain remembers", ""];
    if (facts.length) for (const f of facts) lines.push(`- **${f.topic}**: ${f.text} \`${f.id}\``);
    else lines.push("Nothing saved yet. Ink Brain saves things it learns about you as you talk, or tell it what to remember.");
    lines.push("", `Screen history is ${memoryOn("screen") ? "on" : "off"}, and your Copilot CLI and App sessions are ${memoryOn("copilotSessions") ? "used" : "not used"}.`);
    lines.push("Ask Ink Brain to change or forget anything, or use **Forget everything** in the menu bar.");
    surface.execute("live_panel", { kind: "markdown", id: "memory", title: "Memory", content: lines.join("\n") }).catch(() => {});
}

async function forgetEverything() {
    const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Forget everything", "Cancel"], defaultId: 1, cancelId: 1, message: "Forget everything Ink Brain remembers?", detail: "This deletes saved memories, past conversations, saved visuals and screen history from this Mac, and starts a new conversation." });
    if (response !== 0) return;
    memory.forgetAll();
    await newConversation();
    toast("Ink Brain has forgotten everything it remembered.");
}

// ---------------------------------------------------------------- linked CLI/App sessions

const SCREEN_TOOLS = new Set(["live_look", "live_cutout", "live_control"]);

async function bridgeTool(name, args, peer) {
    if (!TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    if (SCREEN_TOOLS.has(name) && !(await requestApproval(peer))) {
        return { text: "The user has not allowed this session to see their screen.", failed: true };
    }
    return runTool(name, args, { id: peer.id, label: peer.label });
}

function syncPeers() {
    const connected = new Set(bridge.list().map((peer) => peer.id));
    for (const [id, brain] of linked) {
        if (connected.has(id)) continue;
        linked.delete(id);
        approvals.get(id)?.finish(false);
        controller.forget(id);
        if (currentTurn?.brain === brain) finishTurn(currentTurn, new Error("The linked Copilot session disconnected."));
    }
    for (const peer of bridge.peers.values()) {
        if (!peer.ready || peer.debug || linked.has(peer.id)) continue;
        const brain = new LinkedBrain(peer);
        wireBrain(brain);
        linked.set(peer.id, brain);
    }
    if (!["auto", "standalone"].includes(state.target) && !linked.has(state.target)) state.target = "auto";
    pushState();
}

// Screen access for a linked session needs an explicit yes from the user, once per connection.
function requestApproval(peer) {
    if (peer.approved) return Promise.resolve(true);
    const pending = approvals.get(peer.id);
    if (pending) return pending.promise;
    let finish;
    const promise = new Promise((resolve) => {
        const timer = setTimeout(() => finish(false), 120_000);
        finish = (ok) => {
            clearTimeout(timer);
            approvals.delete(peer.id);
            peer.approved = ok;
            send("live:approval", { id: peer.id, done: true });
            pushState();
            resolve(ok);
        };
    });
    approvals.set(peer.id, { promise, finish });
    send("live:approval", { id: peer.id, label: peer.label, cwd: peer.cwd });
    return promise;
}

function decideApproval(id, ok) {
    const pending = approvals.get(id);
    if (pending) return pending.finish(ok);
    const peer = bridge?.get(id);
    if (peer) peer.approved = ok;
    pushState();
}

function targetList() {
    const list = [
        { id: "auto", label: "Auto" },
        { id: "standalone", label: "Ink Brain" },
    ];
    for (const brain of linked.values()) list.push({ id: brain.id, label: brain.label, cwd: brain.peer.cwd, busy: brain.peer.busy, approved: brain.peer.approved });
    return list;
}

function resolveTarget() {
    if (state.target === "standalone") return embedded;
    if (state.target !== "auto") return linked.get(state.target) ?? embedded;
    const ready = [...linked.values()].filter((brain) => brain.peer.approved && !brain.peer.busy).sort((a, b) => b.peer.connectedAt - a.peer.connectedAt);
    return ready[0] ?? embedded;
}

function setTarget(id) {
    if (id !== "auto" && id !== "standalone") {
        const brain = linked.get(id);
        if (!brain) return;
        // Choosing a session explicitly is consent to send it your screen.
        brain.peer.approved = true;
    }
    state.target = id;
    pushState();
}

function cycleTarget() {
    const ids = targetList().map((target) => target.id);
    setTarget(ids[(ids.indexOf(state.target) + 1) % ids.length]);
}

// ---------------------------------------------------------------- turns

function wireBrain(brain) {
    // Linked sessions tag events with their overlay turn; the embedded brain only runs the current one.
    const turnFor = (key) => (currentTurn?.brain === brain && !currentTurn.done && (!key || key === currentTurn.key) ? currentTurn : null);
    brain.on("delta", (text, key) => {
        const turn = turnFor(key);
        if (!turn || !text) return;
        turn.sawDelta = true;
        appendToTurn(turn, text);
    });
    brain.on("message", (text, key) => {
        const turn = turnFor(key);
        if (!turn) return;
        if (!turn.sawDelta && text) appendToTurn(turn, text);
        if (turn.sawDelta || text) appendToTurn(turn, "\n\n");
        turn.sawDelta = false;
    });
    brain.on("preparing", ({ name }, key) => {
        const turn = turnFor(key);
        if (!turn) return;
        if (DEBUG) console.log(`[turn ${turn.id}] preparing ${name} at ${Date.now() - turn.startedAt} ms`);
        send("live:turn", { type: "preparing", id: turn.id, name });
    });
    // An explanation starts playing while the model is still writing its later steps.
    brain.on("input", ({ id, name, delta }, key) => {
        const turn = turnFor(key);
        if (!turn || name !== "live_explain" || !explainer.feed(id, delta)) return;
        if (DEBUG) console.log(`[turn ${turn.id}] streaming ${name} at ${Date.now() - turn.startedAt} ms`);
        send("live:turn", { type: "tool", id: turn.id, name });
    });
    brain.on("tool", ({ name }, key) => {
        const turn = turnFor(key);
        if (!turn) return;
        if (DEBUG) console.log(`[turn ${turn.id}] ${name} at ${Date.now() - turn.startedAt} ms`);
        send("live:turn", { type: "tool", id: turn.id, name });
    });
    brain.on("idle", (key) => {
        brain.lastIdleAt = Date.now();
        const turn = turnFor(key);
        if (turn?.sentAt) finishTurn(turn);
    });
    brain.on("error", (error, key) => {
        const turn = turnFor(key);
        if (turn) finishTurn(turn, error);
        else if (!key) toast(error.message, "error");
    });
}

function appendToTurn(turn, text) {
    if (!turn.firstTextAt) {
        turn.firstTextAt = Date.now();
        if (DEBUG) console.log(`[turn ${turn.id}] first text after ${turn.firstTextAt - turn.startedAt} ms`);
    }
    turn.text += text;
    send("live:turn", { type: "delta", id: turn.id, text });
    speak(turn.chunker.push(text), `turn-${turn.id}`);
}

function finishTurn(turn, error) {
    if (!turn || turn.done) return;
    turn.done = true;
    if (DEBUG) console.log(`[turn ${turn.id}] ${error ? `failed: ${error.message}` : "done"} after ${Date.now() - turn.startedAt} ms`);
    if (currentTurn === turn) currentTurn = null;
    explainer.close();
    if (!error) speak(turn.chunker.flush(), `turn-${turn.id}`);
    if (!error && memoryOn() && (turn.text.trim() || turn.made.length)) {
        safely(() => {
            memory.logTurn({ app: turn.front?.app, page: pageTitle(turn.front?.title), asked: turn.question || "(pointed at the screen)", answered: turn.text, made: turn.made, via: turn.brain.label });
            if (turn.brain === embedded) memory.noteConversation(embedded.sessionId);
        });
    }
    state.thinking = false;
    send("live:turn", { type: "end", id: turn.id, error: error?.message });
    if (error) toast(error.message, "error");
    if (!state.speaking) followUpUntil = Date.now() + config.followUpSeconds * 1000;
    pushState();
    scheduleListenStop();
    turn.resolveEnded({ text: turn.text.trim(), error: error?.message });
}

async function cancelTurn() {
    const turn = currentTurn;
    if (!turn) return;
    turn.done = true;
    currentTurn = null;
    webEpoch++;
    for (const finish of [...webRequests.values()]) finish("deny");
    stopSpeaking();
    explainer.close();
    state.thinking = false;
    send("live:turn", { type: "end", id: turn.id, cancelled: true });
    turn.resolveEnded({ text: turn.text.trim(), cancelled: true });
    const brain = turn.brain;
    // Only the embedded session needs draining; linked events carry their turn and are ignored once it ends.
    const idle = brain === embedded && turn.sentAt && !(brain.lastIdleAt > turn.sentAt) ? nextIdle(brain, 2_000) : null;
    await brain.abort(turn.key);
    await idle;
    pushState();
}

// Resolves when the brain next goes idle, or after ms.
function nextIdle(brain, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        brain.once("idle", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function newTurn(brain, question) {
    const turn = { id: ++turnCount, key: `${Date.now().toString(36)}-${turnCount}`, brain, question, made: [], text: "", sawDelta: false, done: false, sentAt: 0, startedAt: Date.now() };
    turn.chunker = new SpeechChunker({ maxChars: config.voice.maxSpokenChars });
    turn.ended = new Promise((resolve) => {
        turn.resolveEnded = resolve;
    });
    return turn;
}

async function runTurn({ text, marks }) {
    if (!embedded || !geometry) return { error: "Ink Brain is still starting" };
    await cancelTurn();
    const brain = resolveTarget();
    const turn = newTurn(brain, text);
    currentTurn = turn;
    followUpUntil = 0;
    clearTimeout(listenTimer);
    stopSpeaking();
    state.thinking = true;
    const front = penFront;
    if (state.pen) setPen(false, { submitted: true });
    penFront = null;
    pushState();
    send("live:turn", { type: "start", id: turn.id, question: text, target: brain.label, anchor: boundsOfMarks(marks) });
    send("live:flash", {});
    try {
        const [shot, app] = await Promise.all([captureScreen({ marks }), front?.app ? front : frontmost()]);
        if (turn.done) return turn.ended;
        turn.front = app;
        prepareElements(app);
        const { remembered, recent } = memoryContext(brain, app);
        const prompt = buildTurnPrompt({ text, marks, geometry, cursor: cursorInDisplay(), front: app, heard: recentHeard(), crop: shot.crop, linked: brain !== embedded, turnId: turn.key, remembered, recent, onScreen: surface.onScreen() });
        const attachments = shot.images.map((image, index) => ({ type: "blob", data: image.data, mimeType: image.mimeType, displayName: index ? "zoom.jpg" : "screen.jpg" }));
        turn.sentAt = Date.now();
        if (DEBUG) console.log(`[turn ${turn.id}] screen captured and sent after ${turn.sentAt - turn.startedAt} ms`);
        await brain.send({ prompt, attachments, displayPrompt: text || "(pointed at the screen)" });
        if (brain !== embedded && brain.peer.busy && !turn.firstTextAt) {
            send("live:turn", { type: "status", id: turn.id, text: `Queued until ${brain.label} finishes its current task` });
        }
    } catch (error) {
        const denied = /^Screen capture failed: .*declined/i.test(error.message);
        if (denied) refreshPermissions().then(() => showSetup(true));
        finishTurn(turn, denied ? new Error("Ink Brain can't see your screen yet. Turn on Screen Recording for Ink Brain Helper, then restart the helper.") : error);
    }
    return turn.ended;
}

async function newConversation() {
    await cancelTurn();
    await embedded?.reset();
    memory.endConversation();
    panelArtefacts.clear();
    embedded?.ensure().catch(() => {});
    controller.forget(STANDALONE.id);
    overlayCall("clear", { target: "all" }).catch(() => {});
    toast("Started a new conversation.");
}

// ---------------------------------------------------------------- tray, hotkey and settings

function createTray() {
    tray = new Tray(trayIcon());
    tray.setToolTip("Ink Brain");
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "Ask Ink Brain about your screen", accelerator: config.hotkey, registerAccelerator: false, click: () => setPen(true) },
            { type: "separator" },
            { label: "Talk hands-free", type: "checkbox", checked: state.stayLive, click: () => toggle("stayLive") },
            { label: "Voice input", type: "checkbox", checked: state.voiceIn, click: () => toggle("voiceIn") },
            { label: "Voice replies", type: "checkbox", checked: state.voiceOut, click: () => toggle("voiceOut") },
            { label: "Hear my screen (transcribe audio)", type: "checkbox", checked: state.hearing, click: () => setHearing(!state.hearing) },
            {
                label: "Let Ink Brain take control",
                submenu: [
                    { label: "Ask me first", type: "radio", checked: config.control !== "off", click: () => setControlMode("ask") },
                    { label: "Never", type: "radio", checked: config.control === "off", click: () => setControlMode("off") },
                ],
            },
            {
                label: "Let Ink Brain read web pages",
                submenu: [
                    { label: "Always", type: "radio", checked: config.web !== "ask" && config.web !== "off", click: () => setWebMode("on") },
                    { label: "Ask me for each new site", type: "radio", checked: config.web === "ask", click: () => setWebMode("ask") },
                    { label: "Never", type: "radio", checked: config.web === "off", click: () => setWebMode("off") },
                    { type: "separator" },
                    { label: `Forget allowed sites (${config.webSites.length})`, enabled: config.webSites.length > 0, click: () => setWebSites([]) },
                ],
            },
            {
                label: "Memory",
                submenu: [
                    { label: "Remember things about me", type: "checkbox", checked: memoryOn(), click: () => setMemory("enabled", !config.memory.enabled) },
                    { label: "Remember what's on my screen", type: "checkbox", checked: config.memory.screen, enabled: memoryOn(), click: () => setMemory("screen", !config.memory.screen) },
                    { label: "Use my Copilot CLI and App sessions", type: "checkbox", checked: config.memory.copilotSessions, enabled: memoryOn(), click: () => setMemory("copilotSessions", !config.memory.copilotSessions) },
                    { type: "separator" },
                    { label: "Show what Ink Brain remembers", click: () => showMemory() },
                    {
                        label: "Open memory folder",
                        click: () => {
                            fs.mkdirSync(MEMORY_DIR, { recursive: true });
                            shell.openPath(MEMORY_DIR);
                        },
                    },
                    { label: "Forget everything...", click: () => forgetEverything() },
                ],
            },
            { type: "separator" },
            {
                label: "Send questions to",
                submenu: targetList().map((target) => ({
                    label: `${target.label}${target.busy ? " (busy)" : ""}`,
                    type: "radio",
                    checked: state.target === target.id,
                    click: () => setTarget(target.id),
                })),
            },
            { label: "Clear screen", click: () => clearScreen("all") },
            { label: "New conversation", click: () => newConversation() },
            { type: "separator" },
            { label: `Model: ${state.model}`, enabled: false },
            { label: "Permissions...", click: () => showSetup(true) },
            { label: "Install Copilot CLI and App extension", click: () => installCliExtension() },
            { label: "Open settings file", click: () => openSettings() },
            { type: "separator" },
            { label: "Quit Ink Brain", click: () => app.quit() },
        ]),
    );
}

function setControlMode(mode) {
    config.control = mode;
    saveConfig({ control: mode });
    if (mode === "off") controller.stop("the user turned control off");
    updateTrayMenu();
}

function registerHotkey() {
    const ok = globalShortcut.register(config.hotkey, () => {
        if (controller?.active) return controller.stop("the user pressed the Ink Brain shortcut");
        setPen(!state.pen);
    });
    if (!ok) toast(`Could not register the ${hotkeyLabel()} shortcut. Choose another "hotkey" in ${CONFIG_PATH}.`, "warn");
}

function installCliExtension() {
    try {
        const dir = installExtension();
        toast(`Installed the session extension in ${dir}. Start a new Copilot CLI or App session to use it.`);
    } catch (error) {
        toast(`Could not install the extension: ${error.message}`, "error");
    }
}

function openSettings() {
    ensureConfigDir();
    if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { mode: 0o600 });
    shell.openPath(CONFIG_PATH);
}

// ---------------------------------------------------------------- debug channel (INK_BRAIN_DEBUG=1 only)

async function debugAction(params) {
    switch (params.action) {
        case "state":
            return { state, geometry, peers: bridge.list(), tray: tray?.getBounds() ?? null, voice: voice.engine };
        case "turn":
            return runTurn(sanitizeTurn(params));
        case "pen":
            setPen(Boolean(params.on));
            return { pen: state.pen };
        case "windows":
            debugWindows = Array.isArray(params.windows) ? params.windows : null;
            if (debugWindows) send("live:windows", debugWindows);
            else sendWindows();
            return { windows: debugWindows?.length ?? "live" };
        case "command":
            await runCommand(String(params.name), params.value);
            return { ok: true };
        case "call":
            return overlayCall(String(params.method), params.params ?? {}, 30_000);
        case "tool":
            return runTool(String(params.name), params.args ?? {});
        case "reload":
            overlay.webContents.reload();
            return {};
        case "approve":
            for (const id of [...approvals.keys()]) decideApproval(id, true);
            for (const finish of [...controlRequests.values()]) finish(params.decision ?? "once");
            for (const finish of [...webRequests.values()]) finish(params.decision ?? "once");
            return { approved: true };
        case "memory":
            return { digest: memory.digest({ sessions: embedded.cachedSessions }), recent: memory.recentScreen(null), facts: memory.facts(), conversation: memory.conversation(config.memory.resumeHours), fresh: embedded.fresh };
        case "volume":
            voice.volume = Number.isFinite(params.volume) ? params.volume : 1;
            return { volume: voice.volume };
        case "say": {
            const started = Date.now();
            let first = 0;
            const onStart = () => (first ||= Date.now());
            voice.on("start", onStart);
            await speakAndWait(String(params.text ?? "Hello"), `debug-${started}`);
            voice.off("start", onStart);
            return { engine: voice.engine, firstAudioMs: first ? first - started : null, totalMs: Date.now() - started };
        }
        case "target":
            setTarget(String(params.id));
            return { target: state.target, resolved: resolveTarget().label };
        case "snapshot": {
            const shot = await helper.request("capture", { displayId: geometry.displayId, format: "jpeg", quality: 0.8, maxLongEdge: params.maxLongEdge ?? 1600 }, { timeoutMs: 20_000 });
            return { data: shot.data, width: shot.width, height: shot.height };
        }
        default:
            throw new Error(`Unknown debug action: ${params.action}`);
    }
}

// ---------------------------------------------------------------- lifecycle

// The tool runner and what it drives: the web reader, narrated explanations and taking control.
function createTools() {
    checks = createCheckWaiter({
        show: (check) => overlayCall("check", { question: check.question, choices: publicChoices(check.choices) }),
        pick: (answer) => overlayCall("check-pick", { id: answer?.id ?? "", correct: Boolean(answer?.correct) }).catch(() => {}),
    });
    surface = new Surface({
        overlayCall,
        look,
        say,
        geometry: () => geometry,
        config,
        regionImage,
        readImage: (file) => readImageFile(file, imageRoots()),
        explain: (args, origin, callId) => explainer.play(args, callId),
        askCheck: (check) => checks.ask(check),
        cutout,
        image: showImage,
        control: (args, origin) => controller.run(args, origin),
        read: readWeb,
        memory: memoryTool,
        snap: snapShapes,
        calm: quietCallouts,
    });
    // A plain Chrome user agent, so sites serve the reader the same page they serve the user.
    reader = new Reader({ BrowserWindow, session, userAgent: app.userAgentFallback.replace(new RegExp(` (${escapeRegExp(app.getName())}|Electron)/\\S+`, "g"), "") });
    explainer = new ExplainPlayer({
        surface,
        speak: narrate,
        caption: (event) => send("live:explain", event),
        keepSeconds: config.explanationTtlSeconds,
        hush: () => voice.stop(),
    });
    controller = new Controller({
        helper,
        config,
        look,
        approve: askToControl,
        setControlling,
        toScreen: (x, y) => ({ x: geometry.bounds.x + x / geometry.scale, y: geometry.bounds.y + y / geometry.scale }),
        showPointer: (x, y, text, click) => surface.drawShapes([{ kind: "pointer", x, y, text, click }], { clear: false, ttl: 15 }).catch(() => {}),
        beforeAction: (action) => {
            if (action.action === "key" && /\besc(ape)?\b/i.test(action.keys ?? "")) syntheticEscapeUntil = Date.now() + 1500;
        },
    });
}

async function start() {
    app.dock?.hide();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));
    lockDownSession();
    registerAppProtocol();
    createOverlay();
    createTools();
    embedded = new EmbeddedBrain({
        config,
        tools: sdkTools(),
        extraTools: config.imageGeneration ? ["image_generation"] : [],
        systemMessage: systemMessage({ imageGeneration: config.imageGeneration, web: config.web !== "off" }),
        workspace: WORKSPACE_DIR,
        resumeFrom: () => (memoryOn() ? memory.conversation(config.memory.resumeHours) : null),
    });
    memory.prune();
    setInterval(noteScreen, 30_000);
    for (const event of ["lock-screen", "suspend"]) powerMonitor.on(event, () => memory.observe(null));
    wireBrain(embedded);
    embedded
        .ensure()
        .then(() => {
            state.model = embedded.model;
            pushState();
            if (memoryOn("copilotSessions")) embedded.recentSessions().catch(() => {});
        })
        .catch((error) => toast(`Ink Brain is not ready: ${error.message}. Check that you are signed in to Copilot CLI.`, "error"));
    createTray();
    wireHelper();
    wireVoice();
    startHelper();
    voice.start();
    bridge = new Bridge({ onTool: bridgeTool, onDebug: DEBUG ? debugAction : null });
    bridge.on("peers", syncPeers);
    bridge.on("hello", (peer) => !peer.debug && toast(`Linked ${peer.label}. Copilot there can now draw and talk on your screen.`));
    bridge.start().catch((error) => toast(`The Copilot CLI/App bridge is unavailable: ${error.message}`, "warn"));
    registerHotkey();
    watchDisplays();
    console.log(`Ink Brain is running. Press ${hotkeyLabel()} to ask about anything on your screen.`);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => setPen(true));
    app.on("window-all-closed", () => {});
    app.on("before-quit", () => {
        quitting = true;
    });
    app.on("will-quit", () => {
        memory.flush();
        globalShortcut.unregisterAll();
        bridge?.stop();
        helper.stop();
        voice.stopWorker();
        embedded?.stop();
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());
    app.whenReady()
        .then(start)
        .catch((error) => {
            console.error("Ink Brain failed to start:", error);
            app.exit(1);
        });
}
