// Plays scenarios or compares recorded runs (npm run eval -- [--only id,id] [--category maths,3d] [--repeat 2] [--replay label] [--versus baseline,candidate]).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeImage, protocol, session } from "electron";
import { EmbeddedBrain, effortFor } from "../src/main/brain.mjs";
import { DEFAULTS } from "../src/main/config.mjs";
import { ExplainPlayer } from "../src/main/explain.mjs";
import { readImageFile, saveCutout } from "../src/main/images.mjs";
import { APP_SCHEME, registerAppProtocol } from "../src/main/protocol.mjs";
import { buildTurnPrompt, systemMessage } from "../src/main/prompt.mjs";
import { describePage, Reader, siteOf } from "../src/main/reader.mjs";
import { cleanId, Surface } from "../src/main/surface.mjs";
import { boundsOfMarks, cropAround, isRegion, panelRect } from "../src/shared/geometry.mjs";
import { STANDALONE_TOOLS, toToolResult } from "../src/shared/live-tools.mjs";
import { conversationMetrics, marksFor, pickFrames, turnsOf } from "./conversation.mjs";
import { Judge } from "./judge.mjs";
import { measureLayout } from "./layout.mjs";
import { recordCheck } from "./learner.mjs";
import { printReport, summarize } from "./report.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { openStage, SCREEN } from "./stage.mjs";
import { PairJudge, pairSources, sourceId, summarizePairs } from "./versus.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");
const WORK = path.join(os.tmpdir(), "ink-brain-evals");
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const LABEL = option("label", new Date().toISOString().slice(0, 16).replace(/\D/g, ""));
const OUT = path.join(here, "results", LABEL);
const CONFIG = { ...DEFAULTS, model: option("model", DEFAULTS.model), reasoningEffort: option("effort", DEFAULTS.reasoningEffort) };
const EFFORT = effortFor(CONFIG.model, CONFIG.reasoningEffort);
// One judge from each family under test, so neither family grades only itself.
const JUDGE = { models: option("judge", "gpt-6.1-sol,claude-opus-5.5").split(","), effort: "medium" };
const GEOMETRY = { displayId: 1, bounds: { x: 0, y: 0, ...SCREEN }, ...SCREEN, scale: 1, modelWidth: SCREEN.width, modelHeight: SCREEN.height };
const OWN_TOOLS = new Set(STANDALONE_TOOLS.map((tool) => tool.name));
const VISUAL_TOOLS = new Set(["live_explain", "live_panel", "live_annotate", "live_image", "live_cutout"]);
const VISUAL_CALLS = new Set(["annotate", "panel", "cutout", "image"]);
const STREAM = !argv.includes("--no-stream");
// Replays the tool calls recorded under that label instead of asking the model, to compare rendering alone.
const REPLAY = option("replay", null);
const VERSUS = option("versus", null)?.split(",");
const PAIR_SOURCES = VERSUS && pairSources(VERSUS.join(","));
if (PAIR_SOURCES?.some((source) => source.attempt) && Number(option("repeat", 1)) !== 1) throw new Error("--versus label@attempt needs --repeat 1");
const TURN_TIMEOUT_MS = 8 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Paces narration like the voice does: lines play one after another, a few seconds each.
function narrator() {
    let free = 0;
    return (text) => {
        const start = Math.max(Date.now(), free);
        free = start + Math.min(6_000, Math.max(2_600, text.split(/\s+/).length * 200));
        return { started: sleep(start - Date.now()), ended: sleep(free - Date.now()) };
    };
}

const overlayState = (thinking) => ({ pen: false, listening: false, thinking, speaking: false, controlling: false, stayLive: false, target: "auto", resolvedTarget: "Ink Brain" });
const fixtureOf = (scenario) => scenario.fixture ?? scenario.id;

