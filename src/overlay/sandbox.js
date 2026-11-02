// Runs one panel's content inside a sandboxed, network-less frame and reports back to the overlay.
const root = document.getElementById("root");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let dispose = null;
let stage = null;
let pendingStep = -1;

const report = (message) => parent.postMessage(message, "*");
const describe = (error) => String(error?.message ?? error).slice(0, 2000);

addEventListener("error", (event) => report({ type: "error", message: describe(event.error ?? event.message) }));
addEventListener("unhandledrejection", (event) => report({ type: "error", message: describe(event.reason) }));

addEventListener("message", async (event) => {
    if (event.source !== parent || !event.data || typeof event.data !== "object") return;
    // Narration advances a scene; steps that arrive while it builds play once it is ready.
    if (event.data.type === "step") {
        const index = Number(event.data.index);
        if (stage) stage.step(index);
        else pendingStep = Math.max(pendingStep, index);
        return;
    }
    const { kind, content, image } = event.data;
    const inPlace = event.data.inPlace === true;
    const imageUrl = typeof image === "string" && image.startsWith("data:image/") ? image : null;
    try {
        dispose?.();
        dispose = null;
        stage = null;
        pendingStep = -1;
        root.replaceChildren();
        root.className = "";
        if (kind === "mermaid") await renderMermaid(String(content));
        else if (kind === "three") dispose = await renderThree(String(content), imageUrl, inPlace);
        else if (kind === "scene" || kind === "board") {
            const spec = JSON.parse(String(content));
            stage =
                kind === "scene"
                    ? await (await import("./scene.js")).renderScene(spec, { root, makeLabel, inPlace })
                    : await (await import("./board.js")).renderBoard(spec, { root });
            dispose = stage.dispose;
            if (pendingStep >= 0) stage.step(pendingStep);
        } else if (kind === "html") return renderHtml(String(content), imageUrl);
        else throw new Error(`Unsupported panel kind: ${kind}`);
        report({ type: "rendered" });
    } catch (error) {
        report({ type: "error", message: describe(error) });
    }
});

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.append(script);
    });
}

