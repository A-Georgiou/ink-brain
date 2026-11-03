// 3D motion graphics: builds a declarative three.js scene and plays its steps in time with narration.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { isRegion } from "/shared/geometry.mjs";
import { gridCount } from "/shared/scene.mjs";
import { traceOutline } from "/shared/trace.mjs";
import { buildPart } from "./parts.js";
import { recentreRings } from "./repair.js";
import { arrowFor, baked, baseOf, clamp01, geometryFor, isFlat, isPoint, num, perPixel, ribbonGeometry, sideSpot, sizeOf, traced, v3 } from "./shapes.js";

const PALETTE = ["#a371f7", "#58a6ff", "#3fb950", "#f2cc60", "#ff7b72", "#79c0ff", "#d2a8ff", "#ffa657"];
const DURATION = { highlight: 1.4, camera: 1.3 };
const DEG = Math.PI / 180;
// Label callouts: pill height and font in CSS pixels, and how many open at once when no step picks them.
const [PILL_PX, LABEL_FONT, MAX_OPEN] = [22, "600 12.5px -apple-system, system-ui, sans-serif", 6];
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

// The outline of the thing in a picture (a data URL), traced at a couple of hundred pixels across.
async function outlineOf(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 220 / Math.max(image.width, image.height));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(8, Math.round(image.width * scale)), height: Math.max(8, Math.round(image.height * scale)) });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return traceOutline(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

async function loadTexture(url, id, renderer = null) {
    try {
        const texture = await new THREE.TextureLoader().loadAsync(url);
        texture.colorSpace = THREE.SRGBColorSpace;
        // Pictures seen at a slant, like a board lying flat, stay sharp.
        if (renderer) texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
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

const within = (obj, node) => {
    for (let n = node; n; n = n.parent) if (n === obj) return true;
    return false;
};

// spec: { view, camera, objects, steps, autoplay, stepSeconds, loop }; returns { step(index), dispose() }.
export async function renderScene(spec, { root, makeLabel, inPlace = false, resources = null }) {
    const size = () => [root.clientWidth || innerWidth, Math.max(1, root.clientHeight || innerHeight)];
    const [width, height] = size();
    const renderer = resources?.renderer ?? new THREE.WebGLRenderer({ antialias: true, alpha: true });
    if (!resources) {
        renderer.setPixelRatio(devicePixelRatio);
        renderer.setSize(width, height);
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    if (renderer.domElement.parentNode !== root) root.append(renderer.domElement);
    // A soft studio backdrop, so dark parts stand out; a scene laid over the screen stays see-through.
    root.style.background = inPlace ? "" : "radial-gradient(ellipse at 50% 40%, #3a4352 0%, #1d222b 58%, #0d1117 100%)";

    const scene = new THREE.Scene();
    const pmrem = resources?.pmrem ?? new THREE.PMREMGenerator(renderer);
    const environment = resources?.environment ?? pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    // Softer studio reflections keep colours true, so dark plastics, boards and metals do not wash out.
    scene.environmentIntensity = 0.6;
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 8, 6);
    const rim = new THREE.DirectionalLight(0x9ecbff, 0.8);
    rim.position.set(-6, 4, -6);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30363d, 0.8), key, rim);

    // Labels are callouts drawn on a 2D layer over the model, so they stay crisp and can point from beside it.
    const ink = document.createElement("canvas");
    ink.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;opacity:0";
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
    root.append(ink);
    const pen = ink.getContext("2d");

    const flat = spec.view === "flat" || inPlace;
    const camera = new THREE.PerspectiveCamera(flat ? 30 : 42, width / height, 0.01, 5000);
    // Narrated scenes keep their subtitles along the bottom, so the view is lifted above them; the overlay reports their real height.
    let inset = spec.autoplay === false ? 110 : 0;
    const applyView = () => {
        const [w, h] = size();
        camera.aspect = w / h;
        if (inset && h > inset * 2) camera.setViewOffset(w, h, 0, inset / 2, w, h);
        else camera.clearViewOffset();
        camera.updateProjectionMatrix();
        const ratio = devicePixelRatio || 1;
        [ink.width, ink.height] = [Math.round(w * ratio), Math.round(h * ratio)];
    };
    applyView();
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enableRotate = !flat;

    // Labels open for what the current step is about (focus; null means all), the part under the pointer, and close while dragging.
    const labels = [];
    let focus = null;
    let hovered = null;
    let dragging = false;
    let aimed = false;
    let near = false;
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
        aimed = near = true;
    });
    renderer.domElement.addEventListener("pointerleave", () => {
        aimed = near = false;
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
        else if (def.type === "base") obj = baseOf(def, material(), paint({ color: "#d4a84b", metalness: 1, roughness: 0.3 }), def.picture ? await loadTexture(def.picture, def.id, renderer).catch(() => null) : null);
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

    // Lays a wire as an arcing cable between its ends, or a rod as a straight link between their middles; runs every frame so it follows moving parts.
    function layWire(item) {
        const { def, obj, wire } = item;
        const middle = (end) => (isPoint(end) ? v3(end) : centreOf(host(items.get(end)) ?? new THREE.Object3D()));
        const a = wire.rod ? middle(def.from) : endOf(def.from, endOf(def.to));
        const b = wire.rod ? middle(def.to) : endOf(def.to, a);
        const key = [...a.toArray(), ...b.toArray()].map((v) => v.toFixed(3)).join();
        if (key === wire.key) return;
        wire.key = key;
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const lift = Math.min(unit, a.distanceTo(b) * 0.35) * num(def.sag, 1);
        const bend = flat && new THREE.Vector3(a.y - b.y, b.x - a.x, 0).normalize().multiplyScalar(lift * 0.6);
        const [outA, outB] = flat ? [bend, bend] : [leaving(def.from).multiplyScalar(lift), leaving(def.to).multiplyScalar(lift)];
        wire.curve = wire.rod ? new THREE.LineCurve3(a.clone().sub(mid), b.clone().sub(mid)) : new THREE.CubicBezierCurve3(a.clone().sub(mid), a.clone().add(outA).sub(mid), b.clone().add(outB).sub(mid), b.clone().sub(mid));
        obj.geometry.dispose();
        const radius = num(def.radius, unit * (wire.rod ? 0.025 : 0.012));
        if (wire.ribbon) {
            const across = new THREE.Vector3().crossVectors(b.clone().sub(a), new THREE.Vector3(0, flat ? 0 : 1, flat ? 1 : 0));
            obj.geometry = ribbonGeometry(wire.curve, wire.ribbon, across.lengthSq() > 1e-9 ? across.normalize() : new THREE.Vector3(1, 0, 0));
        } else obj.geometry = new THREE.TubeGeometry(wire.curve, wire.rod ? 1 : 64, radius, wire.rod ? 16 : 8, false);
        obj.geometry.setDrawRange(0, Math.ceil(obj.geometry.index.count * wire.drawn));
        obj.position.copy(mid);
        if (wire.rod) {
            // A rod's ends are ball joints on the parts it links.
            wire.caps.forEach((cap, i) => {
                cap.position.copy(i ? b : a).sub(mid);
                cap.scale.setScalar(radius * 1.6);
            });
            return;
        }
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
        const rod = def.style === "rod";
        const ribbon = def.style === "ribbon" ? Math.max(0.001, num(def.width, unit * 0.08)) : 0;
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: rod ? 0.75 : 0.05, emissive: color.clone(), emissiveIntensity: def.glow ? 0.55 : 0, transparent: true, opacity, side: ribbon ? THREE.DoubleSide : THREE.FrontSide });
        const obj = new THREE.Mesh(new THREE.BufferGeometry(), material);
        const r = num(def.radius, unit * 0.012);
        const caps = flat || ribbon ? [] : [0, 1].map(() => new THREE.Mesh(rod ? new THREE.SphereGeometry(1, 16, 12) : new THREE.BoxGeometry(1, 1, 1), rod ? material : new THREE.MeshStandardMaterial({ color: "#21262d", roughness: 0.5, transparent: true })));
        for (const cap of caps) {
            if (!rod) cap.scale.set(r * 4.5, r * 9, r * 4.5);
            obj.add(cap);
        }
        const item = { ...record(def, obj), wire: { caps, ribbon, rod, key: "", drawn: def.hidden ? 0 : 1, curve: null } };
        scene.add(obj);
        layWire(item);
        item.home.position.copy(obj.position);
        return item;
    }

    function attachLabel(item, text) {
        const old = labels.findIndex((l) => l.item === item);
        if (old >= 0) labels.splice(old, 1);
        if (!String(text ?? "").trim()) return;
        const words = String(text).slice(0, 60);
        pen.font = LABEL_FONT;
        labels.push({ item, text: words, width: Math.ceil(pen.measureText(words).width) + 18, open: 0, fade: 1, local: null, hidden: false, box: null });
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

    // A loft or base given its picture but no outline takes its true outline from the picture; a loft that cannot be traced keeps the picture's box.
    for (const [index, def] of defs.entries()) {
        if (!["loft", "base"].includes(def.type) || !isRegion(def.region) || (Array.isArray(def.outline) && def.outline.length >= 3)) continue;
        const r = def.region;
        const found = def.picture ? await outlineOf(def.picture).catch(() => null) : null;
        const outline = found?.map(([u, v]) => [r.x + u * r.w, r.y + v * r.h]) ?? (def.type === "loft" ? [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]] : null);
        if (outline) defs[index] = { ...def, outline };
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
    recentreRings(items);
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

    // Mechanisms turn one input (theta, in turns) into linked motion solved every frame, so joined parts never come apart.
    const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    const mechanisms = new Map();
    const placeAt = (obj, world) => obj.position.copy(obj.parent ? obj.parent.worldToLocal(world.clone()) : world);
    for (const def of Array.isArray(spec.mechanisms) ? spec.mechanisms : []) {
        const m = { def, theta: 0, speed: 0 };
        if (def.type === "crank") {
            const [crank, pin, slider] = [def.crank, def.pin, def.slider].map((id) => items.get(id));
            if (!crank || !pin || !slider) continue;
            const turn = AXIS[def.turn] ? def.turn : "z";
            const p0 = centreOf(pin.obj);
            const a0 = centreOf(slider.obj);
            const rod = items.get(def.rod) ?? null;
            Object.assign(m, { crank, pin, slider, rod, turn, p0, a0, t: 0, base: crank.obj.rotation[turn], u: AXIS[def.axis] ?? AXIS.y, length: p0.distanceTo(a0) });
            Object.assign(m, { pivot: crank.obj.getWorldPosition(new THREE.Vector3()), spin: AXIS[turn].clone().transformDirection(crank.obj.matrixWorld), s0: slider.obj.getWorldPosition(new THREE.Vector3()), riding: within(crank.obj, pin.obj) });
            if (!m.riding) m.pinStart = pin.obj.getWorldPosition(new THREE.Vector3());
            if (rod) Object.assign(m, { rodDir: a0.clone().sub(p0).normalize(), rodTurn: rod.obj.getWorldQuaternion(new THREE.Quaternion()), rodFrom: rod.obj.getWorldPosition(new THREE.Vector3()).sub(p0.clone().add(a0).multiplyScalar(0.5)) });
            else {
                m.drawn = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), new THREE.MeshStandardMaterial({ color: "#aab4c0", metalness: 0.8, roughness: 0.35 }));
                m.drawn.scale.set(Math.max(0.005, m.length * 0.06), 1, Math.max(0.005, m.length * 0.06));
                scene.add(m.drawn);
            }
        } else {
            const parts = (Array.isArray(def.parts) ? def.parts : []).map((p) => ({ ...p, item: items.get(p.id) })).filter((p) => p.item);
            m.ratio = num(def.ratio, 1);
            m.parts = parts.map((p) => {
                const { obj } = p.item;
                const axis = AXIS[p.axis] ? p.axis : "z";
                return { ...p, axis, base: obj.rotation[axis], home: { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() }, mats: materialsOf(obj) };
            });
        }
        mechanisms.set(def.id, m);
    }
    // A smooth rise and fall over a window of the cycle, wrapping past its end.
    const bump = (c, from, to) => {
        const start = clamp01(num(from, 0));
        const span = (clamp01(num(to, 1)) - start + 1) % 1 || 1;
        const x = (c - start + 1) % 1;
        return x > span ? 0 : Math.sin((Math.PI * x) / span) ** 2;
    };
    function runMechanism(m) {
        const angle = m.theta * Math.PI * 2;
        if (m.def.type === "crank") {
            m.crank.obj.rotation[m.turn] = m.base + angle;
            m.crank.obj.updateMatrixWorld(true);
            if (!m.riding) placeAt(m.pin.obj, m.pinStart.clone().sub(m.pivot).applyAxisAngle(m.spin, angle).add(m.pivot));
            m.pin.obj.updateMatrixWorld(true);
            const p = centreOf(m.pin.obj);
            // The slider sits on its track where the rod's length reaches from the crank pin, on the side it started.
            const d = p.clone().sub(m.a0);
            const along = d.dot(m.u);
            const reach = Math.sqrt(Math.max(0, m.length ** 2 - Math.max(0, d.lengthSq() - along ** 2)));
            m.t = [along + reach, along - reach].reduce((best, t) => (Math.abs(t - m.t) < Math.abs(best - m.t) ? t : best));
            placeAt(m.slider.obj, m.s0.clone().addScaledVector(m.u, m.t));
            const a = m.a0.clone().addScaledVector(m.u, m.t);
            const mid = p.clone().add(a).multiplyScalar(0.5);
            const link = a.clone().sub(p);
            if (m.rod) {
                const q = new THREE.Quaternion().setFromUnitVectors(m.rodDir, link.clone().normalize());
                const { obj } = m.rod;
                placeAt(obj, mid.clone().add(m.rodFrom.clone().applyQuaternion(q)));
                const parentTurn = obj.parent ? obj.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
                obj.quaternion.copy(parentTurn.invert().multiply(q.multiply(m.rodTurn)));
            } else if (m.drawn) {
                m.drawn.position.copy(mid);
                m.drawn.quaternion.setFromUnitVectors(AXIS.y, link.clone().normalize());
                m.drawn.scale.y = Math.max(0.001, link.length());
            }
        } else if (m.def.type === "gears") {
            for (const p of m.parts) p.item.obj.rotation[p.axis] = p.base + angle * num(p.ratio, 1);
        } else {
            const c = (((m.theta * m.ratio) % 1) + 1) % 1;
            for (const p of m.parts) {
                const k = bump(c, p.from, p.to);
                const { obj } = p.item;
                if (isPoint(p.by)) obj.position.copy(p.home.position).addScaledVector(v3(p.by), k);
                if (isPoint(p.rotate)) obj.rotation.set(...["x", "y", "z"].map((axis, i) => p.home.rotation[axis] + p.rotate[i] * DEG * k));
                if (Number.isFinite(p.scale)) obj.scale.copy(p.home.scale).multiplyScalar(1 + (p.scale - 1) * k);
                if (p.glow) for (const mat of p.mats) if (mat.emissive) mat.emissiveIntensity = mat.userData.glow + k * 1.2;
            }
        }
    }
    // The parts a mechanism moves, so steps that drive it can frame and label them.
    const partsOf = (m) => (!m ? [] : m.def.type === "crank" ? [m.def.crank, m.def.pin, m.def.slider, m.def.rod].filter(Boolean) : m.parts.map((p) => p.id));
    const actedIds = (a) => (a?.do === "drive" ? partsOf(mechanisms.get(a.target)) : [a?.target, a?.from, a?.to].filter((id) => typeof id === "string"));

    const all = new THREE.Box3();
    for (const item of items.values()) all.expandByObject(item.obj);
    for (const [, twin] of twins) all.expandByObject(twin);
    // Per-mesh boxes, as a sparse model (a long shaft, angled parts) fills far less than its overall box; shown keeps only visible parts.
    const partBoxes = (shown = false) => {
        const boxes = [];
        scene.traverse((node) => node.isMesh && (!shown || isShown(node)) && boxes.push(new THREE.Box3().setFromObject(node)));
        return boxes.filter((box) => !box.isEmpty());
    };
    const corners = (b) => [b.min.x, b.max.x].flatMap((x) => [b.min.y, b.max.y].flatMap((y) => [b.min.z, b.max.z].map((z) => new THREE.Vector3(x, y, z))));
    const union = (boxes) => boxes.reduce((box, part) => box.union(part), new THREE.Box3());
    // A close-up grows out to the whole of any part it would otherwise cut through, by no more than half again.
    const settle = (view, parts) => {
        const room = view.getSize(new THREE.Vector3()).length() * 1.45;
        for (let pass = 0; pass < 2; pass++) {
            const grown = view.clone();
            for (const box of parts) {
                if (!box.intersectsBox(view) || view.containsBox(box)) continue;
                if (view.clone().union(box).getSize(new THREE.Vector3()).length() <= room) grown.union(box);
            }
            if (grown.equals(view)) break;
            view = grown;
        }
        return view;
    };
    // The parts that set the frame: small fragments far from the rest do not shrink the model.
    const robust = (boxes) => {
        if (boxes.length < 5) return boxes;
        const centres = boxes.map((b) => b.getCenter(new THREE.Vector3()));
        const sizes = boxes.map((b) => b.getSize(new THREE.Vector3()).length());
        const total = sizes.reduce((a, b) => a + b, 0) || 1;
        const middle = centres.reduce((sum, c, i) => sum.addScaledVector(c, sizes[i] / total), new THREE.Vector3());
        const spread = Math.sqrt(centres.reduce((sum, c, i) => sum + c.distanceToSquared(middle) * (sizes[i] / total), 0));
        const biggest = Math.max(...sizes);
        return boxes.filter((b, i) => sizes[i] > biggest * 0.2 || centres[i].distanceTo(middle) < spread * 2.2 + sizes[i]);
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
        // A frame that has not been laid out yet has no width; assume a typical panel rather than divide by zero.
        const aspect = camera.aspect > 0.1 ? camera.aspect : 4 / 3;
        let distance = 0;
        for (const part of parts) {
            for (const corner of corners(part)) {
                const p = corner.sub(target);
                const depth = p.dot(back);
                distance = Math.max(distance, depth + (Math.abs(p.dot(right)) * margin) / (tan * aspect), depth + (Math.abs(p.dot(up)) * margin) / tall);
            }
        }
        if (!Number.isFinite(distance) || distance <= 0) distance = fitDistance(sphere.radius);
        return { target, position: target.clone().addScaledVector(back, distance) };
    };
    // The model's camera picks the side to look from; the opening view frames what is visible from there.
    const named = typeof spec.camera?.target === "string" && items.has(spec.camera.target) ? centreOf(items.get(spec.camera.target).obj) : null;
    const looksAt = named ?? (isPoint(spec.camera?.target) ? v3(spec.camera.target) : all.getCenter(new THREE.Vector3()));
    const asked = isPoint(spec.camera?.position) ? v3(spec.camera.position).sub(looksAt) : null;
    const side = asked?.lengthSq() > 1e-9 ? asked : flat ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0.55, 0.42, 0.85);
    for (const item of items.values()) if (item.def.hidden) item.obj.visible = false;
    const opening = robust(partBoxes(true));
    const margin = inPlace ? 1 : 1.12;
    const home = all.isEmpty() ? { target: new THREE.Vector3(), position: new THREE.Vector3(0, 0, 8) } : opening.length ? frame(union(opening), side, margin, opening) : frame(all, side, margin, robust(partBoxes()));
    // What the camera last framed, so a change in the subtitle height can frame it again.
    let framed = opening.length ? opening : null;
    const distance = home.position.distanceTo(home.target);
    camera.near = Math.max(0.01, distance / 300);
    camera.far = distance * 300;
    camera.updateProjectionMatrix();
    camera.position.copy(home.position);
    controls.target.copy(home.target);
    controls.autoRotate = !flat && !steps.length && spec.autoplay !== false;
    controls.autoRotateSpeed = 0.8;

    for (const item of items.values()) if (item.def.label) attachLabel(item, item.def.label);

    // Eases the camera to frame boxes from where it looks now, unless that barely changes the view.
    const frameTo = (boxes, duration = 1.1) => {
        if (!boxes.length) return;
        framed = boxes;
        const to = frame(union(boxes), camera.position.clone().sub(controls.target), margin, boxes);
        if (to.position.distanceTo(camera.position) < unit * 0.04 && to.target.distanceTo(controls.target) < unit * 0.04) return;
        const [p0, t0] = [camera.position.clone(), controls.target.clone()];
        controls.autoRotate = false;
        tween(duration, 0, (k) => {
            camera.position.lerpVectors(p0, to.position, smooth(k));
            controls.target.lerpVectors(t0, to.target, smooth(k));
        });
    };

    // When a step acts on a part that is out of view or under the subtitles, the camera eases back out to fit everything shown.
    let refit = 0;
    let refitPending = false;
    const keepInView = (actions) => {
        const floor = -1 + (2 * inset) / size()[1];
        const outside = (p) => {
            const v = p.project(camera);
            return Math.abs(v.x) > 1 || v.y > 1 || v.y < floor;
        };
        const acted = actions.flatMap(actedIds).map((id) => items.get(id.split("#")[0])?.obj);
        const lost = (obj) => {
            let out = false;
            obj?.traverse((node) => (out ||= node.isMesh && isShown(node) && corners(new THREE.Box3().setFromObject(node)).some(outside)));
            return out;
        };
        if (acted.some(lost)) frameTo(robust(partBoxes(true)));
    };

    // Where a step's parts will be once its moves, turns and growth finish, so the camera frames the whole motion.
    const reach = (item, actions) => {
        const { obj } = item;
        const saved = [obj.position.clone(), obj.rotation.clone(), obj.scale.clone()];
        const box = new THREE.Box3();
        const add = () => {
            obj.updateMatrixWorld(true);
            box.union(new THREE.Box3().setFromObject(obj));
        };
        if (obj.scale.lengthSq() < 1e-6) obj.scale.copy(item.shownScale);
        add();
        for (const a of actions) {
            if (a?.target !== item.def.id) continue;
            if (a.do === "move") obj.position.copy(isPoint(a.to) ? v3(a.to) : obj.position.clone().add(v3(a.by)));
            else if (a.do === "rotate") obj.rotation.setFromVector3(isPoint(a.to) ? v3(a.to).multiplyScalar(DEG) : new THREE.Vector3(obj.rotation.x, obj.rotation.y, obj.rotation.z).add(v3(a.by).multiplyScalar(DEG)));
            else if (a.do === "scale") obj.scale.copy(isPoint(a.to) ? v3(a.to) : new THREE.Vector3().setScalar(Math.max(0.0001, num(a.value, num(a.to, 1)))));
            else if (a.do === "spin") {
                const axis = ["x", "y", "z"].includes(a.axis) ? a.axis : "y";
                for (let q = 0; q < 4; q++, obj.rotation[axis] += Math.PI / 2) add();
            } else if (a.do === "explode") box.expandByScalar(box.getSize(new THREE.Vector3()).length() * 0.3 * Math.max(0, num(a.value, 1.6) - 1));
            add();
        }
        [obj.position, obj.rotation, obj.scale].forEach((v, i) => v.copy(saved[i]));
        obj.updateMatrixWorld(true);
        return box;
    };

    // From the second step on, the camera moves in on the parts a step is about, keeping some of the model around them.
    const focusStep = (index, actions) => {
        if (index < 1 || flat || actions.some((a) => a?.do === "camera")) return;
        const ids = new Set(actions.filter((a) => a && a.do !== "hide").flatMap((a) => [...actedIds(a), a.along]).filter((id) => typeof id === "string"));
        const boxes = [...ids].map((id) => items.get(id) ?? items.get(id.split("#")[0])).filter(Boolean).map((item) => reach(item, actions)).filter((b) => !b.isEmpty());
        for (const a of actions) for (const p of [a?.from, a?.to, ...(Array.isArray(a?.via) ? a.via : [])]) if (a?.do === "flow" && isPoint(p)) boxes.push(new THREE.Box3().setFromCenterAndSize(v3(p), new THREE.Vector3()));
        const shown = robust(partBoxes(true));
        const model = union(shown);
        if (!boxes.length || model.isEmpty()) return;
        const part = union(boxes);
        // Driven mechanisms sweep further than their parts are now.
        if (actions.some((x) => x?.do === "drive")) part.expandByVector(part.getSize(new THREE.Vector3()).multiplyScalar(0.25));
        const [size, whole] = [part.getSize(new THREE.Vector3()), model.getSize(new THREE.Vector3())];
        if (size.length() > whole.length() * 0.7) return frameTo(shown);
        const keep = new THREE.Vector3(Math.max(size.x, whole.x * 0.4), Math.max(size.y, whole.y * 0.4), Math.max(size.z, whole.z * 0.4));
        frameTo([settle(new THREE.Box3().setFromCenterAndSize(part.getCenter(new THREE.Vector3()), keep), shown)]);
    };

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
            // Zooming keeps some of the model around the part in view.
            position = target.clone().addScaledVector(direction, fitDistance(Math.max(radius, unit * 0.3)) * num(a.value, 1));
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
        if (a.do === "drive") {
            const m = mechanisms.get(a.target);
            if (!m) return;
            const run = (m.run = (m.run ?? 0) + 1);
            m.speed = Number.isFinite(a.turns) ? 0 : num(a.value, 0.5);
            if (!Number.isFinite(a.turns)) return;
            const [from, to] = [m.theta, m.theta + a.turns];
            const time = instant ? 0 : Math.min(12, Math.max(0.3, num(a.duration, Math.max(1.5, Math.abs(a.turns) * 3))));
            return tween(time, delay, (k) => run === m.run && (m.theta = from + (to - from) * k));
        }
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
            for (const id of actedIds(a)) {
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
        const actions = Array.isArray(steps[index]) ? steps[index] : [];
        const found = focusOf(actions);
        if (found.size) focus = found;
        clearTimeout(refit);
        refitPending = false;
        focusStep(index, actions);
        if (!actions.some((a) => a?.do === "camera")) {
            refitPending = true;
            refit = setTimeout(() => {
                refitPending = false;
                keepInView(actions);
            }, 1400);
        }
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
        framed = opening.length ? opening : null;
        for (const m of mechanisms.values()) Object.assign(m, { theta: 0, speed: 0, t: 0, run: (m.run ?? 0) + 1 });
        clearTimeout(refit);
        refitPending = false;
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

    // The label under the pointer: its pill or dot, else any part of a labelled object.
    const pick = () => {
        aimed = false;
        hovered = null;
        if (dragging || !labels.length) return;
        const r = renderer.domElement.getBoundingClientRect();
        const [px, py] = [((pointer.x + 1) / 2) * r.width, ((1 - pointer.y) / 2) * r.height];
        const hit = labels.find((l) => l.pill && l.open > 0.5 && px >= l.pill.left && px <= l.pill.left + l.width && py >= l.pill.top && py <= l.pill.top + PILL_PX) ?? labels.find((l) => l.screen && Math.hypot(px - l.screen.x, py - l.screen.y) < 9);
        if (hit) return void (hovered = hit.item);
        const owners = new Map(labels.map((l) => [l.item.obj, l.item]));
        ray.setFromCamera(pointer, camera);
        ray.far = Infinity;
        let node = ray.intersectObjects([...owners.keys()], true)[0]?.object;
        while (node && !owners.has(node)) node = node.parent;
        hovered = owners.get(node) ?? null;
    };

    // Opaque parts that can hide a label's spot; see-through shells and glowing flows never do.
    const solids = () => {
        const list = [];
        scene.traverse((node) => {
            const m = node.isMesh && isShown(node) && [node.material].flat()[0];
            if (m && m.opacity >= 0.6 && m.blending !== THREE.AdditiveBlending) list.push(node);
        });
        return list;
    };

    // A spot on the labelled part the camera really sees: rays cast across its outline on screen that land on the part itself, taking the most central.
    // It is kept in the part's own frame, so the dot rides along as the part moves.
    const anchorOf = (l, blockers, grid) => {
        const { obj } = l.item;
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) return null;
        l.bulk = box.getSize(new THREE.Vector3()).length();
        const own = [];
        obj.traverse((node) => node.isMesh && isShown(node) && own.push(node));
        const seen = corners(box).map((c) => c.project(camera));
        const [x0, x1] = [Math.max(-1, Math.min(...seen.map((p) => p.x))), Math.min(1, Math.max(...seen.map((p) => p.x)))];
        const [y0, y1] = [Math.max(-1, Math.min(...seen.map((p) => p.y))), Math.min(1, Math.max(...seen.map((p) => p.y)))];
        const hits = [];
        ray.far = Infinity;
        for (let i = 0; x1 > x0 && y1 > y0 && i < grid; i++) {
            for (let j = 0; j < grid; j++) {
                const at = new THREE.Vector2(x0 + ((i + 0.5) / grid) * (x1 - x0), y0 + ((j + 0.5) / grid) * (y1 - y0));
                ray.setFromCamera(at, camera);
                const hit = ray.intersectObjects([...blockers, ...own], false)[0];
                if (hit && within(obj, hit.object)) hits.push({ point: hit.point, at });
            }
        }
        l.hidden = !hits.length;
        if (!hits.length) return obj.worldToLocal(box.getCenter(new THREE.Vector3()));
        const middle = hits.reduce((sum, h) => sum.add(h.at), new THREE.Vector2()).divideScalar(hits.length);
        return obj.worldToLocal(hits.reduce((best, h) => (h.at.distanceTo(middle) < best.at.distanceTo(middle) ? h : best)).point.clone());
    };

    // How far from a point inside the rect, along a direction, until it leaves it.
    const edgeDistance = (a, dx, dy, r) => {
        if (a.x < r.x0 || a.x > r.x1 || a.y < r.y0 || a.y > r.y1) return 0;
        const tx = dx > 0 ? (r.x1 - a.x) / dx : dx < 0 ? (r.x0 - a.x) / dx : Infinity;
        const ty = dy > 0 ? (r.y1 - a.y) / dy : dy < 0 ? (r.y0 - a.y) / dy : Infinity;
        return Math.min(tx, ty);
    };

    // Dots mark labelled parts; the open ones are callouts pushed out from the model's middle past its edge, joined by a leader line, never stacked over the part.
    let refreshAt = 0;
    let model = null;
    const drawLabels = (dt) => {
        const [w, h] = size();
        const toScreen = (v) => {
            const p = v.clone().project(camera);
            return { x: (p.x + 1) * (w / 2), y: (1 - p.y) * (h / 2), z: p.z };
        };
        camera.updateMatrixWorld();
        if (now >= refreshAt) {
            refreshAt = now + 0.15;
            const blockers = solids();
            for (const l of labels) if (isShown(l.item.obj)) l.local = anchorOf(l, blockers, focus?.has(l.item) || l.item === hovered ? 7 : 4) ?? l.local;
            const box = union(robust(partBoxes(true)));
            model = box.isEmpty() ? null : corners(box).map(toScreen).reduce((r, p) => ({ x0: Math.min(r.x0, p.x), y0: Math.min(r.y0, p.y), x1: Math.max(r.x1, p.x), y1: Math.max(r.y1, p.y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
        }
        const ratio = devicePixelRatio || 1;
        pen.setTransform(ratio, 0, 0, ratio, 0, 0);
        pen.clearRect(0, 0, w, h);
        const rank = (l) => (l.item === hovered ? 0 : focus?.has(l.item) ? 1 : 2);
        const shown = labels.filter((l) => l.local && isShown(l.item.obj)).sort((a, b) => rank(a) - rank(b));
        // Without a step to pick them, the biggest parts' labels open, a handful at most.
        const open = new Set(dragging ? [] : shown.filter((l) => rank(l) < 2));
        if (!focus && !dragging) for (const l of [...shown].sort((a, b) => (b.bulk ?? 0) - (a.bulk ?? 0)).slice(0, MAX_OPEN)) open.add(l);
        const [cx, cy] = model ? [(model.x0 + model.x1) / 2, (model.y0 + model.y1) / 2] : [w / 2, h / 2];
        const bottom = h - inset - 6;
        const placed = [];
        const drawn = [];
        for (const l of shown) {
            const m = materialsOf(l.item.obj)[0];
            l.fade = m ? Math.min(1, m.opacity / Math.max(0.05, m.userData.opacity)) : 1;
            l.open += ((open.has(l) ? 1 : 0) - l.open) * Math.min(1, dt * 12);
            const a = toScreen(l.local.clone().applyMatrix4(l.item.obj.matrixWorld));
            l.screen = a.z < 1 && a.x > -20 && a.x < w + 20 && a.y > -20 && a.y < bottom + 20 ? a : null;
            if (!l.screen) continue;
            drawn.push(l);
            if (l.open < 0.02) {
                l.pill = null;
                continue;
            }
            // Callouts lean sideways, where there is usually room beside the model, rather than over or under it.
            let [dx, dy] = [(a.x - cx) * 2.5 || (a.x < w / 2 ? -1 : 1), a.y - cy];
            const len = Math.hypot(dx, dy);
            [dx, dy] = [dx / len, dy / len];
            const out = Math.min(170, Math.max(26, (model ? edgeDistance(a, dx, dy, model) : 0) + 18));
            const clampX = (x) => Math.min(Math.max(x, 6), w - l.width - 6);
            const clampY = (y) => Math.min(Math.max(y, 6), bottom - PILL_PX);
            const left = clampX(dx >= 0 ? a.x + dx * out : a.x + dx * out - l.width);
            let top = clampY(a.y + dy * out - PILL_PX / 2);
            const clash = () => placed.find((q) => left < q.left + q.width + 6 && left + l.width + 6 > q.left && top < q.top + PILL_PX + 4 && top + PILL_PX + 4 > q.top);
            for (let n = 0, q = clash(); q && n < 10; q = clash(), n++) top = clampY(a.y >= q.ay ? q.top + PILL_PX + 4 : q.top - PILL_PX - 4);
            placed.push({ left, top, width: l.width, ay: a.y });
            l.pill ??= { left, top };
            const k = Math.min(1, dt * 10);
            l.pill.left += (left - l.pill.left) * k;
            l.pill.top += (top - l.pill.top) * k;
        }
        pen.font = LABEL_FONT;
        pen.textBaseline = "middle";
        // Leaders, then dots, then pills, so no dot covers a label; resting dots only show while the pointer is over the model.
        const pills = drawn.filter((d) => d.pill);
        for (const l of pills) {
            const [a, p] = [l.screen, l.pill];
            pen.globalAlpha = l.fade * l.open;
            pen.beginPath();
            pen.moveTo(a.x, a.y);
            pen.lineTo(Math.min(Math.max(a.x, p.left), p.left + l.width), Math.min(Math.max(a.y, p.top), p.top + PILL_PX));
            pen.lineWidth = 1.5;
            pen.strokeStyle = "rgba(230, 237, 243, 0.8)";
            pen.stroke();
        }
        for (const l of drawn) {
            if (!l.pill && !near) continue;
            pen.globalAlpha = l.fade * (l.hidden ? 0.55 : 1) * (l.pill && !near ? l.open : 1);
            pen.beginPath();
            pen.arc(l.screen.x, l.screen.y, 4, 0, Math.PI * 2);
            pen.lineWidth = 2.5;
            pen.strokeStyle = "rgba(13, 17, 23, 0.85)";
            pen.stroke();
            pen.fillStyle = rank(l) < 2 ? "#d2a8ff" : "#e6edf3";
            pen.fill();
        }
        for (const l of pills) {
            const p = l.pill;
            pen.globalAlpha = l.fade * l.open;
            pen.beginPath();
            pen.roundRect(p.left, p.top, l.width, PILL_PX, PILL_PX / 2);
            pen.fillStyle = "rgba(13, 17, 23, 0.88)";
            pen.fill();
            pen.lineWidth = 1;
            pen.strokeStyle = rank(l) < 2 ? "rgba(163, 113, 247, 0.95)" : "rgba(240, 246, 252, 0.22)";
            pen.stroke();
            pen.fillStyle = "#e6edf3";
            pen.fillText(l.text, p.left + 9, p.top + PILL_PX / 2 + 0.5);
        }
        pen.globalAlpha = 1;
    };

    let raf = 0;
    let last = now;
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
        for (const m of mechanisms.values()) {
            if (m.speed) m.theta += m.speed * dt;
            runMechanism(m);
        }
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
        if (aimed) pick();
        controls.update();
        renderer.render(scene, camera);
        drawLabels(dt);
    };
    ink.style.opacity = "1";
    loop();
    const resize = new ResizeObserver(() => {
        const [w, h] = size();
        renderer.setSize(w, h);
        applyView();
    });
    resize.observe(root);
    return {
        resources: { renderer, pmrem, environment },
        status: () => ({ index: played, settled: !tweens.length && !refitPending }),
        step,
        goto(index) {
            reset();
            if (Number.isInteger(index) && index >= 0) step(index);
        },
        addSteps: (more) => steps.push(...more),
        // The subtitles' real height, so the model is framed above them and never under them.
        setInset(px) {
            const next = Math.max(0, Math.min(Math.round(num(px, inset)), size()[1] * 0.45));
            if (Math.abs(next - inset) < 4) return;
            inset = next;
            applyView();
            if (framed) frameTo(framed, 0.5);
        },
        dispose(preserveRenderer = false) {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
            clearTimeout(refit);
            resize.disconnect();
            controls.dispose();
            ink.remove();
            const assets = new Set();
            scene.traverse((node) => {
                if (node.geometry) assets.add(node.geometry);
                for (const material of [node.material].flat().filter(Boolean)) {
                    assets.add(material);
                    for (const value of Object.values(material)) if (value?.isTexture) assets.add(value);
                }
            });
            for (const asset of assets) asset.dispose();
            if (!preserveRenderer) {
                environment.dispose();
                pmrem.dispose();
                renderer.dispose();
            }
        },
    };
}