// Plays one turn on the stage and records what the user would see and hear.
async function play(scenario, dir, { reader, client, replay = null }) {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${fixtureOf(scenario)}.json`), "utf8"));
    const jpeg = fs.readFileSync(path.join(FIXTURES, `${fixtureOf(scenario)}.jpg`));
    const screen = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    const workspace = path.join(WORK, path.basename(dir));
    const roots = [path.join(os.homedir(), ".copilot", "session-state"), workspace];
    const asked = turnsOf(scenario);
    const many = asked.length > 1;
    const record = { text: "", captions: [], tools: [], frames: [], console: [], checks: [], controls: false, error: null, firstWords: null, firstVisual: null, writing: null, streamed: null, total: null, ...(many ? { turns: [] } : {}) };
    let turn = { ask: asked[0].ask, at: 0, text: "", captions: [], tools: [], firstWords: null, firstVisual: null, error: null };
    const stage = await openStage({ image: screen, title: meta.title, onConsole: (line) => record.console.push(line.slice(0, 400)) });
    let start = Date.now();
    const elapsed = () => Date.now() - start;
    const shots = [];
    let shotCount = 0;
    let turnNo = 1;
    const snap = (tag, delay) => {
        const label = many ? `turn ${turnNo} ${tag}` : tag;
        const file = `${String(++shotCount).padStart(2, "0")}-${label.replace(/\W+/g, "-")}.jpg`;
        shots.push(
            sleep(delay).then(async () => {
                const frame = await stage.frame().catch(() => null);
                if (!frame) return;
                fs.writeFileSync(path.join(dir, file), frame.jpeg);
                record.frames.push({ file, tag: label, at: elapsed(), layout: frame.layout, boards: frame.boards });
                if (frame.lost) record.glLost = true;
            }),
        );
    };
    const crop = (region, png = false) => {
        const x = Math.max(0, Math.min(Math.round(region.x), SCREEN.width - 1));
        const y = Math.max(0, Math.min(Math.round(region.y), SCREEN.height - 1));
        const image = nativeImage.createFromBuffer(jpeg).crop({ x, y, width: Math.max(1, Math.min(Math.round(region.w), SCREEN.width - x)), height: Math.max(1, Math.min(Math.round(region.h), SCREEN.height - y)) });
        return (png ? image.toPNG() : image.toJPEG(90)).toString("base64");
    };

    const surface = new Surface({
        // The first visual is when something first appears on screen, which a streamed explanation does before its call finishes.
        overlayCall(method, params, timeoutMs) {
            if (VISUAL_CALLS.has(method)) {
                record.firstVisual ??= elapsed();
                turn.firstVisual ??= elapsed();
            }
            return stage.call(method, params, timeoutMs);
        },
        geometry: () => GEOMETRY,
        config: CONFIG,
        async look({ region } = {}) {
            const parts = [`Fresh screenshot of the user's display: image 1 is ${SCREEN.width}x${SCREEN.height} px.`];
            const images = [{ data: jpeg.toString("base64"), mimeType: "image/jpeg" }];
            if (isRegion(region)) {
                images.push({ data: crop(region), mimeType: "image/jpeg" });
                parts.push(`Image 2 zooms into x=${Math.round(region.x)}, y=${Math.round(region.y)}, w=${Math.round(region.w)}, h=${Math.round(region.h)}; keep using image 1 coordinates.`);
            }
            parts.push(`Frontmost app: Google Chrome, window "${meta.title}".`);
            return { text: parts.join(" "), images };
        },
        say: async (text) => stage.send("live:turn", { type: "say", text }),
        regionImage: async (region) => `data:image/jpeg;base64,${crop(region)}`,
        readImage: (file) => readImageFile(file, roots),
        explain: (args, origin, callId) => explainer.play(args, callId),
        async cutout(args) {
            if (!isRegion(args)) return { text: "live_cutout needs x, y, w and h.", failed: true };
            const id = cleanId(args.id) || "cutout";
            const file = saveCutout(path.join(workspace, "cutouts"), id, crop(args, true));
            await stage.call("cutout", { id, image: `data:image/png;base64,${crop(args, true)}`, from: args, to: null, scale: 1.5, title: String(args.title ?? "").slice(0, 120) });
            return { text: `Pulled the region out into the card "${id}". Saved as ${file}; give that path to image_generation as an input image to rework or re-render it.` };
        },
        async image(args) {
            const over = isRegion(args.over) ? args.over : null;
            const image = readImageFile(args.path, roots);
            await stage.call("image", { id: cleanId(args.id) || "image", image, before: null, rect: panelRect(args, over, 1), frameless: Boolean(over), title: String(args.title ?? "").slice(0, 120) }, 20_000);
            return { text: over ? "Showing the image over the region." : "Showing the image." };
        },
        control: async () => ({ text: "The user did not allow taking control this time.", failed: true }),
        async read(args) {
            const url = String(args.url ?? "").trim();
            if (!siteOf(url)) return { text: "live_read needs a full http or https address.", failed: true };
            try {
                return { text: describePage(await reader.read(url, { allowed: () => true }), { from: args.from }) };
            } catch (error) {
                return { text: `Could not read ${url}: ${error.message}. Answer from what is on screen.`, failed: true };
            }
        },
        // A new user: nothing remembered yet.
        async memory(name, args) {
            if (name === "live_remember") return { text: "Remembered as m-1." };
            if (name === "live_recall") return { text: "Nothing matching was found." };
            return { text: `There is no visual "${args.id}". Use live_recall to find its id.`, failed: true };
        },
        // Shows the question, then answers from this scenario's script. Other lanes own multi-turn; this only answers checks.
        async askCheck(check) {
            const shown = check.choices.map(({ id, label }) => ({ id, label }));
            await stage.call("check", { question: check.question, choices: shown }).catch(() => {});
            const { answer, entry } = recordCheck(scenario, check, record.checks.length);
            record.checks.push({ ...entry, at: elapsed() });
            if (scenario.learner) snap("check", 700);
            if (answer?.id) await stage.call("check-pick", { id: answer.id, correct: Boolean(entry.answer?.correct) }).catch(() => {});
            if (scenario.learner) snap("answered", 600);
            return answer;
        },
    });
    const explainer = new ExplainPlayer({
        surface,
        speak: narrator(),
        caption(event) {
            stage.send("live:explain", event);
            if (event.controls) record.controls = true;
            if (event.type !== "step") return;
            record.captions.push(event.text);
            turn.captions.push(event.text);
            snap(`step ${event.index + 1}`, 2_200);
        },
        keepSeconds: CONFIG.explanationTtlSeconds,
    });
    const runTool = async (name, args, callId) => {
        const entry = { name, at: elapsed(), args };
        record.tools.push(entry);
        turn.tools.push(entry);
        stage.send("live:activity", { name, origin: "Ink Brain" });
        const result = await surface.execute(name, args, "Ink Brain", callId).catch((error) => ({ text: `${name} failed: ${error.message}`, failed: true }));
        Object.assign(entry, { ms: elapsed() - entry.at, failed: Boolean(result.failed), result: String(result.text ?? "").slice(0, 600) });
        if (VISUAL_TOOLS.has(name) && name !== "live_explain" && !result.failed) snap(name, 2_500);
        return result;
    };

    const brain = new EmbeddedBrain({
        config: CONFIG,
        tools: STANDALONE_TOOLS.map((spec) => ({ ...spec, skipPermission: true, defer: "never", handler: async (args, invocation) => toToolResult(await runTool(spec.name, args, invocation?.toolCallId)) })),
        extraTools: CONFIG.imageGeneration ? ["image_generation"] : [],
        systemMessage: systemMessage({ imageGeneration: CONFIG.imageGeneration, web: true }),
        workspace,
    });
    let sawDelta = false;
    const append = (text) => {
        record.firstWords ??= elapsed();
        turn.firstWords ??= elapsed();
        record.text += text;
        turn.text += text;
        stage.send("live:turn", { type: "delta", id: turnNo, text });
    };
    brain.on("delta", (text) => {
        if (!text) return;
        sawDelta = true;
        append(text);
    });
    brain.on("message", (text) => {
        if (!sawDelta && text) append(text);
        if (sawDelta || text) append("\n\n");
        sawDelta = false;
    });
    brain.on("preparing", ({ name }) => stage.send("live:turn", { type: "preparing", id: turnNo, name }));
    brain.on("input", ({ id, name, delta }) => {
        if (name === "live_explain") record.writing ??= elapsed();
        if (!STREAM || name !== "live_explain" || !explainer.feed(id, delta)) return;
        record.streamed = elapsed();
        stage.send("live:turn", { type: "tool", id: turnNo, name });
    });
    brain.on("tool", ({ name }) => {
        stage.send("live:turn", { type: "tool", id: turnNo, name });
        if (OWN_TOOLS.has(name)) return;
        const entry = { name, at: elapsed(), args: {} };
        record.tools.push(entry);
        turn.tools.push(entry);
    });

    try {
        // A conversation plays its turns one after another in the same session, on the screen the earlier turns left behind.
        for (const [index, spec] of asked.entries()) {
            turnNo = index + 1;
            const marks = marksFor(spec, meta, index);
            const zoom = marks.length ? cropAround(boundsOfMarks(marks), SCREEN.width, SCREEN.height) : null;
            const shot = marks.length ? await stage.call("compose", { image: screen, marks, crop: zoom, modelWidth: SCREEN.width, modelHeight: SCREEN.height }, 15_000) : { full: jpeg.toString("base64"), crop: null };
            if (!index) fs.writeFileSync(path.join(dir, "00-screen.jpg"), Buffer.from(shot.full, "base64"));
            const end = marks.at(-1)?.points.at(-1);
            const prompt = buildTurnPrompt({ text: spec.ask, marks, geometry: GEOMETRY, cursor: end && { x: end[0], y: end[1] }, front: { app: "Google Chrome", title: meta.title }, crop: zoom, turnId: String(turnNo) });
            const attachments = [shot.full, shot.crop].filter(Boolean).map((data, i) => ({ type: "blob", data, mimeType: "image/jpeg", displayName: i ? "zoom.jpg" : "screen.jpg" }));
            turn = { ask: spec.ask, marked: Boolean(marks.length), at: index ? elapsed() : 0, text: "", captions: [], tools: [], firstWords: null, firstVisual: null, error: null };
            if (many) record.turns.push(turn);
            // A fresh circle partway through is on no later screenshot, so the judge gets it as its own frame.
            if (index && marks.length) {
                const file = `${String(++shotCount).padStart(2, "0")}-turn-${turnNo}-circled.jpg`;
                fs.writeFileSync(path.join(dir, file), Buffer.from(shot.full, "base64"));
                record.frames.push({ file, tag: `turn ${turnNo} what they circled`, at: elapsed(), layout: null, boards: [] });
            }
            const begin = () => {
                if (!index) start = Date.now();
                stage.send("live:state", overlayState(true));
                stage.send("live:turn", { type: "start", id: turnNo, question: spec.ask, target: "Ink Brain", anchor: boundsOfMarks(marks) });
            };
            let error = null;
            const past = replay && (replay.turns?.[index] ?? (index ? null : replay));
            if (replay) {
                // Plays a recorded turn's own tool calls again at their times, so only the overlay's rendering differs.
                begin();
                for (const tool of past?.tools ?? []) {
                    await sleep(tool.at - elapsed());
                    if (turn.firstWords == null && past.firstWords != null && past.firstWords <= tool.at) append(past.text);
                    if (OWN_TOOLS.has(tool.name) && tool.name !== "live_read") await runTool(tool.name, tool.args, `replay-${record.tools.length}`);
                    else {
                        record.tools.push(tool);
                        turn.tools.push(tool);
                    }
                }
                if (turn.firstWords == null && past?.text) append(past.text);
            } else {
                await brain.ensure();
                const finished = new Promise((resolve) => {
                    brain.once("idle", () => resolve(null));
                    brain.once("error", resolve);
                });
                begin();
                await brain.send({ prompt, attachments });
                error = await Promise.race([finished, sleep(TURN_TIMEOUT_MS).then(() => new Error("the turn timed out"))]);
            }
            record.total = elapsed();
            turn.total = elapsed() - turn.at;
            turn.error = error?.message ?? null;
            record.error = turn.error ?? record.error;
            if (error) await brain.abort();
            explainer.close();
            stage.send("live:turn", { type: "end", id: turnNo, error: turn.error ?? undefined });
            stage.send("live:state", overlayState(false));
            await Promise.all(shots);
            snap(index === asked.length - 1 ? "final" : "answered", 2_500);
            await Promise.all(shots);
            if (error) break;
        }
        record.frames.sort((a, b) => a.at - b.at);
        return record;
    } finally {
        stage.close();
        const id = brain.sessionId;
        await brain.stop();
        if (id) await client.deleteSession(id).catch(() => {});
    }
}

