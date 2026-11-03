// Scores what the user saw and heard with a panel of vision models, then turns their evidence and the automatic checks into hard limits.
import fs from "node:fs";
import { isRegion } from "../src/shared/geometry.mjs";

// Each criterion says what it asks, then what each score means.
const COMMON = {
    correct: "Everything said and shown is accurate. 5 no mistakes at all; 4 one small imprecision; 3 several imprecisions; 2 a real mistake that would mislead; 1 mostly wrong.",
    complete: "It covers the key points listed for this scenario. 5 every point clearly covered; 4 one only touched on; 3 one missing or several thin; 2 two missing; 1 most missing.",
    clear: "A curious non-expert could follow it. 5 it leads with the answer, takes one idea per step in plain words and ends on the takeaway; 4 easy to follow, with small detours or jargon; 3 followable but muddled, too dense, or leaning on visuals that do not work; 2 hard to follow; 1 confusing.",
    visual: "The visuals are legible and tidy. 5 every frame is clean: nothing overlaps, is cut off, is too small to read or covers what the user circled or is reading; 4 one small blemish; 3 crowded, small or several blemishes; 2 a blank, broken, unreadable or badly placed visual; 1 unusable or none.",
    fit: "It uses the media that suit the question, and the visuals carry the explanation. 5 the ideal medium, used so well the visuals alone would teach the core idea; 4 the right medium carrying most of it; 3 the visuals only illustrate while the narration does the teaching; 2 crude or decorative visuals, or the wrong medium; 1 nothing useful shown.",
};

export const CRITERIA = {
    maths: { ...COMMON, insight: "It builds visual intuition the way 3Blue1Brown would. 5 a concrete case with real numbers, colour-coded terms that match the picture and a transformation you watch that makes the key step obvious, ending on the result; 3 a correct picture that illustrates but builds no intuition; 1 no visual intuition." },
    "3d": { ...COMMON, fidelity: "What it built or drew is an accurate model of the exact thing in the picture, and moves like it. 5 you would recognise this exact object: real proportions, the parts that matter in the right places and true motion; 4 clearly this object with small inaccuracies; 3 recognisably this object but simplified, with the key mechanism clearly right; 2 generic or crude, barely recognisable as this object, or the key part or motion is wrong or hard to see; 1 unrecognisable, broken or missing." },
    research: { ...COMMON, grounding: "The answer rests on the right source. 5 it read the right source, enough of it, and every claim matches it; 3 it read something relevant but goes beyond or misses what it says; 2 it did not read when it needed to, or misreports the source; 1 invented." },
    pointing: { ...COMMON, pointing: "It shows exactly where to act on the user's screen. 5 a mark sits exactly on the right control and every step is shown or said in order; 3 the mark is near but ambiguous, or a step is missing; 2 the mark misses the control; 1 no mark." },
    diagram: { ...COMMON, structure: "The diagram is right and readable. 5 every part, connection and direction matches the source, laid out so the flow reads at a glance; 3 mostly right but with a wrong or missing link, or cluttered; 1 wrong or unreadable." },
};

const SYSTEM = `You grade Ink Brain, an AI tutor that lives on top of the user's screen. It answers out loud, draws on the screen and opens panels with narrated 2D motion graphics (boards), 3D models (scenes), diagrams and live demos.
You see exactly what the user saw and read what they heard. Grade strictly, like a demanding teacher and product designer deciding whether this is ready to ship:
- Judge the experience, not the intent. A point counts only if it was said or shown, and a visual only helps if it is legible and shows what was asked about. Good narration does not rescue a visual that fails.
- 5 is excellent with nothing important to improve, and rare. 4 is good with only small flaws. 3 is acceptable but clearly flawed. 2 is poor. 1 failed.
- When torn between two scores, give the lower one.
Reply with JSON only.`;

const seconds = (ms) => (ms == null ? "never" : `${(ms / 1000).toFixed(1)} s`);

