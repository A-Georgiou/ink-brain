// Ready-made electronic parts for scenes, modelled from simple shapes with real finishes.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const METAL = { color: "#9ea5ad", metalness: 1, roughness: 0.32 };
const PLASTIC = { color: "#1b1d22", metalness: 0.05, roughness: 0.55 };
const HOLE = { color: "#060708", metalness: 0, roughness: 0.95 };
const GOLD = { color: "#d4a84b", metalness: 1, roughness: 0.3 };
const ANGLE = { right: 0, up: Math.PI / 2, left: Math.PI, down: -Math.PI / 2 };
// FRONT parts face an edge of the picture; LONG parts line their long side up with the footprint's.
const FRONT = new Set(["usb-a", "usb-b", "usb-c", "micro-usb", "hdmi", "micro-hdmi", "ethernet", "audio-jack", "barrel-jack", "microsd", "display"]);
const LONG = { ffc: "z", smd: "x", crystal: "x" };
const TALL = {
    "usb-a": (l, w, p) => w * 0.5 * p.stack,
    "usb-b": (l, w) => w * 0.9,
    "usb-c": (l, w) => w * 0.36,
    "micro-usb": (l, w) => w * 0.4,
    hdmi: (l, w) => w * 0.4,
    "micro-hdmi": (l, w) => w * 0.45,
    ethernet: (l, w) => w * 0.85,
    "audio-jack": (l, w) => w * 0.85,
    "barrel-jack": (l, w) => w,
    microsd: (l, w) => w * 0.13,
    header: (l, w, p) => p.pitch * 3.3,
    socket: (l, w, p) => p.pitch * 3.4,
    ffc: (l, w) => Math.min(l, w) * 0.45,
    chip: (l, w) => Math.min(l, w) * 0.12,
    can: (l, w) => Math.min(l, w) * 0.18,
    capacitor: (l, w) => Math.min(l, w) * 1.2,
    smd: (l, w) => Math.min(l, w) * 0.5,
    crystal: (l, w) => Math.min(l, w) * 0.35,
    led: (l, w) => Math.min(l, w) * 0.4,
    button: (l, w) => Math.min(l, w) * 0.6,
    display: (l, w) => Math.min(l, w) * 0.06,
};
const plastic = (color) => ({ ...PLASTIC, color: color ?? PLASTIC.color });

function block(material, [w, h, d], [x, y, z] = [0, 0, 0], radius = 0) {
    const r = Math.min(radius, Math.min(w, h, d) / 2 - 0.0001);
    const mesh = new THREE.Mesh(r > 0 ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    return mesh;
}

function rod(material, radius, length, [x, y, z], axis = "y") {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 32), material);
    mesh.position.set(x, y, z);
    if (axis === "x") mesh.rotation.z = Math.PI / 2;
    return mesh;
}

// A recessed opening in the front face: a frame, a dark back wall and an optional tongue inside.
function opening(group, { len, wid, cy, faceH, holeW, holeH, recess, shell, back, tongue }) {
    const x = len / 2 - recess / 2;
    const rim = (faceH - holeH) / 2;
    const side = (wid - holeW) / 2;
    for (const s of [1, -1]) {
        group.add(block(shell, [recess, rim, wid], [x, cy + s * (holeH / 2 + rim / 2), 0]));
        group.add(block(shell, [recess, holeH, side], [x, cy, s * (holeW / 2 + side / 2)]));
    }
    group.add(block(back, [recess * 0.04, holeH, holeW], [len / 2 - recess * 0.98, cy, 0]));
    if (tongue) group.add(block(tongue, [recess * 0.85, holeH * 0.24, holeW * 0.78], [len / 2 - recess * 0.55, cy + holeH * 0.18, 0]));
}