async function renderMermaid(source) {
    if (!globalThis.mermaid) await loadScript("app://live/vendor/mermaid/mermaid.min.js");
    const mermaid = globalThis.mermaid.default ?? globalThis.mermaid;
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        themeVariables: {
            darkMode: true,
            background: "transparent",
            primaryColor: "#2d2250",
            primaryBorderColor: "#a371f7",
            primaryTextColor: "#e6edf3",
            secondaryColor: "#1b3350",
            tertiaryColor: "#161b22",
            lineColor: "#8b949e",
        },
    });
    const cleaned = source.replace(/^\s*```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "").trim();
    await mermaid.parse(cleaned);
    const { svg } = await mermaid.render(`diagram-${Date.now()}`, cleaned);
    root.className = "diagram";
    root.innerHTML = svg;
    const box = root.querySelector("svg")?.viewBox?.baseVal;
    if (box?.width) report({ type: "size", width: box.width, height: box.height });
}

function makeLabel(THREE, text, position, { color = "#e6edf3", background = "rgba(13, 17, 23, 0.78)", size = 0.32 } = {}) {
    const font = "600 44px -apple-system, system-ui, sans-serif";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(String(text)).width) + 32;
    canvas.height = 64;
    // Resizing the canvas resets its context, so the font is set again.
    ctx.font = font;
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(String(text), 16, canvas.height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.scale.set((size * canvas.width) / canvas.height, size, 1);
    sprite.renderOrder = 10;
    if (Array.isArray(position)) sprite.position.fromArray(position);
    else if (position) sprite.position.copy(position);
    return sprite;
}

function fitCamera(THREE, scene, camera, controls, padding = 1.25, inPlace = false) {
    const box = new THREE.Box3().setFromObject(scene);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const size = box.getSize(new THREE.Vector3());
    // In place, look head-on so the content's front face exactly covers the region beneath it.
    const distance = inPlace
        ? Math.max(size.y / 2 / tan, size.x / 2 / (tan * camera.aspect)) * padding + size.z / 2
        : (sphere.radius * padding) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    const direction = inPlace ? new THREE.Vector3(0, 0, 1) : camera.position.clone().sub(controls.target);
    if (direction.lengthSq() === 0) direction.set(0.6, 0.45, 0.8);
    direction.normalize();
    const center = inPlace ? box.getCenter(new THREE.Vector3()) : sphere.center;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.01, distance / 200);
    camera.far = distance * 200;
    camera.updateProjectionMatrix();
    controls.update();
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not load the selected image"));
        image.src = src;
    });
}

async function renderThree(code, imageUrl, inPlace = false) {
    const THREE = await import("three");
    const IMAGE = imageUrl ? await loadImage(imageUrl) : null;
    const imageTexture = () => {
        if (!IMAGE) throw new Error("No image region was given to this panel");
        const texture = new THREE.Texture(IMAGE);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
    };
    const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
    const size = () => [root.clientWidth || innerWidth, Math.max(1, root.clientHeight || innerHeight)];
    const [width, height] = size();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    root.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 2000);
    camera.position.set(...(inPlace ? [0, 0, 6] : [4, 3, 6]));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = !inPlace;
    controls.autoRotateSpeed = 1.1;
    controls.addEventListener("start", () => {
        controls.autoRotate = false;
    });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30363d, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(5, 8, 6);
    scene.add(sun);

    const frames = [];
    const onFrame = (fn) => typeof fn === "function" && frames.push(fn);
    const label = (text, position, options) => makeLabel(THREE, text, position, options);
    const fit = (padding = inPlace ? 1 : 1.25) => fitCamera(THREE, scene, camera, controls, padding, inPlace);
    const startPosition = camera.position.clone();
    const run = new AsyncFunction("THREE", "scene", "camera", "renderer", "controls", "onFrame", "label", "fit", "IMAGE", "imageTexture", `"use strict";\n${code}`);
    await run(THREE, scene, camera, renderer, controls, onFrame, label, fit, IMAGE, imageTexture);
    if (camera.position.equals(startPosition) && controls.target.lengthSq() === 0) fit();

    const clock = { start: performance.now(), last: performance.now() };
    let raf = 0;
    const loop = (now = performance.now()) => {
        raf = requestAnimationFrame(loop);
        const delta = (now - clock.last) / 1000;
        clock.last = now;
        for (const fn of [...frames]) {
            try {
                fn((now - clock.start) / 1000, delta);
            } catch (error) {
                frames.splice(frames.indexOf(fn), 1);
                report({ type: "error", message: `Animation error: ${describe(error)}` });
            }
        }
        controls.update();
        renderer.render(scene, camera);
    };
    loop();
    const resize = new ResizeObserver(() => {
        const [w, h] = size();
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    });
    resize.observe(root);
    return () => {
        cancelAnimationFrame(raf);
        resize.disconnect();
        controls.dispose();
        renderer.dispose();
    };
}

// Written documents replace this one, so they get the same import map.
const IMPORT_MAP = document.querySelector("script[type=importmap]").outerHTML;

// The page reports its own errors, gets the region's pixels and says when its scripts have run.
function renderHtml(html, imageUrl) {
    const reporter = `${IMPORT_MAP}<script>window.IMAGE_URL = ${JSON.stringify(imageUrl ?? "")};addEventListener("error", (e) => parent.postMessage({ type: "error", message: String(e.message || e.error) }, "*"));</script>`;
    const base = `<style>:root{color-scheme:dark}html,body{margin:0;background:transparent;color:#e6edf3;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}</style>`;
    const done = `<script>setTimeout(() => parent.postMessage({ type: "rendered" }, "*"), 250);</script>`;
    let doc;
    if (/<head[\s>]/i.test(html)) doc = html.replace(/<head[^>]*>/i, (tag) => `${tag}${reporter}${base}`);
    else if (/<html[\s>]/i.test(html)) doc = html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${reporter}${base}</head>`);
    else doc = `<!doctype html><html><head>${reporter}${base}</head><body>${html}</body></html>`;
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${done}</body>`) : `${doc}${done}`;
    document.open();
    document.write(doc);
    document.close();
}

report({ type: "ready" });