// One line per tool call, with what it drew or read.
export function describeTool(tool) {
    const a = tool.args ?? {};
    const head = `${seconds(tool.at)} ${tool.name}`;
    const count = (list) => (Array.isArray(list) ? list.length : 0);
    const what = {
        live_explain: () => `"${a.title ?? ""}", ${count(a.steps)} narrated steps on ${a.board ? `a board of ${count(a.board.elements)} elements` : a.scene ? `a 3D scene of ${count(a.scene.objects)} objects` : "the screen"}`,
        live_panel: () => `${a.kind} panel "${a.title ?? ""}"${a.kind === "scene" ? ` of ${count(a.scene?.objects)} objects` : a.kind === "board" ? ` of ${count(a.board?.elements)} elements` : ""}`,
        live_annotate: () => (a.shapes ?? []).map((s) => `${s.kind}${s.text ? ` "${s.text}"` : ""}`).join(", "),
        live_read: () => a.url,
        live_look: () => (isRegion(a.region) ? "zoomed in" : "full screen"),
    }[tool.name];
    return `${head}${what ? `: ${what()}` : ""}${tool.failed ? ` (failed: ${tool.result})` : ""}`;
}

function promptFor({ scenario, meta, record, metrics, reference, frames }) {
    const criteria = CRITERIA[scenario.category];
    const t = meta.target;
    const lines = [
        "# Scenario",
        `The user had "${meta.title}" (${meta.url}) open in Chrome. ${meta.marks.length ? `They circled x=${t.x}, y=${t.y}, w=${t.w}, h=${t.h} (magenta in image 1)` : "They did not mark anything"} and asked: "${scenario.ask}"`,
        "Key points a good answer covers:",
        ...scenario.points.map((point, i) => `${i + 1}. ${point}`),
        `Media that suit this question: ${scenario.expect.join(", ")}.`,
        "",
        "# What Ink Brain did",
        `It said (read aloud and shown in its answer bubble): "${record.text.trim() || "(nothing)"}"`,
    ];
    if (record.captions.length) lines.push("Narrated steps:", ...record.captions.map((c, i) => `${i + 1}. "${c}"`));
    lines.push("Tools, in order:", ...(record.tools.length ? record.tools.map((tool) => `- ${describeTool(tool)}`) : ["- none"]));
    const checks = [`board text overlaps: ${metrics.boardOverlaps}, board text off the edge: ${metrics.boardOff}`, `share of the user's target hidden under Ink Brain's own bubble or panels at worst: ${metrics.targetCovered}%`];
    if (metrics.pointed !== undefined) checks.push(`a mark landed on the right control: ${metrics.pointed ? "yes" : "no"}`);
    lines.push(`Automatic checks: ${checks.join("; ")}.`);
    if (record.error) lines.push(`The turn ended with an error: ${record.error}`);
    if (reference) lines.push("", "# Reference", "The source the answer should draw on, for checking facts:", reference.slice(0, 9_000));
    lines.push("", "# Images", `Image 1 is the user's screen when they asked. Images 2 to ${frames.length + 1} are their screen afterwards, in order: ${frames.map((f, i) => `${i + 2} ${f.tag} at ${seconds(f.at)}`).join(", ") || "none"}.`);
    lines.push(
        "",
        "# Grading",
        "Speed is measured separately, so do not score it. Collect the evidence first:",
        "- points: one entry per key point, in order: whether it was said (aloud, in the bubble or in a narrated step) and whether a visual showed it, each yes, partly or no, with where in a few words.",
        "- errors: every mistake, wrong label or invented detail; major if it would mislead the user or break what they are doing, otherwise minor.",
        "- defects: every visual problem in images 2 onwards; major for a blank, broken or unreadable visual, otherwise minor. How much Ink Brain hides of what the user circled is measured automatically.",
        "Then score each criterion from 1 to 5:",
        ...Object.entries(criteria).map(([key, text]) => `- ${key}: ${text}`),
        `Return {"points": [{"said": "yes|partly|no", "shown": "yes|partly|no", "where": "..."}], "errors": [{"severity": "major|minor", "what": "..."}], "defects": [{"severity": "major|minor", "image": 2, "what": "..."}], "scores": {${Object.keys(criteria).map((key) => `"${key}": n`).join(", ")}}, "issues": ["the most important specific problems, at most five"], "summary": "one sentence"}.`,
    );
    return lines.join("\n");
}