// A metal receptacle (USB, HDMI, SD): a shell with one recessed opening per level.
function receptacle({ len, tall, wid, levels = 1, hole, tongue }, paint) {
    const group = new THREE.Group();
    const shell = paint(METAL);
    const recess = len * 0.5;
    group.add(block(shell, [len - recess, tall, wid], [-recess / 2, 0, 0]));
    const level = tall / levels;
    for (let i = 0; i < levels; i++) {
        opening(group, { len, wid, cy: -tall / 2 + level * (i + 0.5), faceH: level, holeW: wid * hole[0], holeH: level * hole[1], recess, shell, back: paint(HOLE), tongue: tongue && paint(tongue) });
    }
    return group;
}

// Pin cells in numbering order, from the first corner in the picture along rows or down columns.
function cells(cols, rows, order, first = "top-left") {
    const list = [];
    for (let n = 0; n < cols * rows; n++) {
        let [col, row] = order === "columns" ? [Math.floor(n / rows), n % rows] : [n % cols, Math.floor(n / cols)];
        if (first.includes("right")) col = cols - 1 - col;
        if (first.includes("bottom")) row = rows - 1 - row;
        list.push([col, row]);
    }
    return list;
}

// A block centred in each pin cell at height y, in numbering order; each is an addressable copy.
function pins(group, copies, { len, wid, cols, rows, order, first }, material, size, y) {
    for (const [col, row] of cells(cols, rows, order, first)) {
        const mesh = block(material, size, [(col - (cols - 1) / 2) * (len / cols), y, (row - (rows - 1) / 2) * (wid / rows)]);
        group.add(mesh);
        copies.push(mesh);
    }
    return group;
}

