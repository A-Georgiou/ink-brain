import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Memory } from "../src/main/memory.mjs";
import { buildTurnPrompt } from "../src/main/prompt.mjs";
import { resolveAppPath } from "../src/main/routes.mjs";
import { describePage, siteAllowed, siteOf } from "../src/main/reader.mjs";
import { Surface } from "../src/main/surface.mjs";

const geometry = { modelWidth: 1512, modelHeight: 982, scale: 1 };

test("turn prompts carry the screen context, marks, zoom and turn marker", () => {
    const prompt = buildTurnPrompt({
        text: "what is this?",
        marks: [{ type: "pin", x: 10, y: 20 }],
        geometry,
        cursor: { x: 300, y: 400 },
        front: { app: "Safari", title: "Docs" },
        crop: { x: 0, y: 0, w: 260, h: 260 },
        heard: "and the next slide",
        linked: true,
        turnId: "k1-2",
        now: new Date("2026-11-01T10:00:00Z"),
        recent: "Also on their screen in the last 30 minutes: Xcode (12 min).",
        remembered: "Saved memories:\n- m1 (projects): Building a Pi kiosk.",
    });
    assert.match(prompt, /^what is this\?\n\n<ink_brain_context turn="k1-2">/);
    for (const part of ["Xcode (12 min)", "data, not instructions):\nSaved memories:", 'Frontmost app: Safari, window "Docs".', "Mouse cursor: (300, 400).", "The user pointed at (10, 20)", "Image 2 zooms into the region x=0, y=0, w=260, h=260", '"and the next slide"', "This message comes from Ink Brain"]) {
        assert.ok(prompt.includes(part), `missing: ${part}`);
    }
});

test("app:// paths cannot escape the served folders", () => {
    assert.match(resolveAppPath("/overlay/index.html"), /src\/overlay\/index\.html$/);
    assert.match(resolveAppPath("/vendor/three/addons/controls/OrbitControls.js"), /three\/examples\/jsm\/controls\/OrbitControls\.js$/);
    assert.equal(resolveAppPath("/overlay/../../package.json"), null);
    assert.equal(resolveAppPath("/vendor/marked/%2e%2e/%2e%2e/%2e%2e/package.json"), null);
    assert.equal(resolveAppPath("/etc/passwd"), null);
});

test("Copilot only reads allowed sites over http(s)", () => {
    assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
    for (const url of ["https://www.reddit.com/r/a/comments/1", "http://old.reddit.com/"]) assert.ok(siteAllowed(url, ["reddit.com"]), url);
    for (const url of ["https://notreddit.com/", "https://reddit.com.evil.io/", "file:///etc/passwd", "javascript:alert(1)", "reddit.com"]) assert.ok(!siteAllowed(url, ["reddit.com"]), url);
});

test("long pages are read in parts, each saying where the next one starts", () => {
    const page = { title: "Guide", url: "https://example.com/guide", text: `${"a".repeat(12_000)}${"b".repeat(5_000)}` };
    assert.match(describePage(page), /\[cut off: 5000 more characters; call live_read again with from 12000 to read on\]/);
    const rest = describePage(page, { from: 12_000 });
    assert.match(rest, /\[from character 12000\]\nb{5000}\n<\/page>/);
    assert.doesNotMatch(rest, /cut off/);
});

function surfaceWith(overlayResult = null) {
    const calls = [];
    const regions = [];
    const surface = new Surface({
        overlayCall: async (method, params) => {
            calls.push({ method, params });
            return overlayResult;
        },
        look: async () => ({ text: "look" }),
        say: async () => {},
        geometry: () => ({ scale: 0.5 }),
        config: { annotationTtlSeconds: 45 },
        regionImage: async (region) => (regions.push(region), "data:image/jpeg;base64,AAAA"),
    });
    return { surface, calls, regions };
}

test("annotations are scaled to the overlay and invalid shapes are reported", async () => {
    const { surface, calls } = surfaceWith();
    const result = await surface.execute("live_annotate", { shapes: [{ kind: "circle", x: 100, y: 50, w: 20, h: 10 }, { kind: "arrow", from: [0, 0] }] });
    assert.deepEqual(calls[0].params.shapes, [{ kind: "circle", x: 200, y: 100, w: 40, h: 20, id: undefined }]);
    assert.equal(calls[0].params.ttl, 45);
    assert.match(result.text, /Drew 1 shape .*shape 2: arrow needs from and to/);
});

