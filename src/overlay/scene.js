// 3D motion graphics: builds a declarative three.js scene and plays its steps in time with narration.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { gridCount } from "/shared/scene.mjs";
import { buildPart } from "./parts.js";
import { arrowFor, baked, baseOf, clamp01, geometryFor, isFlat, isPoint, num, perPixel, ribbonGeometry, sideSpot, sizeOf, traced, v3 } from "./shapes.js";

const PALETTE = ["#a371f7", "#58a6ff", "#3fb950", "#f2cc60", "#ff7b72", "#79c0ff", "#d2a8ff", "#ffa657"];
const DURATION = { highlight: 1.4, camera: 1.3 };
const DEG = Math.PI / 180;
// Label pill and closed-label dot heights in CSS pixels.
const [LABEL_PX, DOT_PX] = [18, 8];
// Surface finishes; physical ones need MeshPhysicalMaterial for clearcoat or transmission.
const FINISHES = {
    metal: { metalness: 0.9, roughness: 0.25, color: "#c9d1d9" },
    gold: { metalness: 1, roughness: 0.3, color: "#d4a84b" },
    copper: { metalness: 1, roughness: 0.35, color: "#c27a4a" },
    plastic: { metalness: 0, roughness: 0.4, physical: { clearcoat: 0.6, clearcoatRoughness: 0.3 } },
    rubber: { metalness: 0, roughness: 0.95, color: "#2b2d31" },
    glass: { metalness: 0, roughness: 0.04, color: "#e6f2ff", physical: { transmission: 0.92, thickness: 0.5, ior: 1.5 } },
    pcb: { metalness: 0.05, roughness: 0.62, color: "#1d6a36", physical: { clearcoat: 0.15, clearcoatRoughness: 0.5 } },
    screen: { metalness: 0.1, roughness: 0.08, color: "#0d1117", physical: { clearcoat: 1, clearcoatRoughness: 0.05 } },
    matte: { metalness: 0, roughness: 0.85 },
    paint: { metalness: 0.45, roughness: 0.38, physical: { clearcoat: 1, clearcoatRoughness: 0.06 } },
    chrome: { metalness: 1, roughness: 0.06, color: "#eef2f6" },
};
const smooth = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const overshoot = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

function colorOf(value, index) {
    const color = new THREE.Color(PALETTE[index % PALETTE.length]);
    if (typeof value === "string" && CSS.supports("color", value)) color.setStyle(value);
    return color;
}

// Where a point in the picture falls on a base, as u, v from the picture's top-left.
const frameUV = ({ region: r }, [x, y]) => [clamp01((x - r.x) / r.w), clamp01((y - r.y) / r.h)];
const READING = { right: 0, up: Math.PI / 2, left: Math.PI, down: -Math.PI / 2 };

// Text printed flat on a base, like silkscreen, reading in the facing direction.
function printed(def, frame, height) {
    const font = "700 64px -apple-system, system-ui, sans-serif";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(String(def.text)).width) + 16;
    canvas.height = 84;
    // Resizing the canvas resets its context, font included.
    ctx.font = font;
    ctx.fillStyle = typeof def.color === "string" && CSS.supports("color", def.color) ? def.color : "#eef1f4";
    ctx.textBaseline = "middle";
    ctx.fillText(String(def.text), 8, 44);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry((height * canvas.width) / canvas.height, height), material);
    const group = new THREE.Group();
    group.add(plane);
    if (frame.upright) group.rotation.z = READING[def.facing] ?? 0;
    else {
        plane.rotation.x = -Math.PI / 2;
        group.rotation.y = READING[def.facing] ?? 0;
    }
    return group;
}

async function loadTexture(url, id) {
    try {
        const texture = await new THREE.TextureLoader().loadAsync(url);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    } catch {
        throw new Error(`the picture for "${id}" could not be loaded`);
    }
}

const materialsOf = (obj) => {
    const list = [];
    obj.traverse((node) => node.material && list.push(...[node.material].flat()));
    return [...new Set(list)];
};

const isShown = (obj) => {
    for (let node = obj; node; node = node.parent) if (!node.visible) return false;
    return true;
};

