// Pure shape builders for 3D scenes: primitives, gears, springs, lofts, tubes, bases and ribbons.
import * as THREE from "three";
import { LoftGeometry } from "three/addons/geometries/LoftGeometry.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
export const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
export const isFlat = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
export const clamp01 = (value) => Math.min(1, Math.max(0, value));
export const v3 = (p, fallback = [0, 0, 0]) => new THREE.Vector3(...(isPoint(p) ? p : fallback));
export const sizeOf = (size, count, fallback) => {
    const values = Array.isArray(size) ? size.filter(Number.isFinite) : Number.isFinite(size) ? [size] : [];
    return Array.from({ length: count }, (_, i) => Math.max(0.001, values[i] ?? values[0] ?? fallback));
};
const outline = (points) => (Array.isArray(points) ? points.filter(isFlat).map(([x, y]) => new THREE.Vector2(x, y)) : []);

// A coil along y, for springs.
class Helix extends THREE.Curve {
    constructor(radius, height, coils) {
        super();
        Object.assign(this, { radius, height, coils });
    }

    getPoint(t, target = new THREE.Vector3()) {
        const a = t * this.coils * Math.PI * 2;
        return target.set(Math.cos(a) * this.radius, (t - 0.5) * this.height, Math.sin(a) * this.radius);
    }
}

// A toothed wheel facing +z: trapezoid teeth around the rim and a round hole for the axle.
function gearGeometry(def) {
    const teeth = Math.round(Math.min(200, Math.max(6, num(def.teeth, 16))));
    const r = num(def.radius, 1);
    const tooth = r * Math.min(0.22, 2.2 / teeth);
    const step = (Math.PI * 2) / teeth;
    const shape = new THREE.Shape();
    for (let i = 0; i < teeth; i++) {
        for (const [k, rim] of [[0, r - tooth], [0.2, r], [0.45, r], [0.65, r - tooth]]) {
            const a = (i + k) * step;
            if (i || k) shape.lineTo(Math.cos(a) * rim, Math.sin(a) * rim);
            else shape.moveTo(Math.cos(a) * rim, Math.sin(a) * rim);
        }
    }
    shape.closePath();
    const hole = num(def.hole, r * 0.18);
    if (hole > 0 && hole < r - tooth) shape.holes.push(new THREE.Path().absarc(0, 0, hole, 0, Math.PI * 2, true));
    const depth = Math.max(0.001, num(def.depth, r * 0.3));
    const bevel = depth * 0.06;
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 24 });
    geometry.translate(0, 0, -depth / 2);
    return geometry;
}

// Monotone cubic Hermite through (xs, ys): smooth, yet never bulging past the key values.
function smoothThrough(xs, ys) {
    const h = xs.slice(1).map((x, i) => x - xs[i]);
    const d = h.map((step, i) => (ys[i + 1] - ys[i]) / step);
    const m = ys.map((_, i) => {
        if (i === 0 || i === ys.length - 1) return d[Math.min(i, d.length - 1)];
        if (d[i - 1] * d[i] <= 0) return 0;
        const [a, b] = [2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]];
        return (a + b) / (a / d[i - 1] + b / d[i]);
    });
    return (x) => {
        let i = 0;
        while (i < h.length - 1 && x > xs[i + 1]) i++;
        const t = clamp01((x - xs[i]) / h[i]);
        const [t2, t3] = [t * t, t * t * t];
        return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (3 * t2 - 2 * t3) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
    };
}

const SECTION = { y: 0, z: 0, round: 0.7, top: 1, bottom: 1 };
export const traced = (def) => def.type === "loft" && Array.isArray(def.outline) && Boolean(def.region);
// Real units per screenshot pixel of a traced loft, whose size[0] is its picture's width.
export const perPixel = (def) => Math.max(0.001, num(def.size?.[0] ?? def.size, 1)) / def.region.w;
// A picture point in a traced loft's side plane: x across the picture, y up from its bottom edge.
export const sideSpot = (def, [x, y]) => [(x - def.region.x - def.region.w / 2) * perPixel(def), (def.region.y + def.region.h - y) * perPixel(def)];