const intersection = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Whether any arrow tip, mark or box centre lands on the target, give or take a few pixels.
function pointedAt(target, tools) {
    const near = ([x, y]) => x >= target.x - 8 && x <= target.x + target.w + 8 && y >= target.y - 8 && y <= target.y + target.h + 8;
    const shapes = tools.flatMap((t) => (t.name === "live_annotate" ? (t.args.shapes ?? []) : t.name === "live_explain" ? (t.args.steps ?? []).flatMap((s) => s.draw ?? []) : []));
    return shapes.some((s) => {
        if (Array.isArray(s.to)) return near(s.to);
        if (Number.isFinite(s.w) && Number.isFinite(s.h)) return near([s.x + s.w / 2, s.y + s.h / 2]);
        return Number.isFinite(s.x) && Number.isFinite(s.y) && near([s.x, s.y]);
    });
}

// Measures what the judge cannot count reliably: media, failures, latency, overlaps and covering the target.
function measure(scenario, meta, record) {
    const media = new Set();
    for (const { name, args = {} } of record.tools) {
        if (name === "live_explain") {
            media.add(args.board ? "board" : args.scene ? "scene" : "annotate");
            if ((args.steps ?? []).some((s) => s.draw?.length)) media.add("annotate");
            for (const step of args.steps ?? []) if (step.panel?.kind) media.add(step.panel.kind);
        } else if (name === "live_panel") media.add(args.kind);
        else if (name === "live_annotate") media.add("annotate");
        else if (name === "live_read") media.add("read");
        else if (name === "live_image" || name === "image_generation") media.add("image");
        else if (name === "live_cutout") media.add("cutout");
    }
    const overlaps = new Set(record.frames.flatMap((f) => f.boards.flatMap((b) => b.overlaps)));
    const off = new Set(record.frames.flatMap((f) => f.boards.flatMap((b) => b.off)));
    const t = meta.target;
    const covered = record.frames.map(({ layout }) => (layout ? [layout.bubble, layout.captions, ...layout.panels].filter(Boolean).reduce((sum, r) => sum + intersection(t, r), 0) / (t.w * t.h) : 0));
    return {
        media: [...media],
        mediaMatch: scenario.expect.some((m) => media.has(m)),
        failedTools: record.tools.filter((tool) => tool.failed).length,
        firstWords: record.firstWords,
        firstVisual: record.firstVisual !== undefined ? record.firstVisual : (record.tools.find((tool) => VISUAL_TOOLS.has(tool.name) && !tool.failed)?.at ?? null),
        total: record.total,
        boardOverlaps: overlaps.size,
        boardOff: off.size,
        ...measureLayout(record.frames, SCREEN),
        targetCovered: Math.round(100 * Math.min(1, Math.max(0, ...covered))),
        pointed: scenario.mark === false ? pointedAt(t, record.tools) : undefined,
        reads: record.tools.filter((tool) => tool.name === "live_read").map((tool) => tool.args.url),
        ...(record.turns ? conversationMetrics(record) : {}),
    };
}

