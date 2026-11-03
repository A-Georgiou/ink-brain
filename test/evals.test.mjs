import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeDisagreement, limitsFor, overall, passes } from "../evals/judge.mjs";
import { measureLayout } from "../evals/layout.mjs";
import { compareRuns, sameCodeControl } from "../evals/stats.mjs";
import { PairJudge, pairOutcome, pairPrompt, summarizePairs } from "../evals/versus.mjs";

const run = (category, metrics = {}, tools = []) => ({
    scenario: { category, expect: ["board"], points: ["a", "b", "c"] },
    record: { tools, error: null },
    metrics: { boardOverlaps: 0, boardOff: 0, targetCovered: 0, mediaMatch: true, media: ["board"], ...metrics },
});
const caps = (limits) => Object.fromEntries(limits.map((l) => [l.key, l.max]));

test("the judge's evidence caps its own scores", () => {
    const evidence = {
        points: [{ said: "yes", shown: "yes" }, { said: "partly", shown: "no" }, { said: "no", shown: "no" }],
        errors: [{ severity: "major" }, { severity: "minor" }],
        defects: [{ severity: "minor" }],
    };
    assert.deepEqual(caps(limitsFor(run("maths"), evidence)), { complete: 2, correct: 2, visual: 4 });
});

test("automatic checks cap fit, visuals, pointing and grounding", () => {
    const points = [{ said: "yes", shown: "no" }, { said: "yes", shown: "no" }, { said: "yes", shown: "no" }];
    assert.deepEqual(caps(limitsFor(run("pointing", { pointed: false, targetCovered: 60, mediaMatch: false, media: [] }), { points })), { fit: 2, visual: 2, pointing: 2 });
    assert.deepEqual(caps(limitsFor(run("research", {}, [{ name: "live_read", failed: true }]), { points })), { grounding: 2 });
});

test("one weak criterion sinks the overall score and the pass", () => {
    const scores = { correct: 5, complete: 5, clear: 5, visual: 5, fit: 5, fidelity: 2 };
    assert.equal(overall(scores, "fidelity"), 2.5);
    assert.equal(overall({ ...scores, correct: 2, fidelity: 5 }, "fidelity"), 3);
    assert.equal(passes(scores), false);
    assert.equal(passes({ ...scores, fidelity: 4 }), true);
});

test("scenario pairing removes common difficulty without treating repeats as independent tasks", () => {
    const scored = (scenario, score, attempt = 1) => ({ scenario, category: "3d", id: `${scenario}~${attempt}`, score });
    const baseline = [scored("easy", 4), scored("hard", 2), scored("hard", 2, 2)];
    const improved = [scored("easy", 5), scored("hard", 3), scored("hard", 3, 2), scored("new", 5)];
    const result = compareRuns(improved, baseline, { bootstrap: 200, seed: 1 });
    assert.equal(result.scenarios, 2);
    assert.deepEqual(result.runs, [3, 3]);
    assert.equal(result.delta, 1);
    assert.deepEqual(result.interval, [1, 1]);
    assert.equal(result.pairedSE, 0);
    assert.ok(result.unpairedSE > 0);
});

test("same-code controls split attempts by scenario, excluding incomplete pairs", () => {
    const scored = (scenario, attempt, score) => ({ scenario, category: "3d", id: attempt > 1 ? `${scenario}~${attempt}` : scenario, score });
    const runs = [scored("easy", 1, 4), scored("hard", 1, 2), scored("missing", 1, 2), scored("hard", 2, 3), scored("easy", 2, 5), scored("other", 2, 4)];
    const control = sameCodeControl(runs, { bootstrap: 200 });
    assert.equal(control.scenarios, 2);
    assert.equal(control.delta, 1);
    assert.deepEqual(control.interval, [1, 1]);
});

test("paired stats can compare unjudged deterministic metrics", () => {
    const time = (scenario, firstVisual) => ({ scenario, category: "3d", metrics: { firstVisual } });
    const result = compareRuns([time("a", 500), time("b", 700)], [time("a", 600), time("b", 800)], { metric: "metrics.firstVisual", bootstrap: 100 });
    assert.equal(result.delta, -100);
    assert.deepEqual(result.interval, [-100, -100]);
});

test("judge disagreement reports large gaps even when the core caps the final score", () => {
    const scores = { correct: 2, complete: 4, clear: 4, visual: 4, fit: 4, fidelity: 2 };
    const report = judgeDisagreement({ category: "3d", judges: [{ scores }, { scores: { ...scores, correct: 4 } }] });
    assert.deepEqual(report.large, ["correct"]);
    assert.equal(report.flagged, true);
    assert.equal(report.overallGap, 0);
    assert.equal(judgeDisagreement({ category: "3d", judges: [{ scores }, { failed: "offline" }] }).missing, 1);
});