// Slices a traced silhouette into sections at real scale, the width rounding off towards both ends.
function tracedSections(def) {
    const width = Math.max(0.001, num(def.size?.[1], num(def.size?.[0] ?? def.size, 1) * 0.4));
    const poly = def.outline.filter(isFlat);
    const xs = poly.map(([x]) => x);
    const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
    const sections = [];
    for (let i = 0; i <= 48; i++) {
        const t = 0.002 + (0.996 * i) / 48;
        const px = lo + (hi - lo) * t;
        const hits = [];
        poly.forEach(([ax, ay], j) => {
            const [bx, by] = poly[(j + 1) % poly.length];
            if (ax !== bx && (ax - px) * (bx - px) <= 0) hits.push(ay + ((px - ax) / (bx - ax)) * (by - ay));
        });
        if (hits.length < 2) continue;
        const [top, bottom] = [Math.min(...hits), Math.max(...hits)];
        const plan = (1 - Math.abs(2 * t - 1) ** 6) ** (1 / 6);
        const [at, y] = sideSpot(def, [px, (top + bottom) / 2]);
        sections.push({ at, y, width: width * plan, height: (bottom - top) * perPixel(def), round: def.round, top: def.top, bottom: def.bottom });
    }
    if (sections.length < 2) throw new Error(`loft "${def.id}": its outline is too thin to trace`);
    return sections;
}

// Lofts sections along x: rounded rectangles (round 1 is an ellipse) tapered by top and bottom.
function loftGeometry(def) {
    const given = traced(def) ? tracedSections(def) : def.sections;
    const keys = given.filter((s) => [s?.at, s?.width, s?.height].every(Number.isFinite)).sort((a, b) => a.at - b.at);
    const span = keys.at(-1).at - keys[0].at || 1;
    const xs = [];
    for (const s of keys) xs.push(xs.length && s.at <= xs.at(-1) ? xs.at(-1) + span * 1e-3 : s.at);
    const along = Object.fromEntries(["width", "height", ...Object.keys(SECTION)].map((key) => [key, smoothThrough(xs, keys.map((s) => num(s[key], SECTION[key])))]));
    const least = Math.max(...keys.map((s) => Math.max(s.width, s.height))) * 0.004;
    const ring = (x) => {
        const [w, h] = [Math.max(along.width(x), least) / 2, Math.max(along.height(x), least) / 2];
        const e = Math.min(1, Math.max(0.08, along.round(x)));
        return Array.from({ length: 64 }, (_, j) => {
            const a = (j / 64) * Math.PI * 2;
            const [u, v] = [Math.cos(a), Math.sin(a)].map((c) => Math.sign(c) * Math.abs(c) ** e);
            const lean = Math.max(0, v > 0 ? 1 + (along.top(x) - 1) * v : 1 + (along.bottom(x) - 1) * -v);
            return new THREE.Vector3(x, along.y(x) + h * v, along.z(x) - w * lean * u);
        });
    };
    const samples = xs.slice(0, -1).flatMap((x, i) => Array.from({ length: 8 }, (_, k) => x + ((xs[i + 1] - x) * k) / 8));
    return new LoftGeometry([...samples, xs.at(-1)].map(ring), { capStart: true, capEnd: true });
}

// A capped tube whose radius passes smoothly through radii, given one per point or spread evenly.
function taperedTube(curve, points, radii, closed) {
    const segments = Math.max(64, points.length * 24);
    const chord = [0];
    for (let i = 1; i < points.length; i++) chord.push(chord[i - 1] + points[i].distanceTo(points[i - 1]));
    const spread = radii.map((_, i) => i / (radii.length - 1));
    const atPoints = chord.map((c) => c / (chord.at(-1) || 1));
    const fractions = radii.length === points.length && atPoints.every((f, i) => !i || f > atPoints[i - 1]) ? atPoints : spread;
    const radiusAt = smoothThrough(fractions, radii);
    const { normals, binormals } = curve.computeFrenetFrames(segments, closed);
    const rings = Array.from({ length: segments + 1 }, (_, i) => {
        const p = curve.getPointAt(i / segments);
        const r = Math.max(radiusAt(i / segments), 1e-4);
        return Array.from({ length: 20 }, (_, j) => {
            const a = (j / 20) * Math.PI * 2;
            return p.clone().addScaledVector(normals[i], r * Math.cos(a)).addScaledVector(binormals[i], r * Math.sin(a));
        });
    });
    return new LoftGeometry(rings, { capStart: !closed, capEnd: !closed });
}

