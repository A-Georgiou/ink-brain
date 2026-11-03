// The real overlay page, offscreen over a fixture screenshot, driven the way the main process drives it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import { pageTitle } from "../src/shared/anchors.mjs";
import { auditBoard } from "./board-audit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCREEN = { width: 1512, height: 982 };
const MENU_BAR = 25;
const stages = new Map();

ipcMain.on("live:ready", (event) => stages.get(event.sender)?.ready());
ipcMain.on("live:call-result", (event, message) => stages.get(event.sender)?.settle(message));

// Runs in each panel frame: board text and boxes that overlap each other or leave the board.
function boardCheck() {
    const layer = document.querySelector(".board-html");
    if (!layer) return null;
    const frame = layer.getBoundingClientRect();
    const k = frame.width / 1600;
    const toBoard = (r) => ({ x: (r.left - frame.left) / k, y: (r.top - frame.top) / k, w: r.width / k, h: r.height / k });
    const shown = (el) => getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0.15;
    const texts = [...layer.children].filter((n) => shown(n) && n.getBoundingClientRect().width).map((n) => ({ kind: "text", name: n.textContent.replace(/\s+/g, " ").trim().slice(0, 28), ...toBoard(n.getBoundingClientRect()) }));
    const boxes = [...document.querySelectorAll(".board-cam svg rect[data-fill]")].filter((r) => shown(r.parentNode)).map((r) => ({ kind: "box", name: "box", ...toBoard(r.getBoundingClientRect()) }));
    const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const all = [...texts, ...boxes];
    const overlaps = [];
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            const [a, b] = [all[i], all[j]];
            const area = inter(a, b);
            const small = Math.min(a.w * a.h, b.w * b.h);
            // Text sitting inside a box is that box's label.
            if (area < 150 || area < 0.06 * small || (a.kind !== b.kind && area > 0.85 * (a.kind === "text" ? a.w * a.h : b.w * b.h))) continue;
            overlaps.push(`${a.name} x ${b.name}`);
        }
    }
    const groups = [...document.querySelectorAll(".board-cam svg g[data-board-id]")].filter(shown);
    const nodes = groups.flatMap((g) => {
        const shape = { box: "rect[data-fill]", circle: "circle[data-fill]" }[g.dataset.boardType];
        const node = shape && g.querySelector(shape);
        return node ? [{ id: g.dataset.boardId, shape: g.dataset.boardType, ...toBoard(node.getBoundingClientRect()) }] : [];
    });
    const written = [...layer.children].filter((n) => n.dataset.boardId && shown(n) && n.getBoundingClientRect().width).map((n) => ({ id: n.dataset.boardId, ...toBoard(n.getBoundingClientRect()) }));
    const edges = groups.filter((g) => ["line", "arrow"].includes(g.dataset.boardType) && !g.dataset.boardOn).flatMap((g) => {
        const path = g.querySelector("path[stroke]");
        const matrix = path?.getScreenCTM();
        if (!matrix) return [];
        try {
            const length = path.getTotalLength();
            const count = Math.max(1, Math.min(300, Math.ceil(length / 12)));
            const points = Array.from({ length: count + 1 }, (_, i) => {
                const p = path.getPointAtLength((length * i) / count);
                return [(p.x * matrix.a + p.y * matrix.c + matrix.e - frame.left) / k, (p.x * matrix.b + p.y * matrix.d + matrix.f - frame.top) / k];
            });
            return [{ id: g.dataset.boardId, from: g.dataset.boardFrom, to: g.dataset.boardTo, points }];
        } catch {
            return [];
        }
    });
    return { overlaps, off: texts.filter((t) => t.x < -8 || t.y < -8 || t.x + t.w > 1608 || t.y + t.h > 908).map((t) => t.name), geometry: { nodes, texts: written, edges } };
}

// Runs in each panel frame: whether its 3D view has lost its WebGL context, which leaves the panel blank.
function glLost() {
    return Boolean(document.querySelector("canvas")?.getContext("webgl2")?.isContextLost());
}