test("panel title bars obscured by the answer are measured and capped, but inset captions are not", () => {
    const panel = { x: 40, y: 30, w: 60, h: 60 };
    const frames = [
        { layout: { bubble: { x: 60, y: 25, w: 40, h: 25 }, captions: { x: 40, y: 65, w: 60, h: 25 }, panels: [panel] } },
        { layout: { bubble: { x: 60, y: 80, w: 40, h: 20 }, captions: null, panels: [panel] } },
    ];
    const metrics = measureLayout(frames, { width: 100, height: 100 });
    assert.deepEqual(metrics, { panelHeaderCovered: 33, panelOffscreen: 0 });
    assert.equal(caps(limitsFor(run("3d", metrics), {})).visual, 3);
    assert.deepEqual(measureLayout(frames.slice(1), { width: 100, height: 100 }), { panelHeaderCovered: 0, panelOffscreen: 0 });
    const borderOnly = { layout: { bubble: { x: 40, y: 20, w: 60, h: 20 }, panels: [panel] } };
    assert.ok(measureLayout([borderOnly], { width: 100, height: 100 }).panelHeaderCovered < 25);
    const stricterCap = limitsFor(run("3d", { ...metrics, targetCovered: 60 }), {}).filter(({ key }) => key === "visual");
    assert.equal(Math.min(...stricterCap.map(({ max }) => max)), 2);
});

test("blind pair judging cancels an A-position preference and retains genuine wins", () => {
    const biased = pairOutcome([{ model: "one", order: "AB", winner: "A" }, { model: "one", order: "BA", winner: "A" }]);
    assert.equal(biased.preference, 0);
    assert.equal(biased.orderDisagreements, 1);
    const winner = pairOutcome([{ model: "one", order: "AB", winner: "B" }, { model: "one", order: "BA", winner: "A" }]);
    assert.deepEqual([winner.preference, winner.winner, winner.orderDisagreements], [1, "right", 0]);
});

test("pair prompts swap positions but never disclose which label owns either answer", () => {
    const scenario = { category: "3d", ask: "How?", points: ["the answer"], expect: ["scene"] };
    const run = (text) => ({ record: { text, captions: [], tools: [], error: null }, metrics: { boardOverlaps: 0, boardOff: 0, targetCovered: 0, panelHeaderCovered: 0, failedTools: 0, mediaMatch: true }, frames: [{ tag: "final" }] });
    const input = { scenario, meta: { title: "Test" }, left: run("baseline"), right: run("candidate"), screen: "screen.jpg" };
    assert.match(pairPrompt(input, "AB"), /# A\nSpoken answer: "baseline"/);
    assert.match(pairPrompt(input, "BA"), /# A\nSpoken answer: "candidate"/);
    const summary = summarizePairs([{ id: "x", scenario: "x", category: "3d", preference: 1, winner: "right", orderDisagreements: 0 }], ["base", "candidate"]);
    assert.equal(summary.interval, null);
});

test("pairwise judges see both positions and normalize their votes to the candidate", async () => {
    const file = new URL("./evals.test.mjs", import.meta.url);
    const run = (text) => ({
        record: { text, captions: [], tools: [], error: null },
        metrics: { boardOverlaps: 0, boardOff: 0, targetCovered: 0, panelHeaderCovered: 0, failedTools: 0, mediaMatch: true },
        frames: [{ tag: "final", path: file }],
    });
    const deleted = [];
    let calls = 0;
    const client = {
        async createSession() {
            const sessionId = String(++calls);
            return {
                sessionId,
                async sendAndWait({ prompt, attachments }) {
                    assert.equal(attachments.length, 3);
                    return { data: { content: JSON.stringify({ winner: /# A\nSpoken answer: "candidate"/.test(prompt) ? "A" : "B" }) } };
                },
                async disconnect() {},
            };
        },
        async deleteSession(id) {
            deleted.push(id);
        },
    };
    const judge = new PairJudge({ client, models: ["m1", "m2"], effort: "medium", workspace: "." });
    const verdict = await judge.compare({ scenario: { category: "3d", ask: "How?", points: ["the answer"], expect: ["scene"] }, meta: { title: "Test" }, screen: file, left: run("baseline"), right: run("candidate") });
    assert.deepEqual([verdict.preference, verdict.orderDisagreements, calls, deleted.length], [1, 0, 4, 4]);
});
