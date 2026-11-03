// Ink Brain overlay: user ink, drawings, panels, the answer bubble, composer, dock and prompt cards.
import { Annotations } from "./annotations.js";
import { compose } from "./compose.js";
import { Ink } from "./ink.js";
import { renderMarkdown } from "./markdown.js";
import { Panels } from "./panels.js";
import { anchorAt, anchorOf, centreOf, pageState } from "/shared/anchors.mjs";
import { bubbleSpot, overlapArea } from "/shared/geometry.mjs";

const api = window.live;
const $ = (selector) => document.querySelector(selector);
const body = document.body;
const prompt = $("#prompt");

const ICONS = {
    mic: `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>`,
    live: `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M7.8 8.2a5.4 5.4 0 0 0 0 7.6M16.2 8.2a5.4 5.4 0 0 1 0 7.6M4.9 5.3a9.5 9.5 0 0 0 0 13.4M19.1 5.3a9.5 9.5 0 0 1 0 13.4"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`,
    close: `<svg viewBox="0 0 24 24" width="14" height="14"><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>`,
};
$("#mic").innerHTML = ICONS.mic;
$("#stay").innerHTML = ICONS.live;
$(".bubble-stop").innerHTML = ICONS.stop;
$(".bubble-close").innerHTML = ICONS.close;

const TOOL_LABELS = {
    live_annotate: "Sketching on your screen",
    live_explain: "Explaining",
    live_panel: "Building a live view",
    live_cutout: "Pulling it out",
    live_image: "Showing a render",
    live_control: "Taking control",
    image_generation: "Rendering an image",
    live_look: "Looking at your screen",
    live_read: "Reading the page",
    live_remember: "Remembering that",
    live_recall: "Thinking back",
    live_reopen: "Bringing it back",
    live_clear: "Tidying up",
    live_speak: "Speaking",
};
const toolLabel = (name) => TOOL_LABELS[name] ?? `Using ${name}`;
const PREPARING_LABELS = { live_explain: "Planning the explanation", live_panel: "Building a live demo", live_control: "Planning the steps" };

let state = {};
let typed = false;
let interactive = false;
let lastAnchor = null;

const ink = new Ink($("#ink"));
const annotations = new Annotations({ svgRoot: $("#annotations"), labels: $("#labels"), boards: $("#boards"), pointer: $("#pointer"), ripples: $("#ripples") });
const bubble = createBubble();
const panels = new Panels($("#panels"), { avoid: () => [lastAnchor, bubble.rect()], target: () => lastAnchor, onLayout: () => bubble.reflow(), pageFor: (rect) => pages.place(rect) });

// ------------------------------------------------ pages: drawings stay with their tab, window and Space

const pages = (() => {
    let windows = [];
    let turn = null;
    const known = new Map();
    return {
        update(list) {
            windows = Array.isArray(list) ? list : [];
            this.refresh();
        },
        // A turn's drawings go on the page under the user's marks, else the frontmost window.
        beginTurn(marks) {
            const anchor = anchorAt(windows, marks && { x: marks.x + marks.w / 2, y: marks.y + marks.h / 2 });
            turn = anchor && { id: anchor.id, page: anchor.page, last: anchor };
        },
        endTurn() {
            turn = null;
        },
        // The page for something drawn at rect; a window that has moved starts a fresh layer.
        place(rect) {
            let anchor = null;
            if (turn) {
                const win = windows.find((w) => w.id === turn.id);
                if (win) turn.last = anchorOf(win, turn.page);
                anchor = turn.last;
            } else if (rect) {
                anchor = anchorAt(windows, { x: rect.x + (rect.w || 0) / 2, y: rect.y + (rect.h || 0) / 2 });
            }
            if (!anchor) return null;
            if (!known.has(anchor.key)) known.set(anchor.key, { anchor, box: null });
            this.grow(anchor.key, rect);
            return anchor.key;
        },
        grow(key, box) {
            const page = known.get(key);
            if (!page || !box || box.w < 1 || box.h < 1) return;
            const b = page.box ?? box;
            const x = Math.min(b.x, box.x);
            const y = Math.min(b.y, box.y);
            page.box = { x, y, w: Math.max(b.x + b.w, box.x + box.w) - x, h: Math.max(b.y + b.h, box.y + box.h) - y };
        },
        refresh() {
            const used = new Set([...annotations.pageKeys(), ...panels.pageKeys()]);
            const states = new Map();
            for (const [key, page] of known) {
                if (used.has(key)) states.set(key, pageState(windows, page.anchor, page.box));
                else known.delete(key);
            }
            annotations.showPages(states);
            panels.showPages(states);
            bubble.reflow();
        },
    };
})();

