// Scores what the user saw and heard, using a vision model from another family than the one under test.
import fs from "node:fs";
import { isRegion } from "../src/shared/geometry.mjs";

const COMMON = {
    correct: "Everything said and shown is accurate, with no mistakes, wrong labels or invented details.",
    complete: "It covers the key points listed for this scenario.",
    clear: "A curious non-expert could follow it: it leads with the answer, takes one idea at a time in plain words, and ends on the takeaway.",
    visual: "The visuals are legible and tidy: nothing overlaps or is cut off, labels are readable, and nothing covers what the user circled or is reading.",
    fit: "It picks the right medium for the question, and its visuals carry the explanation rather than decorate it.",
};

export const CRITERIA = {
    maths: { ...COMMON, insight: "It builds visual intuition the way 3Blue1Brown would: a concrete case first, colour-coded terms that match the picture, transformations you can watch, and the result at the end." },
    "3d": { ...COMMON, fidelity: "The 3D model is a recognisable, accurate model of the exact thing in the picture, with real proportions, the parts that matter in the right places, and motion that matches how it really moves." },
    research: { ...COMMON, grounding: "When the screen is not enough it reads the right source, and the answer reflects what that source says rather than guesses." },
    pointing: { ...COMMON, pointing: "It shows exactly where to click on the user's screen, and its mark lands on the right control." },
    diagram: { ...COMMON, structure: "The diagram's parts, connections and flow are correct, and its layout is easy to read." },
};

const SYSTEM = `You grade Ink Brain, an AI tutor that lives on top of the user's screen. It answers out loud, draws on the screen and opens panels with narrated 2D motion graphics (boards), 3D models (scenes), diagrams and live demos.
You see exactly what the user saw and read what they heard. Grade like a demanding teacher and product designer: a 5 means nothing important could be better, a 3 is acceptable with clear flaws, and a 1 is wrong, missing or unusable.
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
        "A good answer covers:",
        ...scenario.points.map((point) => `- ${point}`),
        `Media that suit this question: ${scenario.expect.join(", ")}.`,
        "",
        "# What Ink Brain did",
        `It said (read aloud and shown in its answer bubble): "${record.text.trim() || "(nothing)"}"`,
    ];
    if (record.captions.length) lines.push("Narrated steps:", ...record.captions.map((c, i) => `${i + 1}. "${c}"`));
    lines.push("Tools, in order:", ...(record.tools.length ? record.tools.map((tool) => `- ${describeTool(tool)}`) : ["- none"]));
    lines.push(`First words after ${seconds(metrics.firstWords)}, first visual after ${seconds(metrics.firstVisual)}, done after ${seconds(metrics.total)}.`);
    const checks = [`board text overlaps: ${metrics.boardOverlaps}, board text off the edge: ${metrics.boardOff}`, `share of the user's target hidden under Ink Brain's own bubble or panels at worst: ${metrics.targetCovered}%`];
    if (metrics.pointed !== undefined) checks.push(`a mark landed on the right control: ${metrics.pointed ? "yes" : "no"}`);
    lines.push(`Automatic checks: ${checks.join("; ")}.`);
    if (record.error) lines.push(`The turn ended with an error: ${record.error}`);
    if (reference) lines.push("", "# Reference", "The source the answer should draw on, for checking facts:", reference.slice(0, 9_000));
    lines.push("", "# Images", `Image 1 is the user's screen when they asked. Images 2 to ${frames.length + 1} are their screen afterwards, in order: ${frames.map((f, i) => `${i + 2} ${f.tag} at ${seconds(f.at)}`).join(", ") || "none"}.`);
    lines.push("", "# Scoring", "Score each criterion from 1 to 5:", ...Object.entries(criteria).map(([key, text]) => `- ${key}: ${text}`));
    lines.push(`Return {"scores": {${Object.keys(criteria).map((key) => `"${key}": n`).join(", ")}}, "issues": ["the most important specific problems, at most five"], "summary": "one sentence"}.`);
    return lines.join("\n");
}

export class Judge {
    // disabledMcpServers keeps the user's own MCP servers from starting for every judgement.
    constructor({ client, model, effort, workspace, disabledMcpServers = [] }) {
        Object.assign(this, { client, model, effort, workspace, disabledMcpServers });
    }

    // Returns { score (mean, 1 to 5), scores, issues, summary }; frames are { path, tag, at }.
    async score({ scenario, meta, record, metrics, reference, screen, frames }) {
        const criteria = Object.keys(CRITERIA[scenario.category]);
        const session = await this.client.createSession({
            model: this.model,
            reasoningEffort: this.effort,
            workingDirectory: this.workspace,
            availableTools: [],
            disabledMcpServers: this.disabledMcpServers,
            skipCustomInstructions: true,
            systemMessage: { mode: "replace", content: SYSTEM },
            onPermissionRequest: async () => ({ kind: "reject" }),
        });
        try {
            const attachments = [screen, ...frames.map((f) => f.path)].map((file, i) => ({ type: "blob", data: fs.readFileSync(file).toString("base64"), mimeType: "image/jpeg", displayName: `image-${i + 1}.jpg` }));
            const reply = await session.sendAndWait({ prompt: promptFor({ scenario, meta, record, metrics, reference, frames }), attachments }, 300_000);
            const json = JSON.parse(String(reply?.data.content ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "null");
            if (!criteria.every((key) => Number.isFinite(Number(json?.scores?.[key])))) throw new Error("the judge did not return every score");
            const scores = Object.fromEntries(criteria.map((key) => [key, Math.min(5, Math.max(1, Number(json.scores[key])))]));
            const score = criteria.reduce((sum, key) => sum + scores[key], 0) / criteria.length;
            return { score, scores, issues: json?.issues ?? [], summary: json?.summary ?? "" };
        } finally {
            await session.disconnect().catch(() => {});
            await this.client.deleteSession(session.sessionId).catch(() => {});
        }
    }
}