// The marker a closed label shrinks to: a light dot in a dark ring.
function dotTexture() {
    const canvas = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
    const ctx = canvas.getContext("2d");
    for (const [r, fill] of [[15, "rgba(13, 17, 23, 0.85)"], [9, "#e6edf3"]]) {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(16, 16, r, 0, Math.PI * 2);
        ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// spec: { view, camera, objects, steps, autoplay, stepSeconds, loop }; returns { step(index), dispose() }.
export async function renderScene(spec, { root, makeLabel, inPlace = false }) {
    const size = () => [root.clientWidth || innerWidth, Math.max(1, root.clientHeight || innerHeight)];
    const [width, height] = size();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    root.append(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    // Softer studio reflections keep colours true, so dark plastics, boards and metals do not wash out.
    scene.environmentIntensity = 0.6;
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 8, 6);
    const rim = new THREE.DirectionalLight(0x9ecbff, 0.8);
    rim.position.set(-6, 4, -6);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30363d, 0.8), key, rim);

    const flat = spec.view === "flat" || inPlace;
    const camera = new THREE.PerspectiveCamera(flat ? 30 : 42, width / height, 0.01, 5000);
    // Narrated scenes keep their subtitles along the bottom, so the view is lifted above that strip.
    const inset = spec.autoplay === false ? 110 : 0;
    const applyView = () => {
        const [w, h] = size();
        camera.aspect = w / h;
        if (inset && h > inset * 2) camera.setViewOffset(w, h, 0, inset / 2, w, h);
        else camera.clearViewOffset();
        camera.updateProjectionMatrix();
    };
    applyView();
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enableRotate = !flat;

    // Labels open for what the current step is about (focus; null means all), the part under the pointer, and close while dragging.
    const labels = [];
    const marker = dotTexture();
    let focus = null;
    let hovered = null;
    let dragging = false;
    let aimed = false;
    const pointer = new THREE.Vector2();
    const ray = new THREE.Raycaster();
    controls.addEventListener("start", () => {
        controls.autoRotate = false;
        dragging = true;
    });
    controls.addEventListener("end", () => (dragging = false));
    renderer.domElement.addEventListener("pointermove", (event) => {
        const r = renderer.domElement.getBoundingClientRect();
        pointer.set(((event.clientX - r.left) / r.width) * 2 - 1, 1 - ((event.clientY - r.top) / r.height) * 2);
        aimed = true;
    });
    renderer.domElement.addEventListener("pointerleave", () => {
        aimed = false;
        hovered = null;
    });

    const items = new Map();
    const flows = new Map();
    const tweens = [];
    const defs = Array.isArray(spec.objects) ? spec.objects : [];
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    let now = performance.now() / 1000;
    let unit = 2;
    let flowCount = 0;
    let played = -1;
    let timer = 0;
    const tween = (duration, delay, update, done) => tweens.push({ start: now + delay, duration: Math.max(duration, 0.0001), update, done });
    const centreOf = (obj) => new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    const radiusOf = (obj) => new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere()).radius;
    // The object inside its pivot, if any: children, labels, ports and exploded parts belong to it.
    const host = (item) => item?.obj.userData.body ?? item?.obj;

    async function build(def, index) {
        const finish = FINISHES[def.material] ?? (def.metal ? FINISHES.metal : {});
        const frame = typeof def.on === "string" ? host(items.get(def.on))?.userData.frame : null;
        const board = frame?.side ? null : frame;
        // def.footprint is in picture pixels; parts sharing a spot shrink a hair each to stop flicker.
        const inset = board ? 1 - 0.004 * (board.parts++ % 5) : 1;
        let foot = board && isFlat(def.footprint) ? [(def.footprint[0] / board.region.w) * board.w * inset, (def.footprint[1] / board.region.h) * board.d * inset] : null;
        if (frame?.side && isFlat(def.footprint)) foot = def.footprint.map((v) => v * perPixel(frame.side));
        const color = colorOf(def.color ?? finish.color, index);
        const opacity = clamp01(num(def.opacity, 1));
        const Material = finish.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
        const material = (extra = {}) =>
            new Material({
                color,
                roughness: finish.roughness ?? 0.45,
                metalness: finish.metalness ?? 0.05,
                ...finish.physical,
                emissive: color.clone(),
                emissiveIntensity: def.glow ? 0.55 : 0,
                transparent: true,
                opacity,
                depthWrite: opacity > 0.98,
                wireframe: Boolean(def.wireframe),
                ...extra,
            });
        const paint = ({ color: tone, metalness = 0.05, roughness = 0.5, glow = 0 }) => {
            const c = new THREE.Color(tone);
            return new THREE.MeshStandardMaterial({ color: c, metalness, roughness, emissive: c.clone(), emissiveIntensity: glow, transparent: true, opacity, depthWrite: opacity > 0.98 });
        };
        let obj;
        if (def.type === "group") obj = new THREE.Group();
        else if (def.type === "text" && board) obj = printed(def, board, num(def.size?.[0] ?? def.size, foot ? Math.min(...foot) * 0.8 : board.w * 0.03));
        else if (def.type === "text") obj = makeLabel(THREE, def.text, null, { size: num(def.size?.[0] ?? def.size, unit * 0.09) });
        else if (def.type === "base") obj = baseOf(def, material(), paint({ color: "#d4a84b", metalness: 1, roughness: 0.3 }));
        else if (def.type === "part") obj = buildPart(def, foot ? [foot[0], num(def.height, NaN), foot[1]] : sizeOf(def.size, 3, 1), paint);
        else if (def.type === "arrow") obj = arrowFor(def, material());
        else if (def.type === "image") {
            const texture = await loadTexture(def.image, def.id);
            const h = sizeOf(def.size, 1, 2)[0];
            const aspect = texture.image.width / texture.image.height || 1;
            obj = new THREE.Mesh(new THREE.PlaneGeometry(h * aspect, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, side: THREE.DoubleSide }));
        } else if (foot && ["box", "cylinder"].includes(def.type)) {
            const tall = num(def.height, Math.min(...foot) * 0.5);
            const fitted = def.type === "box" ? { ...def, size: frame.upright ? [foot[0], foot[1], tall] : [foot[0], tall, foot[1]] } : { ...def, radius: Math.min(...foot) / 2, height: tall };
            obj = new THREE.Mesh(geometryFor(fitted), material());
            if (def.type === "cylinder" && frame.upright) obj.rotation.x = Math.PI / 2;
        } else if (gridCount(def) && geometryFor(def)) {
            obj = new THREE.Group();
            const geometry = geometryFor(def);
            geometry.computeBoundingBox();
            const part = geometry.boundingBox.getSize(new THREE.Vector3());
            const upright = def.plane === "xy";
            const [columns, rows] = def.grid;
            const [gapX, gapY] = sizeOf(def.spacing ?? [part.x * 1.6, (upright ? part.y : part.z) * 1.6], 2, 0);
            for (let n = 0; n < columns * rows; n++) {
                const [col, row] = def.order === "columns" ? [Math.floor(n / rows), n % rows] : [n % columns, Math.floor(n / columns)];
                const copy = new THREE.Mesh(geometry, material());
                const [x, r] = [(col - (columns - 1) / 2) * gapX, (row - (rows - 1) / 2) * gapY];
                copy.position.set(x, upright ? -r : 0, upright ? 0 : r);
                obj.add(copy);
            }
        } else obj = new THREE.Mesh(geometryFor(def), material({ side: ["plane", "lathe"].includes(def.type) ? THREE.DoubleSide : THREE.FrontSide }));
        if (def.type !== "arrow") obj.position.copy(v3(def.position));
        if (isPoint(def.rotation)) obj.rotation.set(...def.rotation.map((d) => d * DEG));
        if (Number.isFinite(def.scale)) obj.scale.setScalar(def.scale);
        else if (isPoint(def.scale)) obj.scale.set(...def.scale);
        // Things on a base or traced loft sit at their spot in its picture; position then nudges them.
        if (frame?.side && isFlat(def.at)) obj.position.set(...sideSpot(frame.side, def.at), 0).add(v3(def.position));
        else if (board && isFlat(def.at)) {
            obj.position.set(0, 0, 0);
            obj.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(obj);
            const [u, v] = frameUV(board, def.at);
            const { w, d, t, upright } = board;
            const lift = box.isEmpty() ? 0 : upright ? box.min.z : box.min.y;
            const spot = upright ? [(u - 0.5) * w, (0.5 - v) * d, t / 2 - lift] : [(u - 0.5) * w, t / 2 - lift, (v - 0.5) * d];
            obj.position.fromArray(spot).add(v3(def.position));
        }
        if (traced(def)) obj.userData.frame = { side: def, upright: true };
        // Copies spaced evenly around an axis through the parent's origin, like spokes, blades or petals.
        const count = Math.round(num(def.radial, 0));
        if (count > 1) {
            const ring = new THREE.Group();
            const axis = new THREE.Vector3().setComponent(Math.max(0, ["x", "y", "z"].indexOf(def.axis ?? "y")), 1);
            for (let k = 0; k < count; k++) {
                const turn = new THREE.Group();
                turn.quaternion.setFromAxisAngle(axis, (k / count) * Math.PI * 2);
                ring.add(turn.add(k ? obj.clone() : obj));
            }
            ring.userData.copies = ring.children.map((turn) => turn.children[0]);
            obj = ring;
        }
        // A pivot group at the hinge or axle makes rotate and spin swing the object about that point.
        if (isPoint(def.pivot)) {
            const hinge = new THREE.Group();
            hinge.position.copy(v3(def.pivot));
            obj.position.sub(hinge.position);
            hinge.add(obj);
            hinge.userData.body = obj;
            obj = hinge;
        }
        return record(def, obj);
    }

    // Remembers an object's starting transform, colours and material state for reset.
    function record(def, obj) {
        const mats = materialsOf(obj);
        for (const m of mats) Object.assign(m.userData, { opacity: m.opacity, base: m.opacity, glow: m.emissiveIntensity ?? 0 });
        const home = { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() };
        return { def, obj, home, shownScale: obj.scale.clone(), colors: mats.map((m) => m.color?.clone()), spin: null };
    }

    // Where a wire meets a part: its port, else its top in 3D or the edge facing the other end when flat.
    function endOf(end, toward) {
        if (isPoint(end)) return v3(end);
        const target = host(items.get(end));
        if (!target) return new THREE.Vector3();
        if (!flat && target.userData.port) return target.localToWorld(target.userData.port.clone());
        const box = new THREE.Box3().setFromObject(target);
        if (flat) return toward ? box.clampPoint(toward, new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
        return new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    }

    // The way a cable leaves an end: straight out of a part's opening, otherwise upwards.
    function leaving(end) {
        const target = typeof end === "string" ? host(items.get(end)) : null;
        return target?.userData.portDir ? target.userData.portDir.clone().transformDirection(target.matrixWorld) : new THREE.Vector3(0, 1, 0);
    }

    // Lays a wire as an arcing cable between its ends; runs every frame so it follows moving parts.
    function layWire(item) {
        const { def, obj, wire } = item;
        const a = endOf(def.from, endOf(def.to));
        const b = endOf(def.to, a);
        const key = [...a.toArray(), ...b.toArray()].map((v) => v.toFixed(3)).join();
        if (key === wire.key) return;
        wire.key = key;
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const lift = Math.min(unit, a.distanceTo(b) * 0.35) * num(def.sag, 1);
        const bend = flat && new THREE.Vector3(a.y - b.y, b.x - a.x, 0).normalize().multiplyScalar(lift * 0.6);
        const [outA, outB] = flat ? [bend, bend] : [leaving(def.from).multiplyScalar(lift), leaving(def.to).multiplyScalar(lift)];
        wire.curve = new THREE.CubicBezierCurve3(a.clone().sub(mid), a.clone().add(outA).sub(mid), b.clone().add(outB).sub(mid), b.clone().sub(mid));
        obj.geometry.dispose();
        if (wire.ribbon) {
            const across = new THREE.Vector3().crossVectors(b.clone().sub(a), new THREE.Vector3(0, flat ? 0 : 1, flat ? 1 : 0));
            obj.geometry = ribbonGeometry(wire.curve, wire.ribbon, across.lengthSq() > 1e-9 ? across.normalize() : new THREE.Vector3(1, 0, 0));
        } else obj.geometry = new THREE.TubeGeometry(wire.curve, 64, num(def.radius, unit * 0.012), 8, false);
        obj.geometry.setDrawRange(0, Math.ceil(obj.geometry.index.count * wire.drawn));
        obj.position.copy(mid);
        // Plug ends sit along the direction the cable leaves, so a plug points into its socket.
        wire.caps.forEach((cap, i) => {
            const out = leaving(i ? def.to : def.from);
            cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
            cap.position.copy(i ? b : a).sub(mid).addScaledVector(out, cap.scale.y / 2);
        });
    }

    function buildWire(def, index) {
        const color = colorOf(def.color, index);
        const opacity = clamp01(num(def.opacity, 1));
        const ribbon = def.style === "ribbon" ? Math.max(0.001, num(def.width, unit * 0.08)) : 0;
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05, emissive: color.clone(), emissiveIntensity: def.glow ? 0.55 : 0, transparent: true, opacity, side: ribbon ? THREE.DoubleSide : THREE.FrontSide });
        const obj = new THREE.Mesh(new THREE.BufferGeometry(), material);
        const r = num(def.radius, unit * 0.012);
        const caps = flat || ribbon ? [] : [0, 1].map(() => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#21262d", roughness: 0.5, transparent: true })));
        for (const cap of caps) {
            cap.scale.set(r * 4.5, r * 9, r * 4.5);
            obj.add(cap);
        }
        const item = { ...record(def, obj), wire: { caps, ribbon, key: "", drawn: def.hidden ? 0 : 1, curve: null } };
        scene.add(obj);
        layWire(item);
        item.home.position.copy(obj.position);
        return item;
    }

    function attachLabel(item, text) {
        const old = labels.findIndex((l) => l.item === item);
        if (old >= 0) {
            const { sprite, dot } = labels[old];
            scene.remove(sprite, dot);
            sprite.material.map?.dispose();
            labels.splice(old, 1);
        }
        if (!String(text ?? "").trim()) return;
        const sprite = makeLabel(THREE, String(text).slice(0, 60), null, { size: 1 });
        const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: marker, transparent: true, depthTest: false }));
        for (const s of [sprite, dot]) {
            s.material.sizeAttenuation = false;
            s.userData.label = item;
        }
        dot.renderOrder = 9;
        scene.add(sprite, dot);
        labels.push({ item, sprite, dot, open: 0, lift: 0, shift: 0, fade: 1 });
    }

    // Carves each object's cutters (openings, arches, cutaways) out of it; the cutters are not drawn.
    async function carve() {
        const cutters = new Set(defs.flatMap((def) => (Array.isArray(def.cut) ? def.cut : [])).filter((id) => items.has(id)));
        if (!cutters.size) return;
        const { Brush, Evaluator, SUBTRACTION } = await import("three-bvh-csg");
        const evaluator = Object.assign(new Evaluator(), { attributes: ["position", "normal"], useGroups: false });
        // An object's own meshes, leaving out other objects attached to it.
        const roots = new Set([...items.values()].filter((item) => !item.def.copy).map((item) => item.obj));
        const meshes = (obj) => {
            const list = [];
            const visit = (node) => {
                if (node !== obj && roots.has(node)) return;
                if (node.isMesh) list.push(node);
                node.children.forEach(visit);
            };
            visit(obj);
            return list;
        };
        // A cutter's meshes in world space, plus reflections if mirrored, scaled by s about their centres.
        const placements = (item, s) => {
            const axis = ["x", "y", "z"].indexOf(item.def.mirror);
            const frame = item.obj.parent.matrixWorld;
            const flip = frame.clone().multiply(new THREE.Matrix4().makeScale(...[0, 1, 2].map((i) => (i === axis ? -1 : 1)))).multiply(frame.clone().invert());
            const scaled = (geometry, matrix) => {
                if (!geometry.boundingBox) geometry.computeBoundingBox();
                const c = geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(matrix);
                return new THREE.Matrix4().makeTranslation(c).multiply(new THREE.Matrix4().makeScale(s, s, s)).multiply(new THREE.Matrix4().makeTranslation(c.negate())).multiply(matrix);
            };
            return meshes(item.obj).flatMap((mesh) => [mesh.matrixWorld, ...(axis < 0 ? [] : [flip.clone().multiply(mesh.matrixWorld)])].map((matrix) => [mesh.geometry, scaled(mesh.geometry, matrix)]));
        };
        // A cutter shrinks a hair per layer inwards, so inner cut faces sit just in front of outer ones.
        const radius = (id) => radiusOf(items.get(id).obj);
        const targets = defs.filter((def) => Array.isArray(def.cut) && items.has(def.id) && !cutters.has(def.id)).map((def) => def.id);
        const rank = (cutter, id) => targets.filter((other) => defs.find((def) => def.id === other).cut.includes(cutter) && radius(other) > radius(id)).length;
        for (const def of defs) {
            if (!targets.includes(def.id)) continue;
            const tools = def.cut.filter((id) => id !== def.id && cutters.has(id)).flatMap((id) => placements(items.get(id), 1 - 0.002 * rank(id, def.id)));
            if (!tools.length) continue;
            for (const mesh of meshes(items.get(def.id).obj)) {
                const local = mesh.matrixWorld.clone().invert();
                let brush = new Brush(baked(mesh.geometry, new THREE.Matrix4()));
                for (const [geometry, matrix] of tools) {
                    try {
                        brush = evaluator.evaluate(brush, new Brush(baked(geometry, local.clone().multiply(matrix))), SUBTRACTION);
                    } catch (error) {
                        console.warn(`Could not cut "${def.id}":`, error);
                    }
                }
                mesh.geometry = brush.geometry;
            }
        }
        for (const id of cutters) {
            items.get(id).obj.removeFromParent();
            for (const key of [...items.keys()]) if (key === id || key.startsWith(`${id}#`)) items.delete(key);
        }
    }

    // Bases and traced lofts first, for parts to sit on; free text last, as it is sized from the rest.
    const pass = (def) => (def.type === "base" || traced(def) ? 0 : def.type === "text" && def.on === undefined ? 2 : 1);
    for (const current of [0, 1, 2]) {
        for (const [index, def] of defs.entries()) {
            if (def.type === "wire" || pass(def) !== current) continue;
            const item = await build(def, index);
            items.set(def.id, item);
            const copies = host(item).userData.copies ?? (gridCount(def) ? host(item).children : []);
            copies.forEach((copy, n) => items.set(`${def.id}#${n + 1}`, record({ id: `${def.id}#${n + 1}`, copy: true }, copy)));
        }
        if (current === 1) {
            const box = new THREE.Box3();
            for (const item of items.values()) box.expandByObject(item.obj);
            if (!box.isEmpty()) unit = Math.max(0.2, box.getBoundingSphere(new THREE.Sphere()).radius);
        }
    }
    for (const item of items.values()) {
        if (item.def.copy) continue;
        const parent = host(items.get(item.def.on ?? item.def.parent));
        let cycle = false;
        for (let node = parent; node && !cycle; node = node.parent) cycle = node === item.obj;
        (parent && !cycle ? parent : scene).add(item.obj);
    }
    scene.updateMatrixWorld(true);
    await carve();
    // A mirrored object gets a twin across its parent's centre plane that copies every move, mirrored.
    const twins = [];
    for (const item of items.values()) {
        const axis = ["x", "y", "z"].indexOf(item.def.mirror);
        if (axis < 0 || item.def.copy) continue;
        const mirror = new THREE.Group();
        mirror.scale.setComponent(axis, -1);
        const twin = item.obj.clone();
        item.obj.parent.add(mirror.add(twin));
        twins.push([item.obj, twin]);
    }
    const follow = (original, twin) => {
        twin.position.copy(original.position);
        twin.quaternion.copy(original.quaternion);
        twin.scale.copy(original.scale);
        twin.visible = original.visible;
        original.children.forEach((child, i) => twin.children[i] && follow(child, twin.children[i]));
    };
    scene.updateMatrixWorld(true);
    // Wires are laid once everything else is in place, so they can find their ends.
    const wires = [];
    for (const [index, def] of defs.entries()) if (def.type === "wire") wires.push(items.set(def.id, buildWire(def, index)).get(def.id));
    scene.updateMatrixWorld(true);

    const all = new THREE.Box3();
    for (const item of items.values()) all.expandByObject(item.obj);
    for (const [, twin] of twins) all.expandByObject(twin);
    // Per-mesh boxes, as a sparse model (a long shaft, angled parts) fills far less than its overall box.
    const partBoxes = () => {
        const boxes = [];
        scene.traverse((node) => node.isMesh && boxes.push(new THREE.Box3().setFromObject(node)));
        return boxes.filter((box) => !box.isEmpty());
    };
    const sphere = all.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 2) : all.getBoundingSphere(new THREE.Sphere());
    unit = Math.max(0.2, sphere.radius);
    const fitDistance = (radius) => (radius * 1.25) / Math.sin((camera.fov * DEG) / 2);
    // Frames the parts from direction as tightly as margin allows, fitting every corner at its own depth.
    const frame = (box, direction, margin, parts = [box]) => {
        const target = box.getCenter(new THREE.Vector3());
        const back = direction.clone().normalize();
        const right = new THREE.Vector3().crossVectors(camera.up, back).normalize();
        const up = new THREE.Vector3().crossVectors(back, right);
        const tan = Math.tan((camera.fov * DEG) / 2);
        const tall = tan * (camera.view ? (size()[1] - inset) / size()[1] : 1);
        let distance = 0;
        for (const part of parts) {
            for (const x of [part.min.x, part.max.x]) for (const y of [part.min.y, part.max.y]) for (const z of [part.min.z, part.max.z]) {
                const p = new THREE.Vector3(x, y, z).sub(target);
                const depth = p.dot(back);
                distance = Math.max(distance, depth + (Math.abs(p.dot(right)) * margin) / (tan * camera.aspect), depth + (Math.abs(p.dot(up)) * margin) / tall);
            }
        }
        return { target, position: target.clone().addScaledVector(back, distance) };
    };
    const home = all.isEmpty()
        ? { target: new THREE.Vector3(), position: new THREE.Vector3(0, 0, 8) }
        : frame(all, flat ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0.55, 0.42, 0.85), inPlace ? 1 : 1.15, partBoxes());
    if (isPoint(spec.camera?.position)) home.position = v3(spec.camera.position);
    if (typeof spec.camera?.target === "string" && items.has(spec.camera.target)) home.target = centreOf(items.get(spec.camera.target).obj);
    else if (isPoint(spec.camera?.target)) home.target = v3(spec.camera.target);
    const distance = home.position.distanceTo(home.target);
    camera.near = Math.max(0.01, distance / 300);
    camera.far = distance * 300;
    camera.updateProjectionMatrix();
    camera.position.copy(home.position);
    controls.target.copy(home.target);
    controls.autoRotate = !flat && !steps.length;
    controls.autoRotateSpeed = 0.8;

    for (const item of items.values()) {
        if (item.def.label) attachLabel(item, item.def.label);
        if (item.def.hidden) item.obj.visible = false;
    }

    function show(item, duration, delay) {
        const { obj } = item;
        const mats = materialsOf(obj);
        if (item.wire) {
            if (obj.visible && item.wire.drawn >= 1) return;
            obj.visible = true;
            for (const m of mats) m.opacity = m.userData.opacity;
            item.wire.caps.forEach((cap, i) => (cap.visible = !i));
            tween(duration * 1.5, delay, (k) => {
                item.wire.drawn = smooth(k);
                obj.geometry.setDrawRange(0, Math.ceil(obj.geometry.index.count * item.wire.drawn));
                if (k >= 1) for (const cap of item.wire.caps) cap.visible = true;
            });
            return;
        }
        if (!obj.visible) {
            obj.scale.setScalar(0.0001);
            for (const m of mats) m.opacity = 0;
        }
        obj.visible = true;
        const start = obj.scale.clone();
        tween(duration, delay, (k) => {
            obj.scale.lerpVectors(start, item.shownScale, overshoot(k));
            for (const m of mats) m.opacity = m.userData.opacity * Math.min(1, k * 1.5);
        });
    }

    function hide(item, duration, delay) {
        const { obj } = item;
        const mats = materialsOf(obj);
        const start = obj.scale.clone();
        const from = mats.map((m) => m.opacity);
        tween(duration, delay, (k) => {
            obj.scale.copy(start).multiplyScalar(Math.max(0.0001, 1 - smooth(k) * 0.6));
            mats.forEach((m, i) => (m.opacity = from[i] * (1 - smooth(k))));
        }, () => {
            obj.visible = false;
            obj.scale.copy(item.shownScale);
            for (const m of mats) m.opacity = m.userData.opacity;
        });
    }

    function flow(a, delay) {
        const id = typeof a.id === "string" ? a.id : `flow-${++flowCount}`;
        stopFlow(id, 0);
        const end = (value) => (typeof value === "string" && items.has(value) ? centreOf(items.get(value).obj) : v3(value));
        const along = typeof a.along === "string" ? items.get(a.along) : null;
        const points = along?.wire ? [] : [end(a.from), ...(Array.isArray(a.via) ? a.via.filter(isPoint).map((p) => v3(p)) : []), end(a.to)];
        const curve = along?.wire ? null : points.length > 2 ? new THREE.CatmullRomCurve3(points, false, "centripetal") : new THREE.LineCurve3(points[0], points[1]);
        const at = along?.wire ? (u) => along.wire.curve.getPointAt(u).add(along.obj.position) : (u) => curve.getPointAt(u);
        const color = colorOf(a.color ?? "#79c0ff", 5);
        const r = num(a.size, unit * 0.022);
        const dot = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        const trail = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
        const group = new THREE.Group();
        const geometry = new THREE.SphereGeometry(r, 12, 8);
        const count = Math.round(Math.min(60, Math.max(3, num(a.count, 14))));
        const dots = Array.from({ length: count }, () => new THREE.Mesh(geometry, dot));
        group.add(...dots);
        if (curve) group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, r * 0.22, 6), trail));
        scene.add(group);
        flows.set(id, { group, dots, at, speed: num(a.speed, 0.3), start: now + delay, dot, trail });
        tween(0.5, delay, (k) => {
            dot.opacity = 0.95 * k;
            trail.opacity = 0.2 * k;
        });
    }

    function stopFlow(id, duration) {
        const f = flows.get(id);
        if (!f) return;
        flows.delete(id);
        const [a, b] = [f.dot.opacity, f.trail.opacity];
        tween(duration, 0, (k) => {
            f.dot.opacity = a * (1 - k);
            f.trail.opacity = b * (1 - k);
        }, () => scene.remove(f.group));
    }

    function aim(a, duration, delay) {
        const item = typeof a.target === "string" ? items.get(a.target) : null;
        let target = item ? centreOf(item.obj) : isPoint(a.target) ? v3(a.target) : null;
        let position = isPoint(a.to) ? v3(a.to) : null;
        if (!target && !position) [target, position] = [home.target.clone(), home.position.clone()];
        target ??= controls.target.clone();
        if (!position) {
            const radius = item ? radiusOf(item.obj) : unit / 2;
            const direction = camera.position.clone().sub(controls.target).normalize();
            position = target.clone().addScaledVector(direction, fitDistance(Math.max(radius, unit * 0.15)) * num(a.value, 1));
        }
        const [p0, t0] = [camera.position.clone(), controls.target.clone()];
        controls.autoRotate = false;
        tween(duration, delay, (k) => {
            camera.position.lerpVectors(p0, position, smooth(k));
            controls.target.lerpVectors(t0, target, smooth(k));
        });
    }

    function explode(item, by, duration, delay) {
        const body = host(item);
        const parts = body.children;
        const centre = body.worldToLocal(centreOf(body));
        for (const part of parts) {
            part.userData.home ??= part.position.clone();
            part.userData.offset ??= body.worldToLocal(centreOf(part)).sub(centre).sub(part.position).add(part.userData.home);
            const to = part.userData.home.clone().add(part.userData.offset.clone().multiplyScalar(by - 1));
            const from = part.position.clone();
            tween(duration, delay, (k) => part.position.lerpVectors(from, to, smooth(k)));
        }
    }

    function act(a, instant) {
        const duration = instant ? 0 : Math.min(8, Math.max(0.05, num(a.duration, DURATION[a.do] ?? 0.9)));
        const delay = instant ? 0 : Math.min(10, Math.max(0, num(a.delay, 0)));
        if (a.do === "flow") return flow(a, delay);
        if (a.do === "camera") return aim(a, duration, delay);
        if (a.do === "hide" && flows.has(a.target)) return stopFlow(a.target, duration);
        const item = items.get(a.target);
        if (!item) return;
        const { obj } = item;
        const mats = materialsOf(obj);
        if (a.do === "show") show(item, duration, delay);
        else if (a.do === "hide") hide(item, duration, delay);
        else if (a.do === "move") {
            const from = obj.position.clone();
            const to = isPoint(a.to) ? v3(a.to) : from.clone().add(v3(a.by));
            tween(duration, delay, (k) => obj.position.lerpVectors(from, to, smooth(k)));
        } else if (a.do === "rotate") {
            const from = new THREE.Vector3(obj.rotation.x, obj.rotation.y, obj.rotation.z);
            const to = isPoint(a.to) ? v3(a.to).multiplyScalar(DEG) : from.clone().add(v3(a.by).multiplyScalar(DEG));
            tween(duration, delay, (k) => obj.rotation.setFromVector3(new THREE.Vector3().lerpVectors(from, to, smooth(k))));
        } else if (a.do === "scale") {
            const to = isPoint(a.to) ? v3(a.to) : new THREE.Vector3().setScalar(Math.max(0.0001, num(a.value, num(a.to, 1))));
            const from = obj.scale.clone();
            item.shownScale.copy(to);
            tween(duration, delay, (k) => obj.scale.lerpVectors(from, to, smooth(k)));
        } else if (a.do === "color") {
            const to = colorOf(a.color ?? a.to, 0);
            const from = mats.map((m) => m.color?.clone());
            tween(duration, delay, (k) => mats.forEach((m, i) => from[i] && (m.color.lerpColors(from[i], to, k), m.emissive?.copy(m.color))));
        } else if (a.do === "opacity") {
            const to = clamp01(num(a.value, num(a.to, 1)));
            const from = mats.map((m) => m.opacity);
            mats.forEach((m) => (m.userData.opacity = to));
            tween(duration, delay, (k) => mats.forEach((m, i) => ((m.opacity = from[i] + (to - from[i]) * smooth(k)), (m.depthWrite = m.opacity > 0.98))));
        } else if (a.do === "highlight") {
            const glow = mats.map((m) => m.emissiveIntensity ?? 0);
            const start = obj.scale.clone();
            tween(duration, delay, (k) => {
                const pulse = Math.sin(Math.PI * k);
                mats.forEach((m, i) => m.emissive && (m.emissiveIntensity = glow[i] + (1.1 - glow[i]) * pulse));
                obj.scale.copy(start).multiplyScalar(1 + 0.12 * pulse);
            });
        } else if (a.do === "spin") {
            const speed = num(a.value, num(a.speed, 0.25));
            item.spin = speed ? { axis: ["x", "y", "z"].includes(a.axis) ? a.axis : "y", speed } : null;
        } else if (a.do === "label") attachLabel(item, a.text);
        else if (a.do === "explode") explode(item, Math.max(0, num(a.value, 1.6)), duration, delay);
    }

    // The labelled items a step is about: each object it acts on, or the group holding it.
    const focusOf = (actions) => {
        const labelled = (item) => labels.some((l) => l.item === item);
        const found = new Set();
        for (const a of actions) {
            if (!a || a.do === "hide") continue;
            for (const id of [a.target, a.from, a.to].filter((v) => typeof v === "string")) {
                let item = items.get(id.split("#")[0]);
                for (let hops = 0; item && !labelled(item) && hops < 8; hops++) item = items.get(item.def.parent);
                if (item && labelled(item)) found.add(item);
            }
        }
        return found;
    };

    function step(index) {
        if (!Number.isInteger(index) || index <= played || index >= steps.length) return;
        for (let i = played + 1; i <= index; i++) for (const a of Array.isArray(steps[i]) ? steps[i] : []) act(a ?? {}, i < index);
        played = index;
        const found = focusOf(Array.isArray(steps[index]) ? steps[index] : []);
        if (found.size) focus = found;
    }

    function reset() {
        tweens.length = 0;
        for (const id of [...flows.keys()]) stopFlow(id, 0);
        for (const item of items.values()) {
            const { obj, home: h } = item;
            obj.position.copy(h.position);
            obj.rotation.copy(h.rotation);
            obj.scale.copy(h.scale);
            item.shownScale.copy(h.scale);
            item.spin = null;
            obj.visible = !item.def.hidden;
            materialsOf(obj).forEach((m, i) => {
                m.opacity = m.userData.opacity = m.userData.base;
                m.depthWrite = m.opacity > 0.98;
                if (item.colors[i]) m.color.copy(item.colors[i]);
                if (m.emissive) Object.assign(m, { emissiveIntensity: m.userData.glow }).emissive.copy(m.color);
            });
            obj.traverse((node) => node.userData.home && node.position.copy(node.userData.home));
            if (item.wire) Object.assign(item.wire, { drawn: item.def.hidden ? 0 : 1, key: "" }).caps.forEach((cap) => (cap.visible = true));
        }
        camera.position.copy(home.position);
        controls.target.copy(home.target);
        played = -1;
        focus = null;
    }

    // Standalone scenes play their steps on a timer; explanations drive the steps instead.
    if (spec.autoplay !== false && steps.length) {
        const every = Math.min(20, Math.max(1, num(spec.stepSeconds, 3.2)));
        let next = 0;
        const tick = () => {
            if (next >= steps.length) {
                if (spec.loop === false) return;
                reset();
                next = 0;
            }
            step(next++);
            timer = setTimeout(tick, every * 1000);
        };
        timer = setTimeout(tick, 700);
    }

    // The label under the pointer: its dot, its open pill, or any part of its object.
    const pick = () => {
        aimed = false;
        hovered = null;
        const owners = new Map(labels.map((l) => [l.item.obj, l.item]));
        const targets = labels.filter((l) => l.dot.visible).flatMap((l) => [l.dot, l.item.obj, ...(l.sprite.visible ? [l.sprite] : [])]);
        if (dragging || !targets.length) return;
        ray.setFromCamera(pointer, camera);
        let node = ray.intersectObjects(targets, true)[0]?.object;
        while (node && !node.userData.label && !owners.has(node)) node = node.parent;
        hovered = node?.userData.label ?? owners.get(node) ?? null;
    };

    // Opens the labels that matter and closes the rest to dots; clashing focus labels lift clear, and open ones stay in view.
    const declutter = (dt) => {
        camera.updateMatrixWorld();
        const [w, h] = size();
        const tan = Math.tan((camera.fov * DEG) / 2);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const fit = (y) => Math.min(Math.max(y, LABEL_PX / 2 + 4), h - inset - LABEL_PX / 2 - 4);
        const rank = (l) => (l.item === hovered ? 0 : focus?.has(l.item) ? 1 : 2);
        const shown = labels.filter((l) => l.dot.visible).sort((a, b) => rank(a) - rank(b));
        const placed = [];
        for (const l of shown) {
            const p = l.dot.position.clone().project(camera);
            const perPixel = (2 * camera.position.distanceTo(l.dot.position) * tan) / h;
            const width = LABEL_PX * (l.sprite.scale.x / l.sprite.scale.y);
            const [ax, ay] = [(p.x + 1) * (w / 2), (1 - p.y) * (h / 2) - LABEL_PX / 2 - DOT_PX];
            const x = Math.min(Math.max(ax, width / 2 + 4), w - width / 2 - 4);
            // An open label keeps its place on a near miss, and a closed one waits for clear room, so neither flickers.
            const pad = l.open > 0.5 ? -2 : 4;
            const clash = (y) => placed.find((q) => Math.abs(x - q.x) < (width + q.width) / 2 + pad && Math.abs(y - q.y) < LABEL_PX + pad);
            let y = fit(ay);
            let open = !dragging && (!focus || rank(l) < 2);
            if (open && rank(l) < 2) for (let q = clash(y), n = 0; q && n < 8; q = clash(y), n++) y = fit(q.y - LABEL_PX - 3);
            else if (open && clash(y)) open = false;
            if (open) placed.push({ x, y, width });
            const k = Math.min(1, dt * 10);
            l.open += ((open ? 1 : 0) - l.open) * Math.min(1, dt * 14);
            l.lift += (ay - y - l.lift) * k;
            l.shift += (x - ax - l.shift) * k;
            const tall = (2 * LABEL_PX * tan * (0.85 + 0.15 * l.open)) / h;
            l.sprite.scale.set(tall * (l.sprite.material.map.image.width / l.sprite.material.map.image.height), tall, 1);
            l.sprite.position
                .copy(l.dot.position)
                .addScaledVector(up, (LABEL_PX / 2 + DOT_PX + l.lift) * perPixel)
                .addScaledVector(right, l.shift * perPixel);
            l.sprite.material.opacity = l.fade * l.open;
            l.sprite.visible = l.open > 0.02;
        }
    };

    let raf = 0;
    let last = now;
    const labelBox = new THREE.Box3();
    const loop = () => {
        raf = requestAnimationFrame(loop);
        now = performance.now() / 1000;
        const dt = Math.min(0.1, now - last);
        last = now;
        for (const t of [...tweens]) {
            if (now < t.start) continue;
            const k = Math.min(1, (now - t.start) / t.duration);
            t.update(k);
            if (k >= 1) {
                tweens.splice(tweens.indexOf(t), 1);
                t.done?.();
            }
        }
        for (const item of items.values()) if (item.spin) item.obj.rotation[item.spin.axis] += item.spin.speed * Math.PI * 2 * dt;
        for (const wire of wires) layWire(wire);
        for (const [original, twin] of twins) follow(original, twin);
        for (const f of flows.values()) {
            const t = Math.max(0, now - f.start) * f.speed;
            f.dots.forEach((d, i) => {
                const u = (((t + i / f.dots.length) % 1) + 1) % 1;
                d.position.copy(f.at(u));
                d.scale.setScalar(0.45 + 0.55 * Math.sin(Math.PI * u));
            });
        }
        const dotTall = (2 * DOT_PX * Math.tan((camera.fov * DEG) / 2)) / size()[1];
        for (const l of labels) {
            const { obj } = l.item;
            l.dot.visible = isShown(obj);
            if (!l.dot.visible) {
                l.sprite.visible = false;
                continue;
            }
            // A label's dot rides on top of its object wherever it moves, swings or grows.
            labelBox.setFromObject(obj);
            if (labelBox.isEmpty()) obj.getWorldPosition(l.dot.position);
            else labelBox.getCenter(l.dot.position).setY(labelBox.max.y);
            l.dot.scale.set(dotTall, dotTall, 1);
            const m = materialsOf(obj)[0];
            l.fade = m ? Math.min(1, m.opacity / Math.max(0.05, m.userData.opacity)) : 1;
            l.dot.material.opacity = l.fade;
        }
        if (aimed) pick();
        declutter(dt);
        controls.update();
        renderer.render(scene, camera);
    };
    loop();
    const resize = new ResizeObserver(() => {
        const [w, h] = size();
        renderer.setSize(w, h);
        applyView();
    });
    resize.observe(root);
    return {
        step,
        dispose() {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
            resize.disconnect();
            controls.dispose();
            environment.dispose();
            pmrem.dispose();
            renderer.dispose();
        },
    };
}
