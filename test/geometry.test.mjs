import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAt, pageState, pageTitle } from "../src/shared/anchors.mjs";
import { clearSpot, validateBoard, withValues } from "../src/shared/board.mjs";
import { inkGrid, inkIn, settleMarks } from "../src/shared/calm.mjs";
import { compile } from "../src/shared/mathexpr.mjs";
import { PART_KINDS, validateScene } from "../src/shared/scene.mjs";
import { traceOutline } from "../src/shared/trace.mjs";
import * as THREE from "three";
import { buildPart } from "../src/overlay/parts.js";
import { recentreRings } from "../src/overlay/repair.js";
import { geometryFor } from "../src/overlay/shapes.js";
import { bubbleSpot, cropAround, describeMarks, modelImageSize, overlapArea, shapeToOverlay, snapShape, stageSpot, validateShape } from "../src/shared/geometry.mjs";

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

const chrome = { id: 7, page: "Docs", x: 0, y: 30, w: 900, h: 700 };
const terminal = { id: 9, page: "zsh", x: 950, y: 30, w: 500, h: 700 };

test("drawings stay with their page: hidden on another tab or Space, back and following the window on return", () => {
    assert.equal(pageTitle("(3) Inbox - Mail"), pageTitle("Inbox - Mail"));
    assert.equal(pageTitle("● main.ts - ink-brain"), "main.ts - ink-brain");
    const anchor = anchorAt([terminal, chrome], { x: 100, y: 100 });
    assert.equal(anchor.id, chrome.id);
    assert.equal(anchorAt([terminal, chrome], null).id, terminal.id);
    const box = { x: 100, y: 100, w: 200, h: 100 };
    assert.deepEqual(pageState([terminal, chrome], anchor, box), { visible: true, dx: 0, dy: 0 });
    assert.equal(pageState([{ ...chrome, page: "Other tab" }], anchor, box).visible, false);
    assert.equal(pageState([terminal], anchor, box).visible, false);
    assert.deepEqual(pageState([{ ...chrome, x: 40, y: 80 }], anchor, box), { visible: true, dx: 40, dy: 50 });
});

test("a page hides when another window covers its drawings, not when it sits beside them", () => {
    const anchor = anchorAt([chrome], { x: 100, y: 100 });
    const box = { x: 100, y: 100, w: 200, h: 100 };
    assert.equal(pageState([{ ...terminal, x: 0 }, chrome], anchor, box).visible, false);
    assert.equal(pageState([{ ...terminal, x: 600 }, chrome], anchor, box).visible, true);
});

