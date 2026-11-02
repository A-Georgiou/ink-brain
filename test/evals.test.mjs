import assert from "node:assert/strict";
import { test } from "node:test";
import { limitsFor, overall, passes } from "../evals/judge.mjs";

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