// Runs in the overlay: where the answer bubble, captions, panels and the marks that hide what is under them sit.
function layout() {
    const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const shown = (el) => el && !el.classList.contains("hidden") && el.checkVisibility({ opacityProperty: true }) && el.getBoundingClientRect().width > 0;
    // A target dot is a 12px circle drawn around a zero-size node.
    const dot = (el) => ({ x: el.getBoundingClientRect().x - 8, y: el.getBoundingClientRect().y - 8, w: 16, h: 16 });
    return {
        bubble: shown(document.querySelector("#bubble")) ? box(document.querySelector("#bubble")) : null,
        captions: shown(document.querySelector("#captions")) ? box(document.querySelector("#captions")) : null,
        panels: [...document.querySelectorAll("#panels .panel")].filter(shown).map(box),
        notes: [...document.querySelectorAll("#labels .anno-label, #labels .anno-marker, #labels .hand")].filter(shown).map(box).concat([...document.querySelectorAll("#labels .target-dot")].map(dot)),
    };
}

// Opens the overlay over image (a data URL) with Chrome showing a page titled title in front.
export async function openStage({ image, title, onConsole }) {
    const win = new BrowserWindow({
        show: false,
        ...SCREEN,
        useContentSize: true,
        webPreferences: { offscreen: true, preload: path.join(here, "../src/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setFrameRate(30);
    if (onConsole) win.webContents.on("console-message", (event) => event.level !== "info" && onConsole(`${event.level}: ${event.message}`));
    const calls = new Map();
    let count = 0;
    let markReady;
    const ready = new Promise((resolve) => (markReady = resolve));
    stages.set(win.webContents, {
        ready: () => markReady(),
        settle(message) {
            const pending = calls.get(message?.id);
            if (!pending) return;
            calls.delete(message.id);
            clearTimeout(pending.timer);
            if (message.ok) pending.resolve(message.result);
            else pending.reject(new Error(message.error || "Overlay error"));
        },
    });
    await win.loadURL("app://live/overlay/index.html");
    await ready;
    await win.webContents.insertCSS(`html { background: #fff url("${image}") 0 0 / ${SCREEN.width}px ${SCREEN.height}px no-repeat !important; }`);
    const send = (channel, payload) => !win.isDestroyed() && win.webContents.send(channel, payload);
    send("live:windows", [{ id: 1, page: pageTitle(title), x: 0, y: MENU_BAR, w: SCREEN.width, h: SCREEN.height - MENU_BAR }]);
    return {
        send,
        call(method, params = {}, timeoutMs = 10_000) {
            return new Promise((resolve, reject) => {
                const id = ++count;
                const timer = setTimeout(() => {
                    calls.delete(id);
                    reject(new Error(`The overlay did not finish "${method}" in time`));
                }, timeoutMs);
                calls.set(id, { resolve, reject, timer });
                send("live:call", { id, method, params });
            });
        },
        // A JPEG of the screen as the user sees it, with the layout and any board problems at that moment.
        async frame() {
            if (win.isDestroyed()) return null;
            const [image, placed] = await Promise.all([win.webContents.capturePage(), win.webContents.executeJavaScript(`(${layout})()`).catch(() => null)]);
            const frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f.url.includes("sandbox.html"));
            const checks = (await Promise.all(frames.map((f) => f.executeJavaScript(`(${boardCheck})()`).catch(() => null)))).filter(Boolean);
            const boards = checks.map(({ geometry, ...check }) => ({ ...check, ...auditBoard(geometry) }));
            const lost = (await Promise.all(frames.map((f) => f.executeJavaScript(`(${glLost})()`).catch(() => false)))).some(Boolean);
            return { jpeg: image.toJPEG(82), layout: placed, boards, lost };
        },
        close() {
            stages.delete(win.webContents);
            for (const pending of calls.values()) clearTimeout(pending.timer);
            if (!win.isDestroyed()) win.destroy();
        },
    };
}
