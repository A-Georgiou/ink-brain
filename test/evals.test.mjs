import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeDisagreement, limitsFor, overall, passes } from "../evals/judge.mjs";
import { compareRuns } from "../evals/stats.mjs";

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

test("judge disagreement reports large gaps even when the core caps the final score", () => {
    const scores = { correct: 2, complete: 4, clear: 4, visual: 4, fit: 4, fidelity: 2 };
    const report = judgeDisagreement({ category: "3d", judges: [{ scores }, { scores: { ...scores, correct: 4 } }] });
    assert.deepEqual(report.large, ["correct"]);
    assert.equal(report.flagged, true);
    assert.equal(report.overallGap, 0);
    assert.equal(judgeDisagreement({ category: "3d", judges: [{ scores }, { failed: "offline" }] }).missing, 1);
});
