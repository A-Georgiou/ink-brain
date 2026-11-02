import assert from "node:assert/strict";
import { test } from "node:test";
import { bubbleSpot, cropAround, describeMarks, modelImageSize, overlapArea, shapeToOverlay, validateShape } from "../src/shared/geometry.mjs";

test("model screenshots are capped at the configured long edge", () => {
    assert.deepEqual(modelImageSize(1512, 982), { width: 1512, height: 982, scale: 1 });
    assert.deepEqual(modelImageSize(3200, 1800, 1600), { width: 1600, height: 900, scale: 0.5 });
});

test("shapes map from screenshot pixels to overlay pixels", () => {
    assert.deepEqual(shapeToOverlay({ kind: "arrow", from: [10, 20], to: [30, 40], text: "x" }, 0.5), { kind: "arrow", from: [20, 40], to: [60, 80], text: "x" });
    assert.deepEqual(shapeToOverlay({ kind: "path", points: [[1, 2], [3, 4]] }, 0.5).points, [[2, 4], [6, 8]]);
});

test("invalid shapes explain what is missing", () => {
    assert.equal(validateShape({ kind: "circle", x: 1, y: 2, w: 3, h: 4 }), null);
    assert.equal(validateShape({ kind: "circle", x: 1, y: 2 }), "circle needs x, y, w and h");
    assert.equal(validateShape({ kind: "arrow", from: [1, 2] }), "arrow needs from and to as [x, y]");
    assert.equal(validateShape({ kind: "callout", x: 1, y: 2 }), "callout needs the target x, y and text");
    assert.equal(validateShape({ kind: "diagram", nodes: [{ id: "a", x: 1, y: 1 }], edges: [{ from: "a", to: "b" }] }), 'diagram edge "a" -> "b" refers to a missing node');
    assert.equal(validateShape({ kind: "blob" }), 'unknown shape kind "blob"');
});

test("callouts and diagrams map their anchors, nodes and text size to the overlay", () => {
    const callout = shapeToOverlay({ kind: "callout", x: 10, y: 20, at: [100, 50], size: 24, text: "why" }, 0.5);
    assert.deepEqual([callout.x, callout.y, callout.at, callout.size], [20, 40, [200, 100], 48]);
    const diagram = shapeToOverlay({ kind: "diagram", nodes: [{ id: "a", x: 10, y: 20, w: 100 }], edges: [{ from: "a", to: "a" }] }, 0.5);
    assert.deepEqual(diagram.nodes, [{ id: "a", x: 20, y: 40, w: 200 }]);
});

test("zoom crops stay on the display and keep a minimum size", () => {
    assert.deepEqual(cropAround({ x: 5, y: 5, w: 10, h: 10 }, 1512, 982), { x: 0, y: 0, w: 260, h: 260 });
    assert.deepEqual(cropAround({ x: 1400, y: 900, w: 100, h: 60 }, 1512, 982), { x: 1252, y: 722, w: 260, h: 260 });
});

test("marks are described in screenshot coordinates", () => {
    const loop = [[100, 100], [200, 100], [200, 160], [100, 160], [104, 104]];
    assert.deepEqual(describeMarks([{ type: "stroke", points: loop }, { type: "pin", x: 50, y: 60 }], 0.5), [
        "circled the region x=50, y=50, w=50, h=30",
        "pointed at (25, 30)",
    ]);
});

test("the answer sits by the user's marks, moves off what Copilot draws there, and does not hop for a slightly closer spot", () => {
    const anchor = { x: 520, y: 330, w: 320, h: 210 };
    const place = (more) => bubbleSpot({ w: 420, h: 150, view: { width: 1512, height: 982 }, bottomInset: 110, anchor, ...more });
    const first = place({});
    assert.equal(overlapArea(first.box, [anchor]), 0);
    const diagram = { x: first.box.x + 20, y: first.box.y, w: 300, h: 200 };
    const moved = place({ drawn: [diagram], current: first.name });
    assert.notEqual(moved.name, first.name);
    assert.equal(overlapArea(moved.box, [anchor, diagram]), 0);
    assert.equal(place({ current: "beside-right" }).name, "beside-right");
});