// Each part faces +x (where a plug goes in), centred, with len along x, wid along z and tall along y.
const BUILD = {
    "usb-a": (p, paint) => receptacle({ ...p, levels: p.stack, hole: [0.84, 0.56], tongue: plastic(p.accent) }, paint),
    "usb-b": (p, paint) => receptacle({ ...p, hole: [0.66, 0.62], tongue: plastic(p.accent) }, paint),
    "usb-c": (p, paint) => receptacle({ ...p, hole: [0.82, 0.6], tongue: PLASTIC }, paint),
    "micro-usb": (p, paint) => receptacle({ ...p, hole: [0.75, 0.55], tongue: PLASTIC }, paint),
    hdmi: (p, paint) => receptacle({ ...p, hole: [0.82, 0.5], tongue: GOLD }, paint),
    "micro-hdmi": (p, paint) => receptacle({ ...p, hole: [0.8, 0.5], tongue: GOLD }, paint),
    microsd: (p, paint) => receptacle({ ...p, hole: [0.86, 0.45] }, paint),
    ethernet({ len, tall, wid }, paint) {
        const group = receptacle({ len, tall, wid, hole: [0.7, 0.62] }, paint);
        group.add(block(paint(GOLD), [len * 0.3, tall * 0.03, wid * 0.56], [len * 0.3, tall * 0.27, 0]));
        for (const [z, color] of [[-wid * 0.4, "#3fb950"], [wid * 0.4, "#f2a33a"]]) {
            group.add(block(paint({ color, metalness: 0, roughness: 0.3, glow: 0.8 }), [len * 0.02, tall * 0.1, wid * 0.1], [len / 2 + len * 0.01, tall * 0.4, z]));
        }
        return group;
    },
    "audio-jack"({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        const body = paint(plastic(accent));
        const barrel = len * 0.25;
        const r = Math.min(tall, wid) * 0.36;
        group.add(block(body, [len - barrel, tall, wid], [-barrel / 2, 0, 0]));
        group.add(rod(body, r, barrel, [len / 2 - barrel / 2, 0, 0], "x"));
        group.add(rod(paint(HOLE), r * 0.5, barrel * 1.02, [len / 2 - barrel / 2, 0, 0], "x"));
        return group;
    },
    "barrel-jack"({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        const r = Math.min(tall, wid) * 0.32;
        group.add(block(paint(plastic(accent)), [len, tall, wid]));
        group.add(rod(paint(HOLE), r, len * 0.02, [len / 2, 0, 0], "x"));
        group.add(rod(paint(METAL), r * 0.28, len * 0.04, [len / 2, 0, 0], "x"));
        return group;
    },
    header(p, paint, copies) {
        const { len, tall, wid, pitch } = p;
        const group = new THREE.Group();
        const base = tall * 0.3;
        group.add(block(paint(PLASTIC), [len, base, wid], [0, -tall / 2 + base / 2, 0]));
        return pins(group, copies, p, paint(GOLD), [pitch * 0.26, tall, pitch * 0.26], 0);
    },
    socket(p, paint, copies) {
        const { len, tall, wid, pitch, accent } = p;
        const group = new THREE.Group();
        group.add(block(paint(plastic(accent)), [len, tall, wid], [0, 0, 0], tall * 0.03));
        return pins(group, copies, p, paint(HOLE), [pitch * 0.42, tall * 0.02, pitch * 0.42], tall / 2);
    },
    ffc({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        const body = tall * 0.62;
        group.add(block(paint(PLASTIC), [len, body, wid], [0, -tall / 2 + body / 2, 0]));
        group.add(block(paint(plastic(accent ?? "#5b4636")), [len * 0.4, tall - body, wid * 1.03], [-len * 0.3, tall / 2 - (tall - body) / 2, 0]));
        group.add(block(paint(HOLE), [len * 0.16, tall * 0.03, wid * 0.9], [len * 0.12, -tall / 2 + body, 0]));
        group.userData.port = new THREE.Vector3(len * 0.12, -tall / 2 + body, 0);
        return group;
    },
    chip({ len, tall, wid, accent, pins }, paint) {
        const group = new THREE.Group();
        group.add(block(paint({ ...PLASTIC, color: accent ?? "#202227", roughness: 0.6 }), [len, tall, wid], [0, 0, 0], tall * 0.12));
        group.add(rod(paint({ color: "#6e7681", metalness: 0, roughness: 0.6 }), Math.min(len, wid) * 0.05, tall * 0.04, [-len * 0.36, tall / 2, -wid * 0.36]));
        if (!pins) return group;
        const metal = paint(METAL);
        for (const [span, across, axis] of [[len, wid, "x"], [wid, len, "z"]]) {
            const n = Math.round(Math.min(20, Math.max(4, span / (tall * 2.4))));
            for (let i = 0; i < n; i++) {
                const along = (i - (n - 1) / 2) * (span / n);
                for (const s of [1, -1]) {
                    const size = [span / n / 2.4, tall * 0.25, tall * 0.9];
                    const at = [along, -tall / 2 + tall * 0.12, s * (across / 2 + tall * 0.4)];
                    group.add(axis === "x" ? block(metal, size, at) : block(metal, [size[2], size[1], size[0]], [at[2], at[1], at[0]]));
                }
            }
        }
        return group;
    },
    can({ len, tall, wid }, paint) {
        const group = new THREE.Group();
        group.add(block(paint(METAL), [len, tall, wid], [0, 0, 0], tall * 0.1));
        group.add(block(paint({ ...METAL, color: "#8d949c", roughness: 0.5 }), [len * 0.92, tall * 0.04, wid * 0.92], [0, tall / 2, 0]));
        return group;
    },
    capacitor({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        const r = Math.min(len, wid) / 2;
        group.add(rod(paint({ color: accent ?? "#26324d", metalness: 0.2, roughness: 0.4 }), r, tall * 0.94, [0, -tall * 0.03, 0]));
        group.add(rod(paint(METAL), r * 0.97, tall * 0.08, [0, tall / 2 - tall * 0.04, 0]));
        for (const turn of [0, Math.PI / 2]) {
            const score = block(paint(HOLE), [r * 1.5, tall * 0.01, r * 0.08], [0, tall / 2, 0]);
            score.rotation.y = turn;
            group.add(score);
        }
        return group;
    },
    smd({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        group.add(block(paint({ color: accent ?? "#b8946a", metalness: 0, roughness: 0.6 }), [len * 0.7, tall, wid]));
        for (const s of [1, -1]) group.add(block(paint(METAL), [len * 0.15, tall, wid], [s * len * 0.425, 0, 0]));
        return group;
    },
    crystal: ({ len, tall, wid }, paint) => block(paint(METAL), [len, tall, wid], [0, 0, 0], Math.min(tall, wid) * 0.45),
    led: ({ len, tall, wid, accent }, paint) => block(paint({ color: accent ?? "#3fb950", metalness: 0, roughness: 0.25, glow: 0.9 }), [len, tall, wid], [0, 0, 0], Math.min(len, tall, wid) * 0.2),
    button({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        group.add(block(paint(METAL), [len, tall * 0.45, wid], [0, -tall / 2 + tall * 0.225, 0]));
        group.add(rod(paint(plastic(accent ?? "#2b2d31")), Math.min(len, wid) * 0.3, tall * 0.55, [0, tall / 2 - tall * 0.275, 0]));
        return group;
    },
    // Glass on the thinnest side lets a screen lie flat or stand up; a standing one is cabled from below.
    display({ len, tall, wid, accent }, paint) {
        const group = new THREE.Group();
        const thin = Math.min(len, tall, wid);
        group.add(block(paint(plastic("#0d0f12")), [len, tall, wid], [0, 0, 0], thin * 0.3));
        const glass = paint({ color: accent ?? "#14263f", metalness: 0.2, roughness: 0.08, glow: 0.35 });
        if (thin === tall) return group.add(block(glass, [len * 0.9, tall * 0.04, wid * 0.86], [0, tall / 2, 0]));
        if (thin === wid) group.add(block(glass, [len * 0.9, tall * 0.86, wid * 0.04], [0, 0, wid / 2]));
        else group.add(block(glass, [len * 0.04, tall * 0.86, wid * 0.9], [len / 2, 0, 0]));
        group.userData.port = new THREE.Vector3(0, -tall / 2, 0);
        group.userData.portDir = new THREE.Vector3(0, -1, 0);
        return group;
    },
};

// Builds def.part on an fw by fd footprint, tall or of usual height; userData: port, portDir, copies.
export function buildPart(def, [fw, tall, fd], paint) {
    const kind = def.part;
    const facing = FRONT.has(kind) ? (ANGLE[def.facing] === undefined ? "right" : def.facing) : null;
    const turned = facing ? facing === "up" || facing === "down" : LONG[kind] === "x" ? fd > fw : LONG[kind] === "z" ? fw > fd : false;
    const [len, wid] = turned ? [fd, fw] : [fw, fd];
    const [cols, rows] = Array.isArray(def.grid) && def.grid.every((n) => Number.isInteger(n) && n > 0) ? def.grid : [Math.max(1, Math.round(len / wid)), 1];
    const p = { len, wid, cols, rows, order: def.order, first: def.first, pins: Boolean(def.pins), accent: def.color, stack: Math.min(4, Math.max(1, Math.round(def.stack ?? 1))) };
    p.pitch = Math.min(len / cols, wid / rows);
    p.tall = Number.isFinite(tall) && tall > 0 ? tall : TALL[kind](len, wid, p);
    const copies = [];
    const inner = BUILD[kind](p, paint, copies);
    inner.rotation.y = facing ? ANGLE[facing] : turned ? Math.PI / 2 : 0;
    const part = new THREE.Group();
    part.add(inner);
    const port = inner.userData.port ?? (facing ? new THREE.Vector3(len / 2, 0, 0) : null);
    const up = new THREE.Vector3(0, 1, 0);
    part.userData.port = port?.applyAxisAngle(up, inner.rotation.y);
    part.userData.portDir = (inner.userData.portDir ?? (facing ? new THREE.Vector3(1, 0, 0) : port ? up : null))?.clone().applyAxisAngle(up, inner.rotation.y);
    part.userData.copies = copies;
    return part;
}
