// The user's ink in pen mode: freehand strokes (circling, underlining) and click-to-point pins.
import { boundsOfPoints } from "/shared/geometry.mjs";

const INK = "#ff3ec9";

function drawPin(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 62, 201, 0.18)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
}

export class Ink {
    marks = [];
    #stroke = null;
    #settled = false;
    #fadeTimer = 0;

    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.#resize();
        addEventListener("resize", () => this.#resize());
        canvas.addEventListener("pointerdown", (event) => this.#down(event));
        canvas.addEventListener("pointermove", (event) => this.#move(event));
        canvas.addEventListener("pointerup", () => this.#up());
        canvas.addEventListener("pointercancel", () => this.#up());
        canvas.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            this.undo();
        });
    }

    enable(on) {
        this.canvas.classList.toggle("active", on);
    }

    clear() {
        this.marks = [];
        this.#stroke = null;
        this.#settled = false;
        clearTimeout(this.#fadeTimer);
        this.canvas.classList.remove("settled");
        this.#draw();
    }

    undo() {
        this.marks.pop();
        this.#draw();
    }

    // After sending, keep the marks faintly visible while the answer comes in, then remove them.
    settle(ms = 15_000) {
        this.#settled = true;
        this.canvas.classList.add("settled");
        clearTimeout(this.#fadeTimer);
        this.#fadeTimer = setTimeout(() => this.clear(), ms);
    }

    #down(event) {
        if (event.button !== 0) return;
        if (this.#settled) this.clear();
        this.canvas.setPointerCapture(event.pointerId);
        this.#stroke = { type: "stroke", points: [[event.clientX, event.clientY]] };
        this.marks.push(this.#stroke);
        this.#draw();
    }

    #move(event) {
        if (!this.#stroke) return;
        for (const point of event.getCoalescedEvents?.() ?? [event]) {
            const last = this.#stroke.points.at(-1);
            if (Math.hypot(point.clientX - last[0], point.clientY - last[1]) >= 2) this.#stroke.points.push([point.clientX, point.clientY]);
        }
        this.#draw();
    }

    #up() {
        const stroke = this.#stroke;
        if (!stroke) return;
        this.#stroke = null;
        const bounds = boundsOfPoints(stroke.points);
        if (Math.max(bounds.w, bounds.h) < 8) {
            const [x, y] = stroke.points[0];
            this.marks[this.marks.indexOf(stroke)] = { type: "pin", x, y };
        }
        this.#draw();
    }

    #resize() {
        const dpr = devicePixelRatio || 1;
        this.canvas.width = Math.round(innerWidth * dpr);
        this.canvas.height = Math.round(innerHeight * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.#draw();
    }

    #draw() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const mark of this.marks) {
            if (mark.type === "pin") {
                drawPin(ctx, mark.x, mark.y);
                continue;
            }
            ctx.beginPath();
            mark.points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.shadowColor = "rgba(255, 62, 201, 0.85)";
            ctx.shadowBlur = 14;
            ctx.strokeStyle = INK;
            ctx.lineWidth = 4.5;
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }
    }
}