api.on("live:windows", (list) => pages.update(list));

// ------------------------------------------------ click-through: only cards take the mouse

function setInteractive(on) {
    if (on === interactive) return;
    interactive = on;
    api.setInteractive(on);
}

addEventListener("mousemove", (event) => {
    if (state.pen || body.classList.contains("dragging")) return;
    setInteractive(Boolean(document.elementFromPoint(event.clientX, event.clientY)?.closest(".interactive")));
});

document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    event.preventDefault();
    api.command("openExternal", link.href);
});

// ------------------------------------------------ state

api.on("live:state", (next) => {
    const wasPen = Boolean(state.pen);
    state = next;
    for (const flag of ["pen", "thinking", "speaking", "listening", "controlling"]) body.classList.toggle(flag, next[flag]);
    ink.enable(next.pen);
    $("#composer").classList.toggle("hidden", !next.pen);
    $("#hint").classList.toggle("hidden", !next.pen);
    $("#target").textContent = `To: ${next.resolvedTarget}${next.target === "auto" ? " (auto)" : ""}`;
    $("#mic").classList.toggle("on", next.listening);
    $("#stay").classList.toggle("on", next.stayLive);
    prompt.placeholder = next.listening ? "Listening... circle or click anything and just talk" : "Circle or click anything, then ask";
    if (next.pen && !wasPen) enterPen();
    if (!next.pen && wasPen) exitPen();
    updateDock();
    setup.render(next.permissions);
});

function enterPen() {
    typed = false;
    prompt.value = "";
    if (!ink.marks.length || body.classList.contains("submitted")) ink.clear();
    body.classList.remove("submitted");
    setTimeout(() => prompt.focus(), 30);
}

function exitPen() {
    interactive = false;
    prompt.blur();
    if (!body.classList.contains("submitted")) ink.clear();
}

function updateDock() {
    const show = !state.pen && (state.listening || state.thinking || state.speaking || state.stayLive || state.hearing);
    $("#dock").classList.toggle("hidden", !show);
    const orb = $("#dock-orb");
    if (state.listening && state.stayLive) orb.title = `Listening hands-free. Say "${state.wakeWord || "Ink Brain"}" to ask.`;
    else if (state.listening) orb.title = "Listening for a follow-up";
    else orb.title = "Ask Ink Brain";
}

let dockTimer = 0;
function dockText(text, clearAfterMs = 0) {
    const el = $("#dock-text");
    el.textContent = text;
    clearTimeout(dockTimer);
    if (clearAfterMs) dockTimer = setTimeout(() => (el.textContent = ""), clearAfterMs);
}

// ------------------------------------------------ composer, voice and submitting

function submit(text = prompt.value) {
    const clean = text.trim();
    const marks = ink.marks;
    if (!clean && !marks.length) return;
    body.classList.add("submitted");
    api.submit({ text: clean, marks });
    prompt.value = "";
    prompt.classList.remove("transcript");
    typed = false;
    ink.settle();
}

$("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
});

prompt.addEventListener("input", () => {
    prompt.classList.remove("transcript");
    const nowTyped = prompt.value.length > 0;
    if (nowTyped && !typed && state.listening) api.command("toggleListening");
    typed = nowTyped;
});

addEventListener("keydown", (event) => {
    if (!state.pen) return;
    const undo = (event.key === "z" && event.metaKey) || (event.key === "Backspace" && !prompt.value);
    if (event.key === "Escape") {
        event.preventDefault();
        api.command("stopSpeaking");
        api.setPen(false);
    } else if (undo && ink.marks.length) {
        event.preventDefault();
        ink.undo();
    }
});

$("#target").addEventListener("click", () => api.command("cycleTarget"));
$("#mic").addEventListener("click", () => api.command("toggleListening"));
$("#stay").addEventListener("click", () => api.command("toggleStayLive"));
$("#dock-orb").addEventListener("click", () => api.setPen(true));

api.on("live:transcript", ({ text, final, submit: send }) => {
    if (typed) return;
    if (state.pen) {
        prompt.value = text;
        prompt.classList.toggle("transcript", !final);
    } else {
        dockText(text, final && !send ? 2000 : 0);
    }
    if (final && send) submit(text);
});