const LEVEL = { yes: 1, partly: 0.5, no: 0 };
const severities = (list) => {
    const items = Array.isArray(list) ? list : [];
    const major = items.filter((item) => item?.severity === "major").length;
    return [major, items.length - major];
};

// Hard limits from the judge's own evidence and the automatic checks, so a lenient score cannot hide a failure.
export function limitsFor({ scenario, record, metrics }, evidence) {
    const limits = [];
    const limit = (key, max, why) => limits.push({ key, max, why });
    const points = Array.isArray(evidence.points) ? evidence.points : [];
    const covered = points.map((p) => Math.max(LEVEL[p?.said] ?? 0, LEVEL[p?.shown] ?? 0));
    const [missing, partly] = [covered.filter((c) => c === 0).length, covered.filter((c) => c === 0.5).length];
    if (missing + partly) limit("complete", Math.max(1, 5 - 2 * missing - partly), `${missing} key points missing and ${partly} partly covered`);
    if (scenario.category !== "research" && points.length && !points.some((p) => LEVEL[p?.shown])) limit("fit", 2, "the visuals showed none of the key points");
    const [majorErrors, minorErrors] = severities(evidence.errors);
    if (majorErrors) limit("correct", majorErrors > 1 ? 1 : 2, `${majorErrors} misleading mistakes`);
    else if (minorErrors) limit("correct", 5 - Math.min(2, minorErrors), `${minorErrors} small mistakes`);
    const [majorDefects, minorDefects] = severities(evidence.defects);
    if (majorDefects) limit("visual", 2, `${majorDefects} broken, unreadable or obstructing visuals`);
    else if (minorDefects) limit("visual", 5 - Math.min(2, minorDefects), `${minorDefects} visual blemishes`);
    if (metrics.boardOverlaps || metrics.boardOff) limit("visual", 3, "board text overlaps or runs off the board");
    if (metrics.targetCovered >= 20) limit("visual", metrics.targetCovered >= 50 ? 2 : 3, `Ink Brain hid ${metrics.targetCovered}% of what the user circled`);
    if (!metrics.mediaMatch) limit("fit", 2, `it used ${metrics.media.join(" and ") || "nothing"} where ${scenario.expect.join(" or ")} suits`);
    if (metrics.pointed === false) limit("pointing", 2, "no mark landed on the control");
    if (scenario.category === "research" && !record.tools.some((tool) => tool.name === "live_read" && !tool.failed)) limit("grounding", 2, "it read nothing");
    if (record.error) for (const key of Object.keys(CRITERIA[scenario.category])) limit(key, 2, `the turn failed: ${record.error}`);
    return limits;
}

// Each category's own criterion comes last: it is what the user asked for.
export const coreOf = (category) => Object.keys(CRITERIA[category]).at(-1);

// The mean of the criteria, but at most one point above the weakest and half a point above the core one.
export function overall(scores, core) {
    const values = Object.values(scores);
    return Math.min(values.reduce((sum, value) => sum + value, 0) / values.length, Math.min(...values) + 1, scores[core] + 0.5);
}

// A run passes when every criterion is at least good.
export const passes = (scores) => Math.min(...Object.values(scores)) >= 4;

