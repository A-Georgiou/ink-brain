// Captures fixtures from the real pages (npm run eval:capture -- [--only id,id] [--force] [--elements]): Chrome showing the page, the target, the circle and reference text; --elements only records the page's elements for fixtures that lack them, when the page still matches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";
import { Reader } from "../src/main/reader.mjs";
import { PAGE_ELEMENTS } from "./elements.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");
const [WIDTH, HEIGHT, CHROME] = [1512, 982, 102];
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const force = args.includes("--force");
const elementsOnly = args.includes("--elements");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Offscreen windows render at exactly this size and scale 1, whatever the display.
const offscreen = (height) => new BrowserWindow({ show: false, width: WIDTH, height, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });

// Page helpers for locate functions: TeX by source, elements by text, code lines and article sections.
const HELPERS = () => {
    const tex = (e) => e.querySelector("math")?.getAttribute("alttext") ?? e.querySelector("img")?.alt ?? "";
    const span = (elements) => {
        const rects = elements.filter(Boolean).map((e) => e.getBoundingClientRect());
        if (!rects.length) return null;
        const [l, t] = [Math.min(...rects.map((r) => r.left)), Math.min(...rects.map((r) => r.top))];
        const [r, b] = [Math.max(...rects.map((x) => x.right)), Math.max(...rects.map((x) => x.bottom))];
        const box = Object.assign(document.createElement("div"), { className: "ink-target" });
        Object.assign(box.style, { position: "absolute", left: `${l + scrollX}px`, top: `${t + scrollY}px`, width: `${r - l}px`, height: `${b - t}px`, pointerEvents: "none" });
        document.body.append(box);
        return box;
    };
    globalThis.$ink = {
        math: (fragment) => [...document.querySelectorAll(".mwe-math-element")].find((e) => tex(e).includes(fragment)),
        text: (selector, text) => [...document.querySelectorAll(selector)].find((e) => e.textContent.includes(text)),
        lines(prefix, count) {
            const all = [...document.querySelectorAll(".react-file-line, .blob-code-inner, [data-line-number] + td")];
            const start = all.findIndex((e) => e.textContent.trim().startsWith(prefix));
            return start < 0 ? null : span(all.slice(start, start + count));
        },
        section(id) {
            const heading = document.getElementById(id)?.closest(".mw-heading") ?? document.getElementById(id);
            const parts = [heading];
            for (let e = heading?.nextElementSibling; e && parts.length < 3 && !e.matches(".mw-heading, h2, h3"); e = e.nextElementSibling) if (e.matches("p")) parts.push(e);
            return span(parts);
        },
    };
};

// Banners and notices that a user would long have dismissed.
const CLEANUP = () => {
    const noise = ["#contentSub .mw-revision", "#mw-revision-info", "#siteNotice", "#onetrust-consent-sdk", "#bbccookies", ".fc-consent-root", "#sp-cc", "#ghcc", ".js-consent-banner", "[data-testid='cookie-banner']", ".mdn-cta-container", ".top-banner", "[class*='ConsentBanner']"];
    for (const selector of noise) document.querySelectorAll(selector).forEach((e) => e.remove());
};

// A loose, slightly wobbly loop around the target, drawn the way a user circles with the pen.
function circle({ x, y, w, h }, seed) {
    let n = seed;
    const random = () => ((n = (n * 16807) % 2147483647) / 2147483647) - 0.5;
    const [cx, cy, rx, ry] = [x + w / 2, y + h / 2, w * 0.56 + 16, h * 0.62 + 16];
    const points = Array.from({ length: 56 }, (_, i) => {
        const a = (-100 + (i * 372) / 55) * (Math.PI / 180);
        const k = 1 + random() * 0.05;
        return [Math.round(Math.min(WIDTH - 2, Math.max(2, cx + rx * k * Math.cos(a)))), Math.round(Math.min(HEIGHT - 2, Math.max(2, cy + ry * k * Math.sin(a))))];
    });
    return [{ type: "stroke", points }];
}

