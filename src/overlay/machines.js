// Ready-made machine parts: the shapes a mechanism is really made of, built in proportion from a few numbers.
import * as THREE from "three";
import { LoftGeometry } from "three/addons/geometries/LoftGeometry.js";
import { num } from "./shapes.js";

const STEEL = { color: "#a0a8b0", metalness: 1, roughness: 0.3 };
const DARK = { color: "#424953", metalness: 0.7, roughness: 0.45 };
const GLASS = { color: "#a8cbe6", metalness: 0, roughness: 0.05, glow: 0.18 };
const BORE = { color: "#0b0d10", metalness: 0, roughness: 0.95 };
const TURN = Math.PI * 2;

const mesh = (geometry, material, [x, y, z] = [0, 0, 0]) => {
    const node = new THREE.Mesh(geometry, material);
    node.position.set(x, y, z);
    return node;
};

// A shaft or disc lying along z, the axis every round part here turns about.
const disc = (material, radius, depth, z = 0, segments = 48) => {
    const node = mesh(new THREE.CylinderGeometry(radius, radius, depth, segments), material, [0, 0, z]);
    node.rotation.x = Math.PI / 2;
    return node;
};

// One ring of a toothed rim in the xy plane: trapezoid teeth, as many points per tooth as a gear's.
function toothRing(teeth, radius, tooth, z) {
    const points = [];
    for (let i = 0; i < teeth; i++) {
        for (const [k, rim] of [[0, radius - tooth], [0.2, radius], [0.45, radius], [0.65, radius - tooth]]) {
            const a = ((i + k) / teeth) * TURN;
            points.push(new THREE.Vector3(Math.cos(a) * rim, Math.sin(a) * rim, z));
        }
    }
    return points;
}

// An aerofoil blade reaching out along y: chord and thickness taper, and the pitch flattens towards the tip.
function bladeGeometry(hub, radius, chord, pitch) {
    const rings = [[hub, 1, 1], [hub + (radius - hub) * 0.5, 0.84, 0.62], [radius, 0.52, 0.3]].map(([y, c, t]) => {
        const twist = pitch * (1 - 0.62 * ((y - hub) / Math.max(1e-6, radius - hub)));
        const [half, thin] = [(chord * c) / 2, (chord * t * 0.2) / 2];
        return Array.from({ length: 28 }, (_, j) => {
            const a = (j / 28) * TURN;
            const [u, v] = [Math.cos(a) * half, Math.sin(a) * thin];
            return new THREE.Vector3(u * Math.cos(twist) - v * Math.sin(twist), y, u * Math.sin(twist) + v * Math.cos(twist));
        });
    });
    return new LoftGeometry(rings, { capStart: true, capEnd: true });
}

// A lens profile spun about its axis: each face is a shallow spherical cap of sag, negative for concave.
function lensGeometry(radius, thick, sag) {
    const s = Math.max(1e-4, Math.abs(sag));
    const sphere = (radius * radius + s * s) / (2 * s);
    const cap = (t) => Math.sign(sag) * (Math.sqrt(Math.max(0, sphere * sphere - (radius * t) ** 2)) - (sphere - s));
    const rim = sag < 0 ? Math.max(thick, s * 2.6) : Math.max(radius * 0.08, thick - 2 * s);
    const steps = Array.from({ length: 17 }, (_, i) => i / 16);
    const front = steps.map((t) => new THREE.Vector2(radius * t, rim / 2 + cap(t)));
    const geometry = new THREE.LatheGeometry([...front, ...front.reverse().map((p) => new THREE.Vector2(p.x, -p.y))], 44);
    geometry.rotateX(Math.PI / 2);
    return geometry;
}

// A flat outline spun into a solid of revolution is cheaper here as an extrusion facing +z.
function platePlate(shape, depth, hole) {
    if (hole > 0) shape.holes.push(new THREE.Path().absarc(0, 0, hole, 0, TURN, true));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.05, bevelSize: depth * 0.05, bevelSegments: 2, curveSegments: 36 });
    geometry.translate(0, 0, -depth / 2);
    return geometry;
}

// A helical thread wound on a shaft along y: a trapezoid ridge, so it reads as a screw and not a coil.
function threadGeometry(radius, length, coils) {
    const turns = Math.max(1, coils);
    const pitch = length / turns;
    const [inner, outer, flank] = [radius * 0.68, radius, pitch * 0.34];
    const steps = Math.ceil(turns * 40);
    const rings = Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        const a = t * turns * TURN;
        const [radial, y] = [new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), (t - 0.5) * length];
        return [[inner, flank], [outer, flank * 0.4], [outer, -flank * 0.4], [inner, -flank]].map(([r, up]) => radial.clone().multiplyScalar(r).setY(y + up));
    });
    return new LoftGeometry(rings, { capStart: true, capEnd: true });
}