// At most max frames, evenly spread and always keeping the last.
function pick(frames, max = 10) {
    if (frames.length <= max) return frames;
    const step = (frames.length - 1) / (max - 1);
    return Array.from({ length: max }, (_, i) => frames[Math.round(i * step)]);
}

function storedRun(label, id, scenario, meta) {
    const dir = path.join(here, "results", label, id);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "record.json"), "utf8"));
    const screen = path.join(dir, "00-screen.jpg");
    const frames = pick(record.frames, 5).map((frame) => ({ ...frame, path: path.join(dir, frame.file) }));
    if (!fs.existsSync(screen) || frames.some((frame) => !fs.existsSync(frame.path))) throw new Error(`${label}/${id} is missing a screenshot`);
    return { screen, record, frames, metrics: measure(scenario, meta, record) };
}

async function evaluatePair(scenario, attempt, pairJudge) {
    const id = attempt > 1 ? `${scenario.id}~${attempt}` : scenario.id;
    let verdict;
    try {
        if (scenario.turns) throw new Error("pairwise judging covers single-turn scenarios only");
        const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${fixtureOf(scenario)}.json`), "utf8"));
        const [left, right] = PAIR_SOURCES.map((source) => storedRun(source.label, sourceId(source, scenario.id, attempt), scenario, meta));
        if (!fs.readFileSync(left.screen).equals(fs.readFileSync(right.screen))) throw new Error(`${id} used different starting screens`);
        const referenceFile = path.join(FIXTURES, `${fixtureOf(scenario)}.reference.txt`);
        verdict = await pairJudge.compare({
            scenario,
            meta,
            reference: fs.existsSync(referenceFile) ? fs.readFileSync(referenceFile, "utf8") : null,
            screen: left.screen,
            left,
            right,
        });
    } catch (error) {
        verdict = { judgeError: error.message };
    }
    const result = { id, scenario: scenario.id, category: scenario.category, ...verdict };
    const dir = path.join(OUT, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pairwise.json"), JSON.stringify(result, null, 1));
    console.log(`${id.padEnd(18)} ${verdict.winner ?? "error"} ${verdict.preference ?? ""} ${verdict.judgeError ?? ""}`);
    return result;
}

async function evaluate(scenario, attempt, { reader, client, judge }) {
    const id = attempt > 1 ? `${scenario.id}~${attempt}` : scenario.id;
    const dir = path.join(OUT, id);
    let record;
    if (argv.includes("--rejudge")) {
        record = JSON.parse(fs.readFileSync(path.join(dir, "record.json"), "utf8"));
    } else {
        // A 3D panel that lost its WebGL context under the eval's load shows nothing, so that run is played again.
        const replayFile = REPLAY && path.join(here, "results", REPLAY, id, "record.json");
        const replay = replayFile && fs.existsSync(replayFile) ? JSON.parse(fs.readFileSync(replayFile, "utf8")) : null;
        for (let tries = 0; tries < 2 && (!record || record.glLost); tries++) {
            if (record) console.warn(`${id}: a 3D panel lost its WebGL context; playing it again`);
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            record =
                REPLAY && !replay
                    ? { text: "", captions: [], tools: [], frames: [], error: `no recorded run of ${id} in ${REPLAY}` }
                    : await play(scenario, dir, { reader, client, replay }).catch((error) => ({ text: "", captions: [], tools: [], frames: [], error: `eval failed: ${error.message}` }));
        }
        fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify(record, null, 1));
    }
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${fixtureOf(scenario)}.json`), "utf8"));
    const metrics = measure(scenario, meta, record);
    let verdict = {};
    if (judge && fs.existsSync(path.join(dir, "00-screen.jpg"))) {
        const referenceFile = path.join(FIXTURES, `${fixtureOf(scenario)}.reference.txt`);
        const input = {
            scenario,
            meta,
            record,
            metrics,
            reference: fs.existsSync(referenceFile) ? fs.readFileSync(referenceFile, "utf8") : null,
            screen: path.join(dir, "00-screen.jpg"),
            frames: (record.turns ? pickFrames(record, pick) : pick(record.frames)).map((frame) => ({ ...frame, path: path.join(dir, frame.file) })),
        };
        verdict = await judge.score(input).catch((error) => ({ judgeError: error.message }));
    }
    const result = { id, scenario: scenario.id, category: scenario.category, ...verdict, metrics, error: record.error };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 1));
    const scores = verdict.scores ? Object.entries(verdict.scores).map(([key, value]) => `${key} ${Number(value.toFixed(1))}`).join(" ") : (verdict.judgeError ?? "not judged");
    console.log(`${id.padEnd(18)} ${verdict.score?.toFixed(2) ?? " -  "} ${verdict.scores ? (verdict.pass ? "pass" : "FAIL") : "    "}  ${scores}  | media ${metrics.media.join("+") || "none"}${metrics.mediaMatch ? "" : " (MISS)"}  visual ${metrics.firstVisual == null ? "-" : `${(metrics.firstVisual / 1000).toFixed(1)}s`}${record.error ? `  ERROR ${record.error}` : ""}`);
    return result;
}