test("scene validation tells the model exactly what to fix", () => {
    const scene = { objects: [{ id: "engine", type: "group" }, { id: "piston", type: "box", parent: "engine" }] };
    assert.equal(validateScene(scene, [[{ do: "flow", id: "fuel", from: "piston", to: [0, 2, 0] }], [{ do: "hide", target: "fuel" }]]), null);
    assert.match(validateScene({ objects: [{ id: "force", type: "arrow" }] }), /arrow "force" needs from and to/);
    assert.match(validateScene({ objects: [{ id: "a", type: "group", parent: "b" }, { id: "b", type: "group", parent: "a" }] }), /each other's parents/);
    assert.match(validateScene(scene, [[{ do: "move", target: "valve" }]]), /step 1: move targets unknown object "valve"/);
});

test("grid copies and wires can be pointed at part by part", () => {
    const scene = {
        objects: [
            { id: "header", type: "box", grid: [20, 2], order: "columns" },
            { id: "screen", type: "box" },
            { id: "power", type: "wire", from: "header#1", to: "screen" },
        ],
    };
    assert.equal(validateScene(scene, [[{ do: "highlight", target: "header#40" }, { do: "show", target: "power" }, { do: "flow", along: "power" }]]), null);
    assert.match(validateScene(scene, [[{ do: "label", target: "header#41", text: "?" }]]), /unknown object "header#41"/);
    assert.match(validateScene({ objects: [...scene.objects, { id: "loose", type: "wire", from: "header#1", to: "nowhere" }] }), /wire "loose" end "nowhere"/);
});

test("parts stand on a base at their place in the picture", () => {
    const board = { id: "board", type: "base", region: { x: 600, y: 300, w: 400, h: 260 }, size: [85, 1.6], material: "pcb", holes: [[612, 312, 6]] };
    const port = { id: "dsi", type: "part", part: "ffc", on: "board", at: [612, 420], footprint: [10, 60] };
    assert.equal(validateScene({ objects: [board, port, { id: "ribbon", type: "wire", style: "ribbon", from: [0, 2, -6], to: "dsi" }] }), null);
    assert.match(validateScene({ objects: [{ id: "board", type: "base" }] }), /base "board" needs region/);
    assert.match(validateScene({ objects: [board, { ...port, part: "usb-z" }] }), /part "dsi" has unknown part "usb-z"/);
    assert.match(validateScene({ objects: [{ ...port, on: "nothing" }] }), /"dsi" is on "nothing", which is not a base/);
    assert.match(validateScene({ objects: [board, { ...port, at: undefined }] }), /"dsi" needs at: \[x, y\]/);
    assert.match(validateScene({ objects: [{ id: "bracket", type: "extrude", points: [[0, 0], [1, 0]] }] }), /extrude "bracket" needs at least three/);
});

test("bodies can be lofted, hinged, mirrored and cut", () => {
    const body = { id: "body", type: "loft", sections: [{ at: -2, width: 1.8, height: 0.6 }, { at: 2, width: 1.6, height: 0.3, round: 0.4 }], cut: ["arch"] };
    const arch = { id: "arch", type: "cylinder", mirror: "z" };
    const door = { id: "door", type: "box", pivot: [1, 0.7, 0.9], mirror: "z" };
    assert.equal(validateScene({ objects: [body, arch, door] }, [[{ do: "rotate", target: "door", to: [0, 0, -70] }]]), null);
    assert.match(validateScene({ objects: [{ ...body, sections: [{ at: 0, width: 1 }], cut: undefined }] }), /loft "body" needs at least two sections/);
    assert.match(validateScene({ objects: [body, arch, { ...door, pivot: [1, 2] }] }), /"door" pivot must be \[x, y, z\]/);
    assert.match(validateScene({ objects: [body] }), /"body" cuts with "arch", which is not another object's id/);
    const traced = { id: "car", type: "loft", region: { x: 500, y: 470, w: 480, h: 120 }, outline: [[500, 580], [700, 470], [980, 520], [980, 590]], size: [478, 203] };
    const spokes = { id: "spokes", type: "box", on: "car", at: [620, 555], radial: 5, axis: "z" };
    assert.equal(validateScene({ objects: [traced, spokes] }, [[{ do: "highlight", target: "spokes#5" }]]), null);
    assert.match(validateScene({ objects: [traced, { ...spokes, radial: 1 }] }), /"spokes" radial must be a whole number/);
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

test("the answer finds a quiet part of the screen when its usual spot is busy, and keeps the usual spot on a quiet screen", () => {
    const busy = { x: 400, y: 600, w: 700, h: 300 };
    const place = (ink) => bubbleSpot({ w: 420, h: 175, view: { width: 1512, height: 982 }, bottomInset: 110, ink });
    assert.equal(place(null).name, "bottom");
    assert.equal(place(() => 0).name, "bottom");
    const quiet = place((box) => Math.round(overlapArea(box, [busy]) / 64));
    assert.equal(overlapArea(quiet.box, [busy]), 0);
});

test("board expressions compile without eval and say what is wrong", () => {
    assert.equal(compile("2x^2 - sin(a x)", ["x", "a"])({ x: 3, a: 0 }), 18);
    assert.equal(compile("-x^2", ["x"])({ x: 3 }), -9);
    assert.throws(() => compile("sinx", ["x"]), /unknown name "sinx"/);
    assert.throws(() => compile("alert(1)", ["x"]), /unknown name "alert"/);
});

test("boards check their equations' parts, plots and variables", () => {
    const board = {
        vars: { a: 1, h: -0.01 },
        elements: [
            { id: "eq", type: "tex", tex: "\\part{lhs}{a^2} = b" },
            { id: "ax", type: "axes" },
            { id: "f", type: "plot", on: "ax", fn: "a*x^2" },
            { id: "t", type: "tangent", on: "f", x: "a" },
            { id: "c", type: "circle", on: "ax", at: [0, 0], r: "a" },
            { id: "v", type: "vector", on: "ax", at: ["a", 0] },
        ],
    };
    assert.equal(validateBoard(board, [[{ do: "highlight", target: "eq.lhs" }, { do: "set", vars: { a: 2 } }]]), null);
    assert.equal(withValues("2 + \\val{h} = \\val{2+h}", board.vars), "2 - 0.01 = 1.99");
    assert.match(validateBoard(board, [[{ do: "color", target: "eq.rhs" }]]), /"eq" has no \\part\{rhs\}/);
    assert.match(validateBoard({ elements: [{ id: "f", type: "plot", fn: "x" }] }), /plot "f" needs on/);
    assert.match(validateBoard(board, [[{ do: "set", vars: { b: 2 } }]]), /set b: declare it in the board's vars/);
    assert.equal(validateBoard(board, [[{ do: "apply", matrix: [[2, 1], [0, 1]] }]]), null);
    assert.match(validateBoard({ elements: [{ id: "eq", type: "tex", tex: "x" }] }, [[{ do: "apply", matrix: [[2, 1], [0, 1]] }]]), /apply needs axes on the board/);
});

test("board text steps the shortest way off earlier text, back onto the board, and stays put inside a box", () => {
    const eq = { x: 500, y: 300, w: 400, h: 80 };
    assert.deepEqual(clearSpot({ x: 520, y: 330, w: 300, h: 60 }, [eq], 1600, 900), [0, 64]);
    assert.deepEqual(clearSpot({ x: 1500, y: 400, w: 300, h: 60 }, [], 1600, 900), [-210, 0]);
    assert.deepEqual(clearSpot({ x: 560, y: 320, w: 200, h: 40 }, [{ ...eq, frame: true }], 1600, 900), [0, 0]);
});

test("marks snap onto the control under them, and only when it plausibly is what they meant", () => {
    const button = [
        { role: "AXStaticText", x: 205, y: 229, w: 30, h: 16 },
        { role: "AXButton", x: 190, y: 223, w: 60, h: 28 },
        { role: "AXWebArea", x: 160, y: 192, w: 760, h: 428 },
    ];
    const fieldset = [{ role: "AXGroup", x: 192, y: 291, w: 225, h: 91 }];
    assert.deepEqual(snapShape({ kind: "rect", x: 186, y: 219, w: 70, h: 36 }, button), { kind: "rect", x: 190, y: 223, w: 60, h: 28 });
    assert.deepEqual(snapShape({ kind: "rect", x: 150, y: 180, w: 400, h: 120 }, button), { kind: "rect", x: 150, y: 180, w: 400, h: 120 });
    assert.deepEqual(snapShape({ kind: "pulse", x: 214, y: 236 }, button), { kind: "pulse", x: 220, y: 237 });
    assert.deepEqual(snapShape({ kind: "arrow", from: [220, 330], to: [220, 240] }, button).to, [220, 254]);
    assert.deepEqual(snapShape({ kind: "pulse", x: 233, y: 363 }, fieldset), { kind: "pulse", x: 233, y: 363 });
});

test("marks beside a control carry its box, scaled with the screen, so it can be outlined", () => {
    const button = [{ role: "AXButton", x: 190, y: 223, w: 60, h: 28 }, { role: "AXWebArea", x: 160, y: 192, w: 760, h: 428 }];
    const box = { x: 190, y: 223, w: 60, h: 28 };
    assert.deepEqual(snapShape({ kind: "arrow", from: [220, 330], to: [220, 240] }, button).target, box);
    assert.deepEqual(snapShape({ kind: "marker", x: 214, y: 236, text: "1" }, button), { kind: "marker", x: 220, y: 237, text: "1", target: box });
    assert.equal(snapShape({ kind: "pulse", x: 214, y: 236 }, button).target, undefined);
    assert.equal(snapShape({ kind: "callout", x: 214, y: 236, text: "x" }, [{ role: "AXLink", x: 0, y: 0, w: 900, h: 300 }]).target, undefined);
    assert.deepEqual(shapeToOverlay({ kind: "marker", x: 20, y: 30, target: box }, 0.5).target, { x: 380, y: 446, w: 120, h: 56 });
});

test("callouts and arrow tails settle onto quiet parts of the screen, keep off what they point at and stay put when already quiet", () => {
    const [width, height] = [400, 300];
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 100; y < 200; y++) for (let x = 60; x < 340; x++) if ((x + y) % 4 < 2) data.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
    const grid = inkGrid({ width, height, data });
    const view = { width, height };
    assert.ok(inkIn(grid, { x: 100, y: 120, w: 100, h: 30 }) > 10);
    assert.equal(inkIn(grid, { x: 20, y: 220, w: 100, h: 30 }), 0);
    const target = { x: 180, y: 135, w: 40, h: 30 };
    const [moved] = settleMarks([{ kind: "callout", x: 200, y: 150, at: [200, 150], text: "Click here", target }], grid, view);
    const box = { x: moved.at[0] - 68, y: moved.at[1] - 19, w: 136, h: 38 };
    assert.ok(inkIn(grid, box) <= 1);
    assert.equal(overlapArea(box, [target]), 0);
    const quiet = { kind: "callout", x: 200, y: 150, at: [100, 250], text: "Click here" };
    assert.equal(settleMarks([quiet], grid, view)[0], quiet);
    const [tail] = settleMarks([{ kind: "arrow", from: [330, 150], to: [200, 215] }], grid, view);
    assert.deepEqual(tail.to, [200, 215]);
    assert.ok(tail.from[1] > 200 && inkIn(grid, { x: tail.from[0] - 12, y: tail.from[1] - 12, w: 24, h: 24 }) === 0);
    const joined = { kind: "arrow", from: [330, 150], to: [200, 215] };
    assert.equal(settleMarks([joined, { kind: "circle", x: 320, y: 140, w: 20, h: 20 }], grid, view)[0], joined);
    assert.equal(settleMarks([{ kind: "marker", x: 210, y: 215, text: "1", target: { x: 200, y: 205, w: 20, h: 20 } }], grid, view)[0].corner, "bl");
});

test("3D stages take the most free room beside the circled thing and only ever clip a corner of it", () => {
    const view = { width: 1512, height: 982 };
    const target = { x: 264, y: 257, w: 800, h: 600 };
    const spot = stageSpot({ target, view, max: [920, 700], min: [400, 300] });
    const middle = { x: 464, y: 407, w: 400, h: 300 };
    assert.ok(spot.w >= 400 && spot.h >= 300);
    assert.equal(overlapArea(spot, [middle]), 0);
    assert.ok(overlapArea(spot, [target]) <= 800 * 600 * 0.05);
    assert.deepEqual(stageSpot({ target: { x: 40, y: 300, w: 200, h: 150 }, view, max: [920, 700], min: [400, 300] }).w, 920);
    assert.equal(stageSpot({ target: { x: 0, y: 0, w: 1512, h: 982 }, view, max: [920, 700], min: [400, 300] }), null);
});

test("scene mechanisms must move real parts, and steps drive only mechanisms", () => {
    const objects = [{ id: "crank", type: "group", pivot: [0, 0, 0] }, { id: "pin", type: "sphere", parent: "crank" }, { id: "piston", type: "cylinder" }];
    const mechanisms = [{ id: "engine", type: "crank", crank: "crank", pin: "pin", slider: "piston" }];
    assert.equal(validateScene({ objects, mechanisms }, [[{ do: "drive", target: "engine", turns: 0.5 }]]), null);
    assert.match(validateScene({ objects, mechanisms: [{ ...mechanisms[0], slider: "pistn" }] }), /moves "pistn"/);
    assert.match(validateScene({ objects, mechanisms }, [[{ do: "drive", target: "piston" }]]), /unknown mechanism "piston"/);
});

test("pictures trace to the outline of the thing in them, without the lines and labels around it", () => {
    const [width, height] = [120, 100];
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (x, y) => data.fill(30, (y * width + x) * 4, (y * width + x) * 4 + 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (Math.hypot(x - 50, y - 50) <= 30) paint(x, y);
    for (let x = 80; x < 110; x++) paint(x, 50);
    for (let y = 44; y < 56; y++) for (let x = 104; x < 116; x++) paint(x, y);
    const outline = traceOutline({ width, height, data });
    assert.ok(outline.length >= 8 && outline.length <= 96);
    for (const [u, v] of outline) assert.ok(Math.abs(Math.hypot(u * width - 50, v * height - 50) - 30) < 3);
    assert.equal(traceOutline({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }), null);
});

test("radial copies set on a wheel with no parent go round the wheel's axle, not the world's", () => {
    const record = (def, obj) => ({ def, obj, home: { position: obj.position.clone() } });
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 2));
    wheel.position.set(-14, 3, 9);
    wheel.rotation.x = Math.PI / 2;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.4, 0.2));
    spoke.position.set(-14, 3, 10);
    const ring = new THREE.Group();
    for (let k = 0; k < 5; k++) ring.add(new THREE.Group().add(k ? spoke.clone() : spoke).rotateZ((k / 5) * Math.PI * 2));
    ring.userData.copies = ring.children.map((turn) => turn.children[0]);
    const scene = new THREE.Scene().add(wheel, ring);
    scene.updateMatrixWorld(true);
    const items = new Map([["wheel", record({ id: "wheel", type: "cylinder" }, wheel)], ["spokes", record({ id: "spokes", type: "box", radial: 5, axis: "z" }, ring)]]);
    ring.userData.copies.forEach((copy, n) => items.set(`spokes#${n + 1}`, record({ id: `spokes#${n + 1}`, copy: true }, copy)));
    recentreRings(items);
    for (const copy of ring.userData.copies) {
        const centre = new THREE.Box3().setFromObject(copy).getCenter(new THREE.Vector3());
        assert.ok(Math.hypot(centre.x + 14, centre.y - 3) < 0.01 && Math.abs(centre.z - 10) < 0.01);
    }
    assert.deepEqual(items.get("spokes").home.position.toArray(), [-14, 3, 0]);
});

test("every ready-made part kind builds real geometry around its origin", () => {
    const paint = ({ color }) => new THREE.MeshStandardMaterial({ color });
    for (const kind of PART_KINDS) {
        const obj = buildPart({ id: kind, type: "part", part: kind, grid: [2, 2] }, [2, 1, 2], paint);
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        assert.ok(size.x > 0.1 && size.y > 0.1 && size.z > 0.1, `${kind} is flat or empty: ${size.toArray()}`);
        assert.ok(box.getCenter(new THREE.Vector3()).length() < 3, `${kind} is built away from its origin`);
    }
});

test("a lens bulges out in the middle, and dishes in when its bulge is negative", () => {
    const paint = ({ color }) => new THREE.MeshStandardMaterial({ color });
    const thickness = (bulge, at) => {
        const geometry = buildPart({ part: "lens", radius: 1, height: 0.3, bulge }, [2, 0.3, 2], paint).children[0].geometry;
        const zs = [...Array(geometry.attributes.position.count).keys()]
            .map((i) => [Math.hypot(geometry.attributes.position.getX(i), geometry.attributes.position.getY(i)), geometry.attributes.position.getZ(i)])
            .filter(([r]) => Math.abs(r - at) < 0.08);
        return Math.max(...zs.map(([, z]) => z)) - Math.min(...zs.map(([, z]) => z));
    };
    assert.ok(thickness(0.3, 0) > thickness(0.3, 0.95) * 2, "a convex lens should be thickest at its centre");
    assert.ok(thickness(-0.3, 0) < thickness(-0.3, 0.95), "a concave lens should be thinnest at its centre");
});

test("a chain path wraps a band of rollers across the plane of its loop", () => {
    const loop = { id: "chain", type: "path", style: "chain", closed: true, radius: 0.1, points: [[2, 0, 0], [0, 2, 0], [-2, 0, 0], [0, -2, 0]] };
    const box = new THREE.Box3().setFromBufferAttribute(geometryFor(loop).attributes.position);
    assert.ok(box.max.z - box.min.z > 0.2 && box.max.z - box.min.z < 0.5, "the chain's width runs along the axles it wraps");
    assert.ok(geometryFor(loop).attributes.position.count > geometryFor({ ...loop, style: undefined }).attributes.position.count, "a chain carries rollers a plain tube does not");
});