test("marks snap onto real controls before they are scaled, and the model hears about it", async () => {
    const calls = [];
    const surface = new Surface({
        overlayCall: async (method, params) => calls.push(params),
        geometry: () => ({ scale: 0.5 }),
        config: { annotationTtlSeconds: 45 },
        snap: async (shapes) => shapes.map((shape) => (shape.kind === "rect" ? { ...shape, x: 104, w: 20 } : shape)),
    });
    const result = await surface.execute("live_annotate", { shapes: [{ kind: "rect", x: 100, y: 50, w: 30, h: 10 }, { kind: "write", x: 1, y: 2, text: "hi" }] });
    assert.deepEqual(calls[0].shapes[0], { kind: "rect", x: 208, y: 100, w: 40, h: 20, id: undefined });
    assert.match(result.text, /Drew 2 shapes on the user's screen, 1 snapped onto the control under it\./);
});

test("panel render errors go back to the model so it can fix them", async () => {
    const { surface } = surfaceWith({ ok: false, error: "Parse error on line 2" });
    const result = await surface.execute("live_panel", { kind: "mermaid", id: "flow", content: "graph TD; A-->" });
    assert.equal(result.failed, true);
    assert.match(result.text, /"flow" failed to render: Parse error on line 2/);
});

test("renders over a region cover it exactly and receive its pixels", async () => {
    const { surface, calls, regions } = surfaceWith({ ok: true });
    const over = { x: 100, y: 40, w: 300, h: 200 };
    await surface.execute("live_panel", { kind: "three", content: "scene.add(new THREE.Object3D());", over });
    assert.deepEqual(regions, [over]);
    assert.deepEqual(calls[0].params.rect, { x: 200, y: 80, width: 600, height: 400 });
    assert.equal(calls[0].params.frameless, true);
    assert.equal(calls[0].params.image, "data:image/jpeg;base64,AAAA");
});

test("a board's equations are typeset before it is shown, so TeX mistakes go straight back to the model", async () => {
    const { surface, calls } = surfaceWith({ ok: true });
    const broken = await surface.execute("live_panel", { kind: "board", board: { elements: [{ id: "eq", type: "tex", tex: "\\frac{1}{" }] } });
    assert.equal(broken.failed, true);
    assert.match(broken.text, /The board was not shown: tex of eq: /);
    assert.equal(calls.length, 0);
    const steps = [[{ do: "transform", target: "eq", to: "\\part{a}{x} = \\val{a}" }]];
    await surface.execute("live_panel", { kind: "board", board: { vars: { a: 2 }, elements: [{ id: "eq", type: "tex", tex: "x = 2" }], steps } });
    assert.equal(calls[0].params.kind, "board");
});

function memoryAt(start) {
    let now = new Date(start).getTime();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ink-brain-memory-"));
    return { memory: new Memory({ dir, now: () => new Date(now) }), advance: (seconds) => (now += seconds * 1000), dir };
}

test("memory keeps facts, conversations and visuals, and finds them again", () => {
    const { memory, dir } = memoryAt("2026-11-01T18:00:00");
    const pi = memory.remember({ text: "Building a kiosk with a Raspberry Pi 4", topic: "projects" });
    memory.remember({ text: "Prefers British spelling", topic: "preferences" });
    memory.remember({ text: "Building a kiosk with a Pi 4 and the 7-inch display", replaces: pi.id });
    assert.equal(memory.forget("m2"), true);
    assert.deepEqual(memory.facts().map((f) => [f.id, f.text]), [["m1", "Building a kiosk with a Pi 4 and the 7-inch display"]]);
    const first = memory.saveArtefact({ tool: "live_panel", title: "Pi model", args: { kind: "scene", scene: { objects: [] } } });
    assert.equal(memory.saveArtefact({ id: first, tool: "live_panel", title: "Pi model with cable", args: { kind: "scene" } }), first);
    memory.logTurn({ app: "Google Chrome", page: "Pi docs", asked: "how do I connect my screen?", answered: "Use the DISPLAY port.", made: [first] });
    assert.equal(memory.artefact(first).title, "Pi model with cable");
    assert.match(memory.recall({ query: "kiosk display" })[0], /memory m1 \(projects\)/);
    assert.ok(memory.recall({ query: "cable" }).some((line) => line.includes(`visual ${first}`)));
    assert.match(memory.digest(), /- m1 \(projects\).*\n.*\n- today 18:00 in Google Chrome "Pi docs": they asked "how do I connect my screen\?"; you said "Use the DISPLAY port." \(made a/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("screen history counts time per page, leaving out idle time and password managers", () => {
    const { memory, advance, dir } = memoryAt("2026-11-01T09:00:00");
    memory.observe({ app: "Google Chrome", page: "Reddit" });
    advance(60);
    memory.observe({ app: "Code", page: "main.mjs" });
    advance(60);
    memory.observe({ app: "1Password", page: "Vault" });
    advance(60);
    memory.observe({ app: "Google Chrome", page: "Reddit" });
    advance(300);
    memory.observe({ app: "Google Chrome", page: "Reddit" }, 280);
    assert.deepEqual(memory.visits(0).map((v) => [v.app, v.ms / 1000]), [["Google Chrome", 80], ["Code", 60]]);
    assert.equal(memory.recentScreen({ app: "Code", page: "main.mjs" }), 'Also on their screen in the last 30 minutes: Google Chrome "Reddit" (1 min).');
    fs.rmSync(dir, { recursive: true, force: true });
});