api.on("live:level", ({ level }) => document.documentElement.style.setProperty("--level", Number(level).toFixed(3)));

// ------------------------------------------------ answers

function createBubble() {
    const el = $("#bubble");
    const content = el.querySelector(".bubble-body");
    const question = el.querySelector(".bubble-question");
    const activity = el.querySelector(".bubble-activity");
    const target = el.querySelector(".bubble-target");
    let text = "";
    let turnId = 0;
    let active = false;
    let anchor = null;
    let frame = 0;
    let hideTimer = 0;
    let slot = null;
    let jump = true;
    let label = "";
    let labelSince = 0;

    const hide = () => el.classList.add("hidden");
    const scheduleHide = (ms = 30_000) => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => !el.matches(":hover") && hide(), ms);
    };
    const showActivity = (next) => {
        [label, labelSince] = [next, Date.now()];
        activity.textContent = next;
    };
    // A step that runs long counts its seconds, so a slow answer never looks frozen.
    setInterval(() => {
        const seconds = Math.floor((Date.now() - labelSince) / 1000);
        if (active && label && seconds >= 5) activity.textContent = `${label} (${seconds}s)`;
    }, 1000);

    el.querySelector(".bubble-close").addEventListener("click", () => {
        hide();
        api.command("dismiss");
    });
    el.querySelector(".bubble-stop").addEventListener("click", () => api.command(active ? "cancelTurn" : "stopSpeaking"));
    el.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    el.addEventListener("mouseleave", () => !active && scheduleHide(10_000));

    // Moves aside when something is drawn or opened under it, and never covers the user's marks.
    function place() {
        const drawn = [...annotations.rects(), ...panels.rects()];
        const view = { width: innerWidth, height: innerHeight };
        const pick = bubbleSpot({ w: el.offsetWidth, h: el.offsetHeight, view, bottomInset: state.pen ? 150 : 110, anchor, drawn, current: slot });
        slot = pick.name;
        // A bubble that was hidden appears in place; one already on screen glides to its new spot.
        el.classList.toggle("placing", jump);
        el.style.left = `${Math.round(pick.box.x)}px`;
        el.style.top = `${Math.round(pick.box.y)}px`;
        if (jump) {
            void el.offsetWidth;
            el.classList.remove("placing");
            jump = false;
        }
    }

    function render() {
        frame = 0;
        content.innerHTML = renderMarkdown(text);
        content.classList.toggle("waiting", active && !text.trim());
        content.scrollTop = content.scrollHeight;
        place();
    }
    const schedule = () => (frame ||= requestAnimationFrame(render));

    function open() {
        clearTimeout(hideTimer);
        if (el.classList.contains("hidden")) jump = true;
        el.classList.remove("hidden");
        schedule();
    }

    return {
        rect: () => (el.classList.contains("hidden") ? null : el.getBoundingClientRect()),
        reflow: () => !el.classList.contains("hidden") && place(),
        get active() {
            return active;
        },
        start(turn) {
            [turnId, active, text, anchor, slot] = [turn.id, true, "", turn.anchor, null];
            question.textContent = turn.question ? `"${turn.question}"` : "";
            target.textContent = turn.target;
            showActivity("Looking at your screen");
            open();
        },
        append(delta) {
            text += delta;
            showActivity("");
            schedule();
        },
        activity: showActivity,
        end(turn) {
            if (turn.id !== turnId) return;
            active = false;
            showActivity(turn.error ? "Something went wrong" : "");
            if (turn.error && !text.trim()) text = `*${turn.error}*`;
            if (turn.cancelled && !text.trim()) return hide();
            schedule();
            scheduleHide();
        },
        say(message) {
            [turnId, active, text, anchor, slot] = [-1, false, message, null, null];
            question.textContent = "";
            target.textContent = "Copilot";
            showActivity("");
            open();
            scheduleHide();
        },
        // Collapses to its header while an explanation is narrated in the captions.
        minimize(on) {
            el.classList.toggle("minimized", on);
            if (on) place();
            else schedule();
        },
    };
}

