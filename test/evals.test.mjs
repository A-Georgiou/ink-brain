import assert from "node:assert/strict";
import { test } from "node:test";
import { aimAt, drawnShapes } from "../evals/aim.mjs";
import { auditBoard } from "../evals/board-audit.mjs";
import { conversationMetrics, marksFor, pickFrames, turnsOf } from "../evals/conversation.mjs";
import { elementsAt, snapOnto } from "../evals/elements.mjs";
import { checkMeasurement, integrationReport, printIntegration } from "../evals/integration.mjs";
import { judgeDisagreement, limitsFor, overall, passes } from "../evals/judge.mjs";
import { latencyMetrics, replayTimeline } from "../evals/latency.mjs";
import { measureLayout } from "../evals/layout.mjs";
import { scriptedAnswer } from "../evals/learner.mjs";
import { compareRuns, sameCodeControl } from "../evals/stats.mjs";
import { awaitStage } from "../evals/snapshot.mjs";
import { PairJudge, pairOutcome, pairPrompt, pairSources, sourceId, summarizePairs } from "../evals/versus.mjs";

const run = (category, metrics = {}, tools = [], scenario = {}) => ({
    scenario: { category, expect: ["board"], points: ["a", "b", "c"], ...scenario },
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
    assert.deepEqual(caps(limitsFor(run("robustness", {}, [{ name: "live_control" }], { forbid: ["live_control"] }), { points: [{ said: "yes", shown: "yes" }] })), { resilience: 1 });
    assert.deepEqual(caps(limitsFor(run("pointing-hard", { aim: { hit: true, wrong: 1 } }), { points })), { fit: 2, pointing: 3 });
});

test("a tutor run that never checks understanding cannot score as if it had", () => {
    const tutor = { scenario: { category: "tutor", expect: ["board"], points: ["a"] }, record: { tools: [], checks: [], controls: false, error: null }, metrics: { boardOverlaps: 0, boardOff: 0, targetCovered: 0, mediaMatch: true, media: ["board"] } };
    const tight = (limits, key) => Math.min(...limits.filter((limit) => limit.key === key).map((limit) => limit.max));
    assert.equal(tight(limitsFor(tutor, { points: [{ said: "yes", shown: "yes" }] }), "pedagogy"), 2);
    tutor.record.checks = [{ question: "What is left?", correctLabel: "the tangent", answer: { correct: false } }];
    assert.equal(caps(limitsFor(tutor, { points: [{ said: "yes", shown: "yes" }] })).pedagogy, undefined);
    tutor.record.checks[0].question = "It becomes the tangent, right?";
    assert.equal(caps(limitsFor(tutor, { points: [{ said: "yes", shown: "yes" }] })).pedagogy, 3);
});