// The Mac menu bar and a Chrome window around the page.
function chromeHtml({ title, url, image }) {
    const escape = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!doctype html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;font:13px -apple-system,system-ui,sans-serif;background:#fff">
<div style="height:25px;background:#ececec;display:flex;align-items:center;gap:20px;padding:0 16px;color:#1d1d1f"><b>Google Chrome</b><span>File</span><span>Edit</span><span>View</span><span>History</span><span>Bookmarks</span><span>Profiles</span><span>Tab</span><span>Window</span><span>Help</span></div>
<div style="height:37px;background:#dee1e6;display:flex;align-items:flex-end;gap:8px;padding-left:14px">
<div style="display:flex;gap:8px;align-self:center"><i style="width:12px;height:12px;border-radius:6px;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:6px;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:6px;background:#28c840"></i></div>
<div style="margin-left:22px;height:31px;width:250px;background:#fff;border-radius:9px 9px 0 0;display:flex;align-items:center;padding:0 12px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escape(title)}</div></div>
<div style="height:40px;display:flex;align-items:center;gap:14px;padding:0 14px;border-bottom:1px solid #dadce0;color:#5f6368;font-size:15px"><span>&#8592;</span><span>&#8594;</span><span>&#8635;</span>
<div style="flex:1;height:28px;background:#f1f3f4;border-radius:14px;display:flex;align-items:center;padding:0 16px;font-size:13px;color:#202124;white-space:nowrap;overflow:hidden">${escape(url.replace(/^https?:\/\//, ""))}</div></div>
<img src="${image}" style="display:block;width:${WIDTH}px;height:${HEIGHT - CHROME}px"></body>`;
}

async function capture(scenario, reader) {
    const page = offscreen(HEIGHT - CHROME);
    try {
        await page.loadURL(scenario.url);
        await sleep(scenario.wait ?? 2500);
        const found = await page.webContents.executeJavaScript(`(() => {
            (${HELPERS})();
            (${CLEANUP})();
            const target = (${scenario.locate})();
            if (!target) return false;
            window.__inkTarget = target;
            window.__inkNear = { also: [${(scenario.also ?? []).map((locate) => `(${locate})`)}].map((locate) => locate()), decoys: ${scenario.decoys ? `(${scenario.decoys})()` : "[]"} };
            const r = target.getBoundingClientRect();
            if (r.top < 0 || r.bottom > innerHeight) target.scrollIntoView({ block: "center" });
            return true;
        })()`);
        if (!found) throw new Error("target not found");
        await sleep(900);
        const facts = await page.webContents.executeJavaScript(`(() => {
            const shown = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
            // An element is what it visibly draws (text, images, empty boxes), or the whole box for controls.
            const boxOf = (t) => {
                let rects = [];
                if (!t.matches("button, a, input, select")) {
                    for (const e of [t, ...t.querySelectorAll("*")]) if (((!e.children.length && !e.textContent.trim()) || e.matches("img, svg, canvas, video")) && shown(e)) rects.push(e.getBoundingClientRect());
                    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
                    for (let n; (n = walker.nextNode()); ) {
                        if (!n.textContent.trim() || !shown(n.parentElement)) continue;
                        const range = document.createRange();
                        range.selectNodeContents(n);
                        rects.push(...range.getClientRects());
                    }
                }
                rects = rects.filter((r) => r.width > 1 && r.height > 1);
                if (!rects.length) rects = [t.getBoundingClientRect()];
                const [l, top] = [Math.min(...rects.map((r) => r.left)), Math.min(...rects.map((r) => r.top))];
                const [r, b] = [Math.max(...rects.map((x) => x.right)), Math.max(...rects.map((x) => x.bottom))];
                return { x: l, y: top, w: r - l, h: b - top };
            };
            const t = window.__inkTarget;
            const { also, decoys } = window.__inkNear;
            return { title: document.title, rect: boxOf(t), also: also.filter(Boolean).map(boxOf), decoys: decoys.filter((e) => e && e !== t).map(boxOf), elements: (${PAGE_ELEMENTS})(), link: ${scenario.link ? `(${scenario.link})()` : "null"} };
        })()`);
        const place = (r) => ({ x: Math.round(r.x), y: Math.round(r.y + CHROME), w: Math.round(r.w), h: Math.round(r.h) });
        const saveElements = () => fs.writeFileSync(path.join(FIXTURES, `${scenario.id}.elements.json`), JSON.stringify(facts.elements.map((e) => ({ ...e, ...place(e) }))));
        if (elementsOnly) {
            const stored = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${scenario.id}.json`), "utf8")).target;
            const now = place(facts.rect);
            if (Object.keys(now).some((key) => Math.abs(now[key] - stored[key]) > 3)) return `${scenario.id.padEnd(16)} skipped: the page no longer matches the fixture`;
            saveElements();
            return `${scenario.id.padEnd(16)} recorded ${facts.elements.length} elements`;
        }
        const shot = await page.webContents.capturePage();
        const frame = offscreen(HEIGHT);
        const html = path.join(FIXTURES, `${scenario.id}.frame.html`);
        fs.writeFileSync(html, chromeHtml({ title: facts.title, url: scenario.url, image: `data:image/png;base64,${shot.toPNG().toString("base64")}` }));
        await frame.loadFile(html);
        await sleep(300);
        fs.writeFileSync(path.join(FIXTURES, `${scenario.id}.jpg`), (await frame.webContents.capturePage()).toJPEG(90));
        frame.destroy();
        fs.rmSync(html);
        const target = place(facts.rect);
        const marks = scenario.mark === false ? [] : circle(target, [...scenario.id].reduce((sum, c) => sum + c.charCodeAt(0), 7));
        const meta = { id: scenario.id, url: scenario.url, title: facts.title, app: "Google Chrome", target, marks, link: facts.link, captured: new Date().toISOString() };
        if (facts.also.length) meta.also = facts.also.map(place);
        if (facts.decoys.length) meta.decoys = facts.decoys.map(place);
        saveElements();
        const refUrl = scenario.reference === "page" ? scenario.url : scenario.reference === "link" ? facts.link : null;
        if (refUrl) {
            const read = await reader.read(refUrl, { allowed: () => true, timeoutMs: 20_000 }).catch((error) => ({ error: error.message }));
            meta.reference = { url: refUrl, ok: !read.error, chars: read.text?.length ?? 0 };
            fs.writeFileSync(path.join(FIXTURES, `${scenario.id}.reference.txt`), read.error ? `Could not read ${refUrl}: ${read.error}` : `${read.title}\n${read.url}\n\n${read.text.slice(0, 40_000)}`);
        }
        fs.writeFileSync(path.join(FIXTURES, `${scenario.id}.json`), JSON.stringify(meta, null, 2));
        return `${scenario.id.padEnd(16)} ${target.w}x${target.h} at ${target.x},${target.y}${meta.reference ? `  reference ${meta.reference.ok ? `${meta.reference.chars} chars` : "FAILED"}` : ""}`;
    } finally {
        page.destroy();
    }
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    const userAgent = app.userAgentFallback.replace(/ (Electron|ink-brain)\/\S+/g, "");
    app.userAgentFallback = userAgent;
    const reader = new Reader({ BrowserWindow, session, userAgent });
    for (const scenario of SCENARIOS.filter((s) => !s.fixture && (!only || only.includes(s.id)))) {
        const captured = fs.existsSync(path.join(FIXTURES, `${scenario.id}.json`));
        if (elementsOnly ? !captured : captured && !force) continue;
        console.log(await capture(scenario, reader).catch((error) => `${scenario.id.padEnd(16)} FAILED: ${error.message}`));
    }
    app.quit();
});