const captions = (() => {
    const el = $("#captions");
    const steps = el.querySelector(".caption-steps");
    const line = el.querySelector(".caption-text");
    let hideTimer = 0;
    let scene = null;
    // Subtitles sit along a scene's bottom edge like a video, otherwise above the minimized bubble.
    const dodge = () => {
        Object.assign(el.style, { left: "", bottom: "", maxWidth: "" });
        const stage = scene && panels.rectOf(scene);
        el.classList.toggle("docked", Boolean(stage));
        if (stage) {
            Object.assign(el.style, { left: `${Math.round(stage.left + stage.width / 2)}px`, bottom: `${Math.round(innerHeight - stage.bottom + 14)}px`, maxWidth: `${Math.round(stage.width - 48)}px` });
            return;
        }
        const pill = bubble.rect();
        const box = el.getBoundingClientRect();
        if (pill && overlapArea({ x: box.x, y: 0, w: box.width, h: innerHeight }, [pill]) > 0 && pill.top > innerHeight / 2) {
            el.style.bottom = `${Math.round(innerHeight - pill.top + 10)}px`;
        }
    };
    return (event) => {
        clearTimeout(hideTimer);
        if (event.type === "start") {
            scene = event.scene ?? null;
            steps.replaceChildren(...Array.from({ length: event.total }, () => document.createElement("i")));
            line.textContent = event.title || "";
            el.classList.remove("hidden");
            bubble.minimize(true);
            dodge();
        } else if (event.type === "step") {
            while (steps.children.length < event.total) steps.append(document.createElement("i"));
            [...steps.children].forEach((dot, index) => dot.classList.toggle("done", index <= event.index));
            line.textContent = event.text;
            el.classList.remove("hidden");
            dodge();
        } else if (event.type === "end") {
            bubble.minimize(false);
            hideTimer = setTimeout(() => el.classList.add("hidden"), event.stopped ? 400 : 2500);
        }
    };
})();

api.on("live:explain", captions);

api.on("live:turn", (event) => {
    if (event.type === "start") {
        // Every turn, however it was asked, keeps new panels off what the user marked.
        lastAnchor = event.anchor ?? null;
        pages.beginTurn(event.anchor);
        bubble.start(event);
        dockText("");
    } else if (event.type === "delta") bubble.append(event.text);
    else if (event.type === "tool") bubble.activity(toolLabel(event.name));
    else if (event.type === "preparing") bubble.activity(PREPARING_LABELS[event.name] ?? toolLabel(event.name));
    else if (event.type === "status") bubble.activity(event.text);
    else if (event.type === "end") {
        pages.endTurn();
        bubble.end(event);
    } else if (event.type === "say") bubble.say(event.text);
});

api.on("live:activity", ({ name, origin }) => {
    if (bubble.active) bubble.activity(toolLabel(name));
    else {
        $("#dock").classList.remove("hidden");
        dockText(`${origin}: ${toolLabel(name)}`, 3000);
        setTimeout(updateDock, 3100);
    }
});

api.on("live:flash", () => {
    const shutter = $("#shutter");
    shutter.classList.remove("flash");
    void shutter.offsetWidth;
    shutter.classList.add("flash");
});

// ------------------------------------------------ setup, approvals and toasts

const setup = (() => {
    const el = $("#setup");
    el.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const kind = button.closest("li")?.dataset.kind;
        if (kind) api.command("requestPermission", kind);
        else if (button.dataset.action === "restart") api.command("restartHelper");
        else if (button.dataset.action === "done") el.classList.add("hidden");
    });
    return {
        show: () => el.classList.remove("hidden"),
        render(permissions) {
            if (!permissions) return;
            for (const item of el.querySelectorAll("li")) {
                const status = permissions[item.dataset.kind];
                const granted = status === "granted";
                const button = item.querySelector("button");
                item.classList.toggle("granted", granted);
                button.disabled = granted;
                button.textContent = granted ? "Granted" : status === "denied" || status === "missing" ? "Open Settings" : "Grant";
            }
        },
    };
})();

api.on("live:setup", ({ show }) => show && setup.show());

api.on("live:approval", ({ id, label, cwd, done }) => {
    const el = $("#approval");
    if (done) {
        if (el.dataset.id === id) el.classList.add("hidden");
        return;
    }
    el.dataset.id = id;
    el.querySelector(".approval-title").textContent = `${label} wants to see your screen`;
    el.querySelector(".approval-detail").textContent = cwd ? `A Copilot session working in ${cwd}` : "A Copilot CLI or App session";
    el.classList.remove("hidden");
});

$("#approval").addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) return;
    const el = $("#approval");
    api.command(action === "allow" ? "approvePeer" : "denyPeer", el.dataset.id);
    el.classList.add("hidden");
});