// Geometry for a plain shape object; null for types built otherwise.
export function geometryFor(def) {
    switch (def.type) {
        case "box": {
            const [w, h, d] = sizeOf(def.size, 3, 1);
            const radius = Math.min(num(def.radius, Math.min(w, h, d) * 0.08), Math.min(w, h, d) / 2 - 0.0001);
            return radius > 0 ? new RoundedBoxGeometry(w, h, d, 4, radius) : new THREE.BoxGeometry(w, h, d);
        }
        case "extrude": {
            const shape = new THREE.Shape(outline(def.points));
            for (const hole of (Array.isArray(def.holes) ? def.holes : []).map(outline)) if (hole.length >= 3) shape.holes.push(new THREE.Path(hole));
            const depth = Math.max(0.001, num(def.depth, 0.2));
            const bevel = Math.max(0, num(def.bevel, depth * 0.1));
            const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 24 });
            geometry.translate(0, 0, -depth / 2);
            if (def.plane === "xz") geometry.rotateX(-Math.PI / 2);
            return geometry;
        }
        case "gear":
            return gearGeometry(def);
        case "spring": {
            const coils = Math.min(60, Math.max(1, num(def.coils, 8)));
            const radius = num(def.radius, 0.5);
            return new THREE.TubeGeometry(new Helix(radius, num(def.height, 2), coils), Math.ceil(coils * 40), num(def.tube, radius * 0.08), 8, false);
        }
        case "lathe":
            return new THREE.LatheGeometry(outline(def.points).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y)), 64);
        case "loft":
            return loftGeometry(def);
        case "sphere":
            return new THREE.SphereGeometry(num(def.radius, 0.5), 48, 32);
        case "cylinder":
            return new THREE.CylinderGeometry(num(def.radius_top, num(def.radius, 0.5)), num(def.radius, 0.5), num(def.height, 1), 48);
        case "cone":
            return new THREE.ConeGeometry(num(def.radius, 0.5), num(def.height, 1), 48);
        case "torus":
            return new THREE.TorusGeometry(num(def.radius, 0.6), num(def.tube, 0.16), 24, 96);
        case "capsule":
            return new THREE.CapsuleGeometry(num(def.radius, 0.3), num(def.length, 1), 8, 24);
        case "plane": {
            const [w, h] = sizeOf(def.size, 2, 1);
            return new THREE.PlaneGeometry(w, h);
        }
        case "path": {
            const points = def.points.filter(isPoint).map((p) => v3(p));
            let curve;
            if (def.curve === false) {
                curve = new THREE.CurvePath();
                for (let i = 1; i < points.length; i++) curve.add(new THREE.LineCurve3(points[i - 1], points[i]));
            } else curve = new THREE.CatmullRomCurve3(points, Boolean(def.closed), "centripetal");
            const radii = Array.isArray(def.radii) ? def.radii.filter((r) => Number.isFinite(r) && r >= 0) : [];
            if (radii.length >= 2) return taperedTube(curve, points, radii, Boolean(def.closed));
            return new THREE.TubeGeometry(curve, Math.max(48, points.length * 24), num(def.radius, 0.035), 12, Boolean(def.closed));
        }
        default:
            return null;
    }
}