async function pool(items, size, task) {
    const results = [];
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
    return results;
}

// Keep Chromium caches inside this eval's workspace instead of sharing the running app's profile.
const PROFILE = path.join(WORK, "electron");
fs.mkdirSync(PROFILE, { recursive: true });
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
protocol.registerSchemesAsPrivileged([APP_SCHEME]);
app.on("window-all-closed", () => {});
app.on("child-process-gone", (_event, details) => details.type === "GPU" && console.warn(`The GPU process went away (${details.reason}); 3D panels may be blank`));
app.whenReady().then(async () => {
    registerAppProtocol();
    fs.mkdirSync(OUT, { recursive: true });
    const reader = new Reader({ BrowserWindow, session, userAgent: app.userAgentFallback.replace(/ (Electron|ink-brain)\/\S+/g, "") });
    const { CopilotClient } = await import("@github/copilot-sdk");
    const client = new CopilotClient({ logLevel: "error", workingDirectory: WORK });
    await client.start();
    const mcp = await client.rpc.mcp
        .discover({ workingDirectory: WORK })
        .then(({ servers }) => servers.map((server) => server.name))
        .catch(() => []);
    const judge = argv.includes("--no-judge") ? null : new Judge({ client, ...JUDGE, workspace: WORK, disabledMcpServers: [...mcp, "github-mcp-server"] });
    const only = option("only", "").split(",").filter(Boolean);
    const categories = option("category", "").split(",").filter(Boolean);
    const chosen = SCENARIOS.filter((s) => (!only.length || only.includes(s.id)) && (!categories.length || categories.includes(s.category)));
    const jobs = chosen.flatMap((scenario) => Array.from({ length: Number(option("repeat", 1)) }, (_, i) => [scenario, i + 1]));
    if (VERSUS) {
        if (!judge) throw new Error("--versus requires the judge");
        console.log(`Pairwise ${LABEL}: ${jobs.length} recorded pairs, ${VERSUS.join(" vs ")}, ${JUDGE.models.join(" and ")} in both orders`);
        const pairJudge = new PairJudge({ client, ...JUDGE, workspace: WORK, disabledMcpServers: [...mcp, "github-mcp-server"] });
        const results = await pool(jobs, Number(option("parallel", 4)), ([scenario, attempt]) => evaluatePair(scenario, attempt, pairJudge));
        const summary = { ...summarizePairs(results, VERSUS), at: new Date().toISOString(), results };
        fs.writeFileSync(path.join(OUT, "pairwise-summary.json"), JSON.stringify(summary, null, 1));
        console.log(`Pairwise ${LABEL}: ${summary.scored}/${summary.runs} judged, ${summary.wins ?? 0}/${summary.ties ?? 0}/${summary.losses ?? 0} candidate wins/ties/losses, preference ${summary.preference?.toFixed(2) ?? "-"}, 95% CI ${summary.interval?.map((x) => x.toFixed(2)).join(" to ") ?? "-"}, order disagreements ${summary.orderDisagreements ?? 0}`);
        await client.stop();
        app.quit();
        return;
    }
    console.log(`Eval ${LABEL}: ${jobs.length} runs of ${CONFIG.model} (${EFFORT}${STREAM ? "" : ", not streamed"}), judged by ${judge ? JUDGE.models.join(" and ") : "nobody"}`);
    const results = await pool(jobs, Number(option("parallel", 4)), ([scenario, attempt]) => evaluate(scenario, attempt, { reader, client, judge }));
    // Re-running some scenarios into an existing label replaces just those.
    const summaryFile = path.join(OUT, "summary.json");
    const earlier = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")).results.filter((r) => !results.some((n) => n.id === r.id)) : [];
    const summary = summarize(LABEL, [...earlier, ...results], { model: CONFIG.model, effort: EFFORT, stream: STREAM, judge: JUDGE.models.join("+") });
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
    printReport([summary]);
    await client.stop();
    app.quit();
});