// Flag panel uncertainty without changing its strict scores or caps.
export function judgeDisagreement({ category, judges }) {
    const scored = judges?.filter((judge) => judge.scores) ?? [];
    if (scored.length < 2) return { large: [], overallGap: null, flagged: true, missing: (judges?.length ?? 2) - scored.length };
    const core = coreOf(category);
    const gaps = Object.fromEntries(Object.keys(scored[0].scores).map((key) => [key, Math.abs(scored[0].scores[key] - scored[1].scores[key])]));
    const large = Object.entries(gaps).filter(([, gap]) => gap >= 2).map(([key]) => key);
    const overallGap = Math.abs(overall(scored[0].scores, core) - overall(scored[1].scores, core));
    return { large, overallGap, flagged: large.length > 0 || overallGap >= 1, missing: (judges?.length ?? 2) - scored.length };
}

export class Judge {
    // models is the panel, ideally from different families than the model under test; disabledMcpServers keeps the user's MCP servers from starting.
    constructor({ client, models, effort, workspace, disabledMcpServers = [] }) {
        Object.assign(this, { client, models, effort, workspace, disabledMcpServers });
    }

    async #ask(model, input) {
        const keys = Object.keys(CRITERIA[input.scenario.category]);
        const session = await this.client.createSession({
            model,
            reasoningEffort: this.effort,
            workingDirectory: this.workspace,
            availableTools: [],
            disabledMcpServers: this.disabledMcpServers,
            skipCustomInstructions: true,
            systemMessage: { mode: "replace", content: SYSTEM },
            onPermissionRequest: async () => ({ kind: "reject" }),
        });
        try {
            const attachments = [input.screen, ...input.frames.map((f) => f.path)].map((file, i) => ({ type: "blob", data: fs.readFileSync(file).toString("base64"), mimeType: "image/jpeg", displayName: `image-${i + 1}.jpg` }));
            const reply = await session.sendAndWait({ prompt: promptFor(input), attachments }, 300_000);
            const json = JSON.parse(String(reply?.data.content ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "null");
            if (!keys.every((key) => Number.isFinite(Number(json?.scores?.[key])))) throw new Error(`${model} did not return every score`);
            if (json.points?.length !== input.scenario.points.length) throw new Error(`${model} did not check every key point`);
            const given = Object.fromEntries(keys.map((key) => [key, Math.min(5, Math.max(1, Math.round(Number(json.scores[key]))))]));
            const limits = limitsFor(input, json);
            const scores = Object.fromEntries(keys.map((key) => [key, Math.min(given[key], ...limits.filter((l) => l.key === key).map((l) => l.max))]));
            return { model, scores, given, limits, points: json.points, errors: json.errors ?? [], defects: json.defects ?? [], issues: json.issues ?? [], summary: json.summary ?? "" };
        } finally {
            await session.disconnect().catch(() => {});
            await this.client.deleteSession(session.sessionId).catch(() => {});
        }
    }

    // Returns { score, scores, pass, judges, issues, summary }, averaging the panel; frames are { path, tag, at }.
    async score(input) {
        const asked = await Promise.all(
            this.models.map(async (model) => {
                for (let tries = 0; ; tries++) {
                    try {
                        return await this.#ask(model, input);
                    } catch (error) {
                        if (tries) return { model, failed: error.message };
                    }
                }
            }),
        );
        const judges = asked.filter((j) => j.scores);
        if (!judges.length) throw new Error(asked.map((j) => j.failed).join("; "));
        const keys = Object.keys(judges[0].scores);
        const scores = Object.fromEntries(keys.map((key) => [key, judges.reduce((sum, j) => sum + j.scores[key], 0) / judges.length]));
        return { score: overall(scores, coreOf(input.scenario.category)), scores, pass: passes(scores), judges: asked, disagreement: judgeDisagreement({ category: input.scenario.category, judges: asked }), issues: judges.flatMap((j) => j.issues).slice(0, 8), summary: judges.map((j) => j.summary).join(" ") };
    }
}