export function arrowFor(def, material) {
    const from = v3(def.from);
    const direction = v3(def.to, [1, 0, 0]).sub(from);
    const length = direction.length() || 1;
    const radius = num(def.radius, Math.max(0.02, length * 0.025));
    const head = Math.min(length * 0.35, radius * 6);
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length - head, 16), material);
    shaft.position.y = (length - head) / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.6, head, 24), material);
    tip.position.y = length - head / 2;
    group.add(shaft, tip);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    group.position.copy(from);
    return group;
}

function roundedRect(w, d, radius) {
    const [x, y] = [w / 2, d / 2];
    const r = Math.max(0.0001, Math.min(radius, x - 0.0001, y - 0.0001));
    const shape = new THREE.Shape().moveTo(-x + r, -y).lineTo(x - r, -y).absarc(x - r, -y + r, r, -Math.PI / 2, 0).lineTo(x, y - r).absarc(x - r, y - r, r, 0, Math.PI / 2);
    return shape.lineTo(-x + r, y).absarc(-x + r, y - r, r, Math.PI / 2, Math.PI).lineTo(-x, -y + r).absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5);
}

// A base traced in screenshot pixels: size is [width, thickness] and depth keeps the picture's aspect.
export function baseOf(def, material, gold) {
    const r = def.region;
    const w = Math.max(0.001, num(def.size?.[0] ?? def.size, 10));
    const t = Math.max(0.0005, num(def.size?.[1], w * 0.02));
    const d = (w * r.h) / r.w;
    const upright = def.plane === "xy";
    const toShape = ([x, y]) => new THREE.Vector2(((x - r.x) / r.w - 0.5) * w, (0.5 - (y - r.y) / r.h) * d);
    const points = Array.isArray(def.outline) ? def.outline.filter(isFlat).map(toShape) : [];
    const shape = points.length >= 3 ? new THREE.Shape(points) : roundedRect(w, d, num(def.radius, w * 0.035));
    const holes = (Array.isArray(def.holes) ? def.holes : []).filter(isPoint).map(([x, y, radius]) => [toShape([x, y]), (radius * w) / r.w]);
    for (const [c, radius] of holes) shape.holes.push(new THREE.Path().absarc(c.x, c.y, radius, 0, Math.PI * 2, true));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: t * 0.84, bevelEnabled: true, bevelThickness: t * 0.08, bevelSize: t * 0.08, bevelSegments: 2, curveSegments: 24 });
    geometry.translate(0, 0, -t * 0.42);
    if (!upright) geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    const face = t / 2 + t * 0.01;
    // Circuit boards get plated rings around their holes.
    for (const [c, radius] of def.material === "pcb" ? holes : []) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius * 1.7, 40), gold);
        ring.position.set(c.x, upright ? c.y : face, upright ? face : -c.y);
        if (!upright) ring.rotation.x = -Math.PI / 2;
        mesh.add(ring);
    }
    mesh.userData.frame = { w, d, t, upright, region: r, parts: 0 };
    return mesh;
}

// A flat cable along the curve, its width held level so it bends like a ribbon instead of twisting.
export function ribbonGeometry(curve, width, across) {
    const positions = [];
    const index = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
        const p = curve.getPointAt(i / segments);
        for (const s of [-0.5, 0.5]) positions.push(...p.clone().addScaledVector(across, s * width).toArray());
        if (i) index.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return geometry;
}

// A copy moved by matrix, keeping only position and normal and rewound to face outwards if mirrored.
export function baked(geometry, matrix) {
    const g = new THREE.BufferGeometry().copy(geometry);
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    g.clearGroups();
    g.applyMatrix4(matrix);
    if (matrix.determinant() >= 0) return g;
    const swap = ({ array, itemSize, count }) => {
        for (let i = 0; i + 2 < count; i += 3) {
            for (let k = 0; k < itemSize; k++) {
                const [a, b] = [(i + 1) * itemSize + k, (i + 2) * itemSize + k];
                [array[a], array[b]] = [array[b], array[a]];
            }
        }
    };
    if (g.index) swap(g.index);
    else [g.attributes.position, g.attributes.normal].forEach(swap);
    return g;
}
