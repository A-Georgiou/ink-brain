import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Memory } from "../src/main/memory.mjs";
import { resolveAppPath } from "../src/main/routes.mjs";
import { siteAllowed, siteOf } from "../src/main/reader.mjs";

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