api.on("live:toast", ({ message, level = "info" }) => {
    const el = document.createElement("div");
    el.className = `toast interactive ${level}`;
    el.textContent = message;
    el.addEventListener("click", () => el.remove());
    $("#toasts").append(el);
    setTimeout(() => {
        el.classList.add("fading");
        setTimeout(() => el.remove(), 650);
    }, level === "error" ? 10_000 : 6_000);
});

// ------------------------------------------------ taking control

const control = (() => {
    const card = $("#control-card");
    const ACTION_LABEL = { click: "Click", double_click: "Double-click", right_click: "Right-click", move: "Move to", drag: "Drag", scroll: "Scroll", type: "Type", key: "Press", wait: "Wait" };
    let asking = 0;
    card.addEventListener("click", (event) => {
        const decision = event.target.closest("button")?.dataset.decision;
        if (decision) api.command("controlDecision", { id: asking, decision });
    });
    $("#control-stop").addEventListener("click", () => api.command("stopControl"));
    return ({ type, id, origin, reason, steps = [] }) => {
        if (type === "ask") {
            asking = id;
            card.querySelector(".control-origin").textContent = `${origin} wants to take control`;
            card.querySelector(".control-reason").textContent = reason || "Ink Brain wants to operate your Mac.";
            const list = card.querySelector(".control-steps");
            list.replaceChildren(
                ...steps.map((step) => {
                    const item = document.createElement("li");
                    const detail = step.label || (step.action === "type" ? `"${step.text}"` : step.keys) || "";
                    item.textContent = `${ACTION_LABEL[step.action] ?? step.action} ${detail}`.trim();
                    return item;
                }),
            );
            const marks = steps.flatMap((step, index) => (Number.isFinite(step.x) ? [{ kind: "marker", x: step.x, y: step.y, text: String(index + 1), color: "#f2cc60" }] : []));
            annotations.draw(marks, { clear: false, ttl: 0, group: "control-ask" });
            card.classList.remove("hidden");
        } else if (type === "ask-done" && id === asking) {
            card.classList.add("hidden");
            annotations.clear(undefined, "control-ask");
        }
    };
})();

api.on("live:control", control);

// ------------------------------------------------ reading the web

const webCard = (() => {
    const card = $("#web-card");
    let asking = 0;
    card.addEventListener("click", (event) => {
        const decision = event.target.closest("button")?.dataset.decision;
        if (decision) api.command("webDecision", { id: asking, decision });
    });
    return ({ type, id, site, url }) => {
        if (type === "ask") {
            asking = id;
            card.querySelector(".web-title").textContent = `Ink Brain wants to read ${site}`;
            card.querySelector(".web-url").textContent = url;
            card.querySelector(".web-always").textContent = `Always allow ${site}`;
            card.classList.remove("hidden");
        } else if (type === "ask-done" && id === asking) {
            card.classList.add("hidden");
        }
    };
})();

api.on("live:web", webCard);

// ------------------------------------------------ requests from the main process

api.on("live:call", async ({ id, method, params }) => {
    try {
        let result = null;
        if (method === "compose") result = await compose(params);
        else if (method === "annotate") {
            const centre = centreOf(params.shapes);
            const page = pages.place(centre && { ...centre, w: 0, h: 0 });
            const { duration, box } = annotations.draw(params.shapes, { ...params, page });
            pages.grow(page, box);
            result = { duration };
        } else if (method === "expire") annotations.expire(params.group, params.seconds);
        else if (method === "panel") {
            result = await panels.show(params);
            bubble.reflow();
        } else if (method === "cutout") result = panels.showCutout(params);
        else if (method === "image") {
            result = await panels.showImage(params);
            bubble.reflow();
        } else if (method === "scene-step") panels.step(params.id, params.index);
        else if (method === "scene-steps") panels.addSteps(params.id, params.steps);
        else if (method === "clear") {
            const visibleOnly = params.scope === "visible";
            if (params.target !== "panels") annotations.clear(params.id, params.group, { visibleOnly });
            if (params.target !== "annotations" && !params.group) panels.clear(params.id, { visibleOnly });
        } else throw new Error(`Unknown overlay call: ${method}`);
        if (method !== "compose") pages.refresh();
        api.respond(id, true, result);
    } catch (error) {
        api.respond(id, false, error?.message ?? String(error));
    }
});

api.ready();