const BUILD = {
    // Teeth on a cone, so two of them mesh at an angle: differentials, drills, hand mixers.
    bevel({ radius, depth, teeth, hole }, body, paint) {
        const group = new THREE.Group();
        const face = radius * 0.42;
        const lean = Math.SQRT1_2;
        const small = radius - face * lean;
        const tooth = radius * Math.min(0.24, 2.4 / teeth);
        group.add(mesh(new LoftGeometry([toothRing(teeth, radius, tooth, -face * lean * 0.5), toothRing(teeth, small, (tooth * small) / radius, face * lean * 0.5)], { capStart: true, capEnd: true }), body));
        group.add(disc(body, radius * 0.34, depth, -face * lean * 0.5 - depth / 2));
        if (hole > 0) group.add(disc(paint(BORE), hole, face * lean + depth * 1.1, 0));
        return group;
    },
    // A ring of pitched blades on a hub: fans, compressors, turbines, propellers, impellers, windmills.
    blades({ radius, depth, teeth, bulge }, body, paint) {
        const group = new THREE.Group();
        const hub = radius * 0.3;
        const geometry = bladeGeometry(hub * 0.92, radius, radius * 0.62, (bulge || 36) * (Math.PI / 180));
        for (let k = 0; k < teeth; k++) {
            const blade = mesh(geometry, body);
            blade.rotation.z = (k / teeth) * TURN;
            group.add(blade);
        }
        group.add(disc(paint(DARK), hub, Math.max(depth, radius * 0.3)));
        return group;
    },
    // A glass element that bends light: eyes, cameras, telescopes, glasses, projectors.
    lens({ radius, depth, bulge }, body) {
        return mesh(lensGeometry(radius, depth, (bulge || 0.2) * radius), body);
    },
    // A lobe on a shaft that lifts its follower once per turn: valve gear, pumps, sewing machines.
    cam({ radius, depth, bulge, hole }, body) {
        const lift = (bulge || 0.5) * radius;
        const window = 1.15;
        const shape = new THREE.Shape();
        for (let i = 0; i <= 120; i++) {
            const a = (i / 120) * TURN;
            const off = Math.abs(((a - Math.PI / 2 + Math.PI) % TURN) - Math.PI);
            const rim = radius + (off < window ? lift * (0.5 + 0.5 * Math.cos((Math.PI * off) / window)) ** 1.4 : 0);
            const [x, y] = [Math.cos(a) * rim, Math.sin(a) * rim];
            if (i) shape.lineTo(x, y);
            else shape.moveTo(x, y);
        }
        return mesh(platePlate(shape.closePath(), depth, hole), body);
    },
    // A toothed bar a pinion runs along, turning a turn into a straight push: steering, jacks, lifts.
    rack({ length, radius, depth, teeth }, body) {
        const bar = radius * 0.9;
        const pitch = length / teeth;
        const shape = new THREE.Shape().moveTo(-length / 2, -bar);
        for (let i = 0; i < teeth; i++) {
            const x = -length / 2 + i * pitch;
            shape.lineTo(x, 0).lineTo(x + pitch * 0.22, bar * 0.62).lineTo(x + pitch * 0.62, bar * 0.62).lineTo(x + pitch * 0.84, 0);
        }
        shape.lineTo(length / 2, -bar).closePath();
        const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
        geometry.translate(0, 0, -depth / 2);
        return mesh(geometry, body);
    },
    // A rim carried on spokes: bike and cart wheels, pulleys, jockey wheels, hand wheels, flywheels.
    wheel({ radius, depth, teeth, hole }, body, paint) {
        const group = new THREE.Group();
        const rim = new THREE.Shape().absarc(0, 0, radius, 0, TURN, false);
        group.add(mesh(platePlate(rim, depth, radius * 0.86), body));
        group.add(disc(paint(DARK), Math.max(hole * 1.9, radius * 0.17), depth * 1.5));
        const spoke = new THREE.BoxGeometry(radius * 0.055, radius * 0.72, depth * 0.45);
        for (let k = 0; k < Math.max(3, teeth); k++) {
            const arm = mesh(spoke, body, [0, radius * 0.56, 0]);
            const hold = new THREE.Group();
            hold.rotation.z = (k / Math.max(3, teeth)) * TURN;
            group.add(hold.add(arm));
        }
        if (hole > 0) group.add(disc(paint(BORE), hole, depth * 1.7));
        return group;
    },
    // A helical thread wound on a shaft along y: bolts, lead screws, worm drives, augers, drill bits.
    thread({ length, radius, coils }, body) {
        const group = new THREE.Group();
        group.add(mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, length, 32), body));
        group.add(mesh(threadGeometry(radius, length, coils), body));
        return group;
    },
};

export const MACHINE_KINDS = Object.keys(BUILD);
const COUNT = { bevel: 14, blades: 10, rack: 9, wheel: 8 };

// Builds def.part on a [w, h, d] box; round parts turn about z, straight ones run along y or x.
export function buildMachine(def, [w, h, d], paint) {
    const kind = def.part;
    const across = kind === "rack" ? h : Math.max(w, d);
    const p = {
        radius: Math.max(0.001, num(def.radius, across / 2)),
        teeth: Math.round(Math.min(90, Math.max(3, num(def.teeth, COUNT[kind] ?? 8)))),
        coils: Math.min(60, Math.max(1, num(def.coils, 8))),
        bulge: num(def.bulge, 0),
        hole: Math.max(0, num(def.hole, 0)),
    };
    p.length = Math.max(0.001, num(def.length, kind === "rack" ? w : h));
    p.depth = Math.max(0.001, num(def.height, Math.min(d, p.radius * 0.9)));
    const body = paint({ ...STEEL, ...(kind === "lens" ? GLASS : {}), ...(def.color ? { color: def.color } : {}) });
    const part = new THREE.Group();
    part.add(BUILD[kind](p, body, paint));
    part.userData.copies = [];
    return part;
}
