import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Memory } from "../src/main/memory.mjs";
import { buildTurnPrompt } from "../src/main/prompt.mjs";
import { resolveAppPath } from "../src/main/routes.mjs";
import { extractPdf, parseCaptions } from "../src/main/reader-formats.mjs";
import { describePage, Reader, siteAllowed, siteOf } from "../src/main/reader.mjs";
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

test("targeted reads find a later section and preserve versioned source and fragment links", () => {
    const page = {
        title: "Versioned guide",
        url: "https://example.com/guide?version=3#cancellation",
        text: `Contents\nTask cancellation\n${"Introduction.\n".repeat(1500)}\nTask cancellation\nUse try/finally to clean up, then propagate CancelledError.`,
        sections: ["Task cancellation"],
        links: [{ text: "PDF", href: "https://example.com/guide.pdf" }, { text: "Cleanup", href: "https://example.com/guide?version=3#cancellation" }],
    };
    const read = describePage(page, { find: "task cancellation" });
    assert.match(read, /version=3#cancellation/);
    assert.match(read, /Use try\/finally to clean up, then propagate CancelledError/);
    assert.match(read, /PDF -> https:\/\/example.com\/guide.pdf/);
    assert.match(read, /Cleanup -> https:\/\/example.com\/guide\?version=3#cancellation/);
    assert.doesNotMatch(read, /Contents/);
    assert.match(describePage(page, { find: "missing example" }), /No match for "missing example"/);
    const credentialed = describePage({ ...page, url: "https://person:secret@example.com/guide?version=3" });
    assert.match(credentialed, /at https:\/\/example.com\/guide\?version=3/);
    assert.doesNotMatch(credentialed, /person|secret/);
});

test("published captions keep real timestamps and speech, not cue markup or metadata", () => {
    const source = "WEBVTT\n\nNOTE not spoken\nignore this\n\nintro\n00:01:31.870 --> 00:01:37.230 align:start\n<v Strang>First, the <b>row</b> picture\n&amp; one equation.</v>\n\n00:01:37.230 --> 00:01:40.870\nFirst, the row picture & one equation.\n\n01:49.460 --> 01:55.070\nThe column picture.\n";
    assert.equal(parseCaptions(source), "[00:01:31] First, the row picture & one equation.\n[00:01:49] The column picture.");
    assert.equal(parseCaptions("A video description, not a transcript."), "");
});

function readerWithFetch(fetch, BrowserWindow) {
    const ses = {
        fetch,
        setUserAgent() {},
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        on() {},
        webRequest: { onBeforeRequest() {} },
    };
    return new Reader({ BrowserWindow, session: { fromPartition: () => ses }, userAgent: "test" });
}

test("caption reads coalesce and cache, but refresh and permission changes are respected", async () => {
    let calls = 0;
    const caches = [];
    const reader = readerWithFetch(async (_url, options) => {
        calls++;
        caches.push(options.cache);
        return new Response("WEBVTT\n\n00:01:00.000 --> 00:01:05.000\nA sourced result.\n");
    });
    const url = "https://example.com/lecture.vtt";
    const options = { allowed: () => true };
    const reads = await Promise.all([reader.read(url, options), reader.read(url, options)]);
    assert.equal(calls, 1);
    assert.match(reads[0].text, /\[00:01:00\] A sourced result/);
    await reader.read(url, options);
    assert.equal(calls, 1);
    await reader.read(url, { ...options, refresh: true });
    assert.equal(calls, 2);
    assert.deepEqual(caches, ["default", "no-store"]);
    await assert.rejects(reader.read(url, { allowed: () => false }), /not allowed/);
    assert.equal(calls, 2);
    let granted = true;
    let finish;
    const pending = readerWithFetch(() => new Promise((resolve) => (finish = resolve))).read(url, { allowed: () => granted });
    granted = false;
    finish(new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRevoked source.\n"));
    await assert.rejects(pending, /not allowed/);
});

test("PDF and caption redirects never fetch another site without its approval", async () => {
    const requests = [];
    const reader = readerWithFetch(async (url, options) => {
        requests.push(url);
        assert.equal(options.redirect, "manual");
        return url.startsWith("https://other.example")
            ? new Response("WEBVTT\n\n00:01:00.000 --> 00:01:05.000\nAnother site's transcript.\n")
            : new Response(null, { status: 302, headers: { location: "https://other.example/lecture.vtt" } });
    });
    const page = await reader.read("https://example.com/lecture.vtt", { allowed: (url) => siteAllowed(url, ["example.com"]) });
    assert.deepEqual(requests, ["https://example.com/lecture.vtt"]);
    assert.equal(page.elsewhere, "https://other.example/lecture.vtt");
    assert.equal(page.text, "");
    const pdf = await reader.read("https://example.com/paper.pdf", { allowed: (url) => siteAllowed(url, ["example.com"]) });
    assert.equal(pdf.elsewhere, "https://other.example/lecture.vtt");
    assert.equal(pdf.text, "");
    const approved = await reader.read("https://example.com/lecture.vtt", { allowed: () => true });
    assert.match(approved.text, /Another site's transcript/);
    const revoked = await reader.read("https://example.com/lecture.vtt", { allowed: (url) => siteAllowed(url, ["example.com"]) });
    assert.equal(revoked.text, "");
    assert.equal(requests.filter((url) => url.startsWith("https://other.example")).length, 1);
});

test("a slower earlier read cannot replace a refreshed page in the cache", async () => {
    let finish;
    let calls = 0;
    const response = (text) => new Response(`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${text}\n`);
    const reader = readerWithFetch(() => (++calls === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(response("new result"))));
    const url = "https://example.com/live.vtt";
    const older = reader.read(url, { allowed: () => true });
    const newer = await reader.read(url, { allowed: () => true, refresh: true });
    finish(response("old result"));
    await older;
    assert.equal(await reader.read(url, { allowed: () => true }), newer);
    assert.match(newer.text, /new result/);
});

test("oversized and failed transcript reads are rejected, not cached", async () => {
    const responses = [
        new Response("too large", { headers: { "content-length": "2000001" } }),
        new Response("unavailable", { status: 503 }),
        new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRecovered source.\n"),
    ];
    const reader = readerWithFetch(async () => responses.shift());
    const url = "https://example.com/lecture.vtt";
    const options = { allowed: () => true };
    await assert.rejects(reader.read(url, options), /too large/);
    await assert.rejects(reader.read(url, options), /HTTP 503/);
    assert.match((await reader.read(url, options)).text, /Recovered source/);
});

test("a player that removes track elements still exposes its published captions without bypassing site approval", async () => {
    const captionUrl = "https://captions.example/lecture.vtt";
    const root = { innerText: "Lecture description. ".repeat(20), querySelectorAll: () => [] };
    class VideoWindow {
        destroyed = false;
        webContents = {
            setAudioMuted() {},
            setWindowOpenHandler() {},
            on() {},
            async loadURL() {},
            isLoading: () => false,
            executeJavaScriptInIsolatedWorld: async (_world, [{ code }]) =>
                runInNewContext(code, {
                    document: {
                        body: root,
                        title: "Lecture",
                        querySelectorAll: (selector) => (selector.startsWith("script") ? [{ textContent: "{" }, { textContent: '{"@graph":[null,{"@type":"NewsArticle","datePublished":"2026-11-02T06:18:34Z"}]}' }] : []),
                        querySelector: (selector) => (selector.startsWith("video,") ? {} : null),
                    },
                    location: { href: "https://example.com/lecture" },
                    performance: { getEntriesByType: () => [{ name: captionUrl }, { name: captionUrl }] },
                }),
        };
        isDestroyed() {
            return this.destroyed;
        }
        destroy() {
            this.destroyed = true;
        }
    }
    let requests = 0;
    const reader = readerWithFetch(async () => {
        requests++;
        return new Response("WEBVTT\n\n00:01:31.870 --> 00:01:37.230\nThe row picture.\n");
    }, VideoWindow);
    const blocked = await reader.read("https://example.com/lecture", { allowed: (url) => siteAllowed(url, ["example.com"]) });
    assert.equal(requests, 0);
    assert.match(blocked.mediaNote, /not the video/);
    const page = await reader.read("https://example.com/lecture", { allowed: () => true, refresh: true });
    assert.equal(requests, 1);
    assert.equal(page.transcript.url, captionUrl);
    assert.match(page.text, /\[00:01:31\] The row picture/);
    assert.ok(page.text.indexOf("[00:01:31]") < page.text.indexOf("Lecture description."));
    assert.match(describePage(page), /Source publication time \(page metadata\): 2026-11-02T06:18:34Z/);
});

function textPdf(pages) {
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] >>`];
    for (const [i, text] of pages.entries()) {
        const content = `BT /F1 14 Tf 50 700 Td (${text}) Tj ET`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let source = "%PDF-1.4\n";
    const offsets = [0];
    for (const [i, object] of objects.entries()) {
        offsets.push(source.length);
        source += `${i + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = source.length;
    source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(source);
}

test("PDF text is grounded to pages and unreadable PDFs fail explicitly", { skip: process.platform !== "darwin" }, async () => {
    const bytes = textPdf(["First page evidence", "Second page result"]);
    let requests = 0;
    const reader = readerWithFetch(async () => {
        requests++;
        return new Response(bytes);
    });
    const url = "https://example.com/paper.pdf";
    const options = { allowed: () => true };
    const page = await reader.read(url, options);
    assert.equal(page.pageCount, 2);
    assert.match(page.text, /\[Page 1\]\nFirst page evidence/);
    assert.match(page.text, /\[Page 2\]\nSecond page result/);
    const detail = await reader.read(`${url}#page=2`, options);
    assert.equal(detail.pageNumber, 2);
    assert.equal(detail.image.mimeType, "image/jpeg");
    assert.equal(Buffer.from(detail.image.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
    assert.match(detail.text, /\[Page 2\]\nSecond page result/);
    assert.doesNotMatch(detail.text, /First page evidence/);
    assert.equal(await reader.read(url, options), page);
    assert.equal(await reader.read(`${url}#page=2`, options), detail);
    assert.equal(requests, 2);
    await assert.rejects(reader.read(`${url}#page=0`, options), /positive whole number/);
    await assert.rejects(reader.read(`${url}#page=3`, options), /only 2 pages/);
    await assert.rejects(extractPdf(textPdf([""])), /no extractable text/);
    assert.ok((await extractPdf(textPdf([""]), { page: 1 })).image);
    const scanned = await readerWithFetch(async () => new Response(textPdf([""]))).read(url, options);
    assert.equal(scanned.pageNumber, 1);
    assert.ok(scanned.image);
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

test("scene previews reuse successful source captures within an explanation, but retry failures", async () => {
    const { surface, calls } = surfaceWith({ ok: true });
    let captures = 0;
    surface.regionImage = async () => {
        if (++captures === 1) throw new Error("capture not ready");
        return "data:image/jpeg;base64,AAAA";
    };
    const pictures = new Map();
    const body = { id: "body", type: "base", region: { x: 10, y: 20, w: 100, h: 80 } };
    const args = { id: "growing", scene: { objects: [body] } };
    await surface.scene(args, [], pictures);
    assert.equal(JSON.parse(calls.at(-1).params.content).objects[0].picture, null);
    await surface.scene(args, [], pictures);
    await surface.scene({ ...args, scene: { objects: [{ ...body }, { ...body, id: "copy", region: { ...body.region } }] } }, [], pictures);
    assert.equal(captures, 2);
    assert.ok(JSON.parse(calls.at(-1).params.content).objects.every((object) => object.picture === "data:image/jpeg;base64,AAAA"));
    await surface.scene(args, [], new Map());
    assert.equal(captures, 3);
});

test("cancelling a scene during capture never opens a late preview panel", async () => {
    const { surface, calls } = surfaceWith({ ok: true });
    let finish;
    const started = new Promise((resolve) => {
        surface.regionImage = () => new Promise((done) => {
            finish = done;
            resolve();
        });
    });
    const controller = new AbortController();
    const rendering = surface.scene({ scene: { objects: [{ id: "body", type: "base", region: { x: 0, y: 0, w: 100, h: 100 } }] } }, [], new Map(), controller.signal);
    await started;
    controller.abort();
    finish("data:image/jpeg;base64,AAAA");
    await assert.rejects(rendering, { name: "AbortError" });
    assert.deepEqual(calls, []);
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

test("later turns are told what Ink Brain still has on screen, until it clears it", async () => {
    const { surface } = surfaceWith({ ok: true });
    await surface.execute("live_panel", { kind: "markdown", id: "notes", title: "Rain", content: "hi" });
    await surface.execute("live_panel", { kind: "mermaid", id: "flow", content: "graph TD; A-->B" });
    assert.deepEqual(surface.onScreen(), [{ id: "notes", kind: "markdown", title: "Rain" }, { id: "flow", kind: "mermaid", title: "" }]);
    const prompt = buildTurnPrompt({ text: "and the other one?", geometry, onScreen: surface.onScreen() });
    assert.match(prompt, /Still on their screen from earlier \(hidden from the screenshot\): markdown "notes" titled "Rain", mermaid "flow"\./);
    await surface.execute("live_clear", { id: "notes" });
    assert.deepEqual(surface.onScreen(), [{ id: "flow", kind: "mermaid", title: "" }]);
    await surface.execute("live_clear", {});
    assert.deepEqual(surface.onScreen(), []);
    assert.doesNotMatch(buildTurnPrompt({ text: "next", geometry, onScreen: surface.onScreen() }), /Still on their screen/);
});