test("the scripted learner picks a wrong choice, or speaks a guess that matches none", () => {
    const check = { choices: [{ id: "c1", label: "About 99%", correct: false, misconception: "base rate" }, { id: "c2", label: "Much lower", correct: true }] };
    assert.equal(scriptedAnswer({ learner: [{ pick: "wrong" }] }, check, 0).id, "c1");
    assert.equal(scriptedAnswer({ learner: [{ pick: "right" }] }, check, 0).id, "c2");
    assert.equal(scriptedAnswer({ learner: [{ say: "it lands on zero" }] }, check, 0).via, "voice");
    assert.equal(scriptedAnswer({ learner: [{ say: "about 99 percent" }] }, check, 0).id, "c1");
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
    assert.deepEqual(result.meanSE, [1, 1]);
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

test("integration decisions pair categories, latency and pass rates on the same scenarios", () => {
    const result = (scenario, category, score, pass, firstWords, attempt = 1) => ({
        id: attempt > 1 ? `${scenario}~${attempt}` : scenario,
        scenario,
        category,
        score,
        pass,
        metrics: { firstWords, firstVisual: firstWords + 200, total: firstWords + 500 },
    });
    const baseline = [
        result("model", "3d", 3, false, 3000), result("model", "3d", 3, false, 3200, 2),
        result("figure", "3d", 3, false, 3000), result("figure", "3d", 3, false, 3200, 2),
        result("other", "maths", 4, true, 1000),
    ];
    const candidate = [
        result("model", "3d", 4, true, 2000), result("model", "3d", 4, true, 2200, 2),
        result("figure", "3d", 2, false, 2000), result("figure", "3d", 2, false, 2200, 2),
        result("new", "maths", 5, true, 500),
    ];
    candidate[2].metrics.firstVisual = null;
    candidate[3].metrics.firstVisual = null;
    const report = integrationReport(candidate, baseline, { controls: { baseline }, bootstrap: 200 });
    assert.deepEqual(report.categories.map((row) => row.category), ["3d"]);
    assert.equal(report.overall.score.scenarios, 2);
    assert.deepEqual([report.overall.score.delta, report.overall.firstWords.delta, report.overall.pass.delta], [0, -1000, 0.5]);
    assert.deepEqual([report.regressions[0].id, report.improvements[0].id], ["figure", "model"]);
    assert.deepEqual(report.nulls[0].score.interval, [0, 0]);
    const lines = [];
    const original = console.log;
    try {
        console.log = (line) => lines.push(line);
        printIntegration(report, "candidate", "baseline");
    } finally {
        console.log = original;
    }
    assert.match(lines.join("\n"), /first words -1\.00s \[-1\.10s, -0\.90s\]/);
    assert.match(lines.join("\n"), /first visual -1\.00s \[insufficient scenarios\] \(1 paired\)/);
    assert.match(lines.join("\n"), /Null controls.*baseline: score \+0\.00 \[\+0\.00, \+0\.00\]/s);
});

test("integration reports refuse known judge or harness mismatches", () => {
    const base = { judge: "gpt+claude", measurement: "v1" };
    assert.equal(checkMeasurement([base, { ...base }]), null);
    assert.match(checkMeasurement([base, { ...base, measurement: null }]), /not recorded/);
    assert.throws(() => checkMeasurement([base, { ...base, measurement: "v2" }]), /measurement code differs/);
    assert.throws(() => checkMeasurement([base, { ...base, judge: "gpt" }]), /judge models differ/);
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

test("pairwise sources can compare independent attempts of the same code safely", () => {
    const [first, second] = pairSources("3d-r4@1,3d-r4@2");
    assert.deepEqual([sourceId(first, "heart", 1), sourceId(second, "heart", 1)], ["heart", "heart~2"]);
    assert.throws(() => pairSources("../other,3d-r4"), /invalid pairwise source/);
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

test("a conversation plays its own turns, and marks follow the user's pen", () => {
    const meta = { marks: [{ type: "stroke", points: [[1, 2]] }] };
    const scenario = { ask: "one", turns: [{ ask: "first" }, { ask: "second" }, { ask: "third", mark: { x: 10, y: 20, w: 30, h: 10 } }] };
    assert.deepEqual(turnsOf({ ask: "one" }), [{ ask: "one" }]);
    assert.equal(turnsOf(scenario).length, 3);
    assert.deepEqual(marksFor(scenario.turns[0], meta, 0), meta.marks);
    assert.deepEqual(marksFor(scenario.turns[1], meta, 1), []);
    const fresh = marksFor(scenario.turns[2], meta, 2);
    const [xs, ys] = [fresh[0].points.map(([x]) => x), fresh[0].points.map(([, y]) => y)];
    assert.equal(fresh[0].points.length > 10, true);
    assert.equal(Math.min(...xs) < 10 && Math.max(...xs) > 40, true, "the loop goes around the region");
    assert.equal(Math.min(...ys) < 20 && Math.max(...ys) > 30, true, "the loop goes around the region");
});

test("panels left piled up at the end of a conversation cap the visuals", () => {
    const record = {
        turns: [{ at: 0, tools: [{ name: "live_explain" }] }, { at: 100, tools: [{ name: "live_panel" }] }],
        frames: [{ at: 0, layout: { panels: [1] } }, { at: 120, layout: { panels: [1, 2, 3, 4] } }, { at: 200, layout: { panels: [1, 2, 3] } }],
    };
    const metrics = conversationMetrics(record);
    assert.deepEqual(metrics, { turns: 2, panelsAtEnd: 3, panelsAtMost: 4, stagesPerTurn: [1, 1] });
    const limits = limitsFor(run("conversation", metrics), { points: [{ said: "yes", shown: "yes" }, { said: "yes", shown: "yes" }, { said: "yes", shown: "yes" }] });
    assert.deepEqual(caps(limits), { visual: 3 });
    assert.deepEqual(caps(limitsFor(run("conversation", { ...metrics, panelsAtEnd: 1 }), { points: [{ said: "yes", shown: "yes" }, { said: "yes", shown: "yes" }, { said: "yes", shown: "yes" }] })), {});
    assert.equal(pickFrames(record, (frames) => frames, 4).length, 3);
});

test("latency checks fail missing visuals and apply each category's first-visual budget", () => {
    assert.equal(latencyMetrics("3d", { firstVisual: 14_000 }).firstVisualWithinBudget, true);
    assert.equal(latencyMetrics("pointing", { firstVisual: 14_000 }).firstVisualWithinBudget, false);
    for (const firstVisual of [null, undefined, -1, Infinity]) assert.equal(latencyMetrics("maths", { firstVisual }).firstVisualWithinBudget, false);
});

test("stream replays keep text, argument deltas and their matching tool call in time order", () => {
    const tool = { id: "c1", name: "live_explain", at: 30, args: {} };
    const timeline = [{ kind: "input", at: 20, id: "c1", delta: "{}" }, { kind: "text", at: 10, text: "Look" }];
    assert.deepEqual(replayTimeline({ timeline, tools: [tool] }), [timeline[1], timeline[0], { kind: "tool", at: 30, tool }]);
});

test("step snapshots wait for the requested stage to finish rather than a fixed delay", async () => {
    let time = 0;
    const stage = {
        stepIndex: () => 2,
        async status() {
            return time < 350 ? { index: 1, settled: true } : time < 550 ? { index: 2, settled: false } : { index: 2, settled: true };
        },
    };
    const options = { minimum: 250, poll: 100, now: () => time, sleep: async (ms) => (time += ms) };
    assert.deepEqual(await awaitStage(stage, "board", 2, options), { reason: "settled", ms: 550 });
    time = 0;
    stage.stepIndex = () => (time < 350 ? 2 : 3);
    stage.status = async () => ({ index: 2, settled: false });
    assert.deepEqual(await awaitStage(stage, "board", 2, options), { reason: "advanced", ms: 350 });
    time = 0;
    stage.stepIndex = () => 2;
    assert.deepEqual(await awaitStage(stage, "board", 2, { ...options, limit: 600 }), { reason: "capped", ms: 600 });
    time = 0;
    stage.status = async () => ({ index: 2, settled: true, building: time < 450 });
    assert.deepEqual(await awaitStage(stage, "board", null, { ...options, complete: true }), { reason: "settled", ms: 450 });
    const hanging = { stepIndex: () => 2, status: () => new Promise(() => {}) };
    assert.equal((await awaitStage(hanging, "board", 2, { minimum: 0, limit: 30, poll: 5 })).reason, "capped");
});

test("diagram checks find overlapping nodes, overflowing box text and edges crossing unrelated content", () => {
    const nodes = [
        { id: "a", shape: "box", x: 0, y: 0, w: 100, h: 60 },
        { id: "b", shape: "box", x: 90, y: 0, w: 100, h: 60 },
        { id: "c", shape: "box", x: 250, y: 0, w: 100, h: 60 },
    ];
    const texts = [{ id: "a", x: -8, y: 10, w: 110, h: 20 }, { id: "caption", x: 200, y: 20, w: 30, h: 20 }];
    const edges = [{ id: "link", from: "a", to: "c", points: [[80, 30], [250, 30]] }];
    assert.deepEqual(auditBoard({ nodes, texts, edges }), {
        nodeOverlaps: ["a x b"],
        boxTextOverflow: ["a"],
        edgeNodeCrossings: ["link x b"],
        edgeTextCrossings: ["link x caption"],
    });
});

test("diagram checks allow endpoints, intentional frames and clear paths", () => {
    const nodes = [
        { id: "frame", shape: "box", x: 0, y: 0, w: 300, h: 200 },
        { id: "start", shape: "circle", x: 20, y: 20, w: 50, h: 50 },
        { id: "end", shape: "circle", x: 200, y: 20, w: 50, h: 50 },
    ];
    const texts = [{ id: "frame", x: 80, y: 120, w: 100, h: 20 }];
    const edges = [{ id: "route", points: [[45, 45], [225, 45]] }];
    assert.deepEqual(auditBoard({ nodes, texts, edges }), { nodeOverlaps: [], boxTextOverflow: [], edgeNodeCrossings: [], edgeTextCrossings: [] });
});

test("diagram geometry defects cap visual quality and obstructed structure", () => {
    const points = [{ said: "yes", shown: "yes" }, { said: "yes", shown: "yes" }, { said: "yes", shown: "yes" }];
    const limits = limitsFor(run("diagram", { boardEdgeNodeCrossings: 1, boardTextOverflow: 1 }), { points });
    assert.deepEqual(caps(limits), { visual: 3, structure: 3 });
});

test("pointing is checked strictly against the control, its look-alikes and the later steps", () => {
    const meta = { target: { x: 100, y: 100, w: 28, h: 28 }, also: [{ x: 300, y: 50, w: 56, h: 56 }], decoys: [{ x: 134, y: 100, w: 28, h: 28 }] };
    const aim = (...shapes) => aimAt(meta, shapes);
    assert.deepEqual(aim({ kind: "arrow", from: [40, 40], to: [100, 114] }), { hit: true, steps: 1, of: 2, distance: 0, wrong: 0, onTop: 0 });
    assert.equal(aim({ kind: "arrow", from: [40, 40], to: [114, 114] }).onTop, 1);
    assert.equal(aim({ kind: "marker", x: 114, y: 114, target: meta.target }).onTop, 0);
    assert.deepEqual(aim({ kind: "pulse", x: 148, y: 114 }), { hit: false, steps: 0, of: 2, distance: 20, wrong: 1, onTop: 0 });
    assert.equal(aim({ kind: "circle", x: 96, y: 96, w: 36, h: 36 }).hit, true);
    assert.equal(aim({ kind: "circle", x: 96, y: 96, w: 36, h: 36 }, { kind: "circle", x: 134, y: 100, w: 28, h: 28 }).wrong, 1);
    assert.equal(aim({ kind: "circle", x: 400, y: 400, w: 40, h: 40 }).hit, false);
    assert.equal(aim({ kind: "marker", x: 114, y: 114 }, { kind: "arrow", from: [250, 20], to: [330, 80] }).steps, 2);
    assert.equal(aim().distance, null);
    const label = { target: { x: 105, y: 105, w: 20, h: 14 } };
    const button = [{ role: "AXButton", x: 95, y: 98, w: 40, h: 28 }];
    const tip = { kind: "arrow", from: [60, 112], to: [92, 112] };
    assert.equal(aimAt(label, [tip]).hit, false);
    assert.deepEqual(aimAt(label, [tip], button), { hit: true, steps: 1, of: 1, distance: 3, wrong: 0, onTop: 0 });
    assert.equal(aimAt(label, [tip], [{ role: "AXLink", x: 0, y: 0, w: 900, h: 600 }]).hit, false);
    assert.deepEqual(drawnShapes({ tools: [{ name: "live_annotate", args: { shapes: [{ kind: "callout", to: [1, 2], text: "x" }, { kind: "pulse", x: 1, y: 2 }] } }] }), [{ kind: "pulse", x: 1, y: 2 }]);
});

test("recorded elements place marks the way the accessibility tree does", () => {
    const elements = [
        { role: "AXWebArea", x: 0, y: 0, w: 800, h: 600 },
        { role: "AXButton", x: 190, y: 223, w: 60, h: 28 },
        { role: "AXStaticText", x: 205, y: 229, w: 30, h: 16 },
    ];
    assert.deepEqual(elementsAt(elements, [214, 236]).map((e) => e.role), ["AXStaticText", "AXButton", "AXWebArea"]);
    const [arrow, note] = snapOnto(elements, [{ kind: "arrow", from: [220, 330], to: [214, 236] }, { kind: "write", x: 5, y: 5, text: "hi" }]);
    assert.deepEqual(arrow.to, [220, 254]);
    assert.equal(note.x, 5);
});
