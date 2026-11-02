// The images the model sees: the screen with the user's marks, plus a sharp zoom of the marked area.
const INK = "#ff2bd6";

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not decode the screenshot"));
        image.src = src;
    });
}

// Strokes the current path in ink over a white outline, so marks read on any background.
function strokeInk(ctx, width) {
    ctx.lineWidth = width + 3;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = INK;
    ctx.stroke();
}

// Marks are in overlay CSS pixels; scale and offset map them onto the target canvas.
function drawMarks(ctx, marks, scale, ox = 0, oy = 0) {
    const width = Math.max(3, 4 * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const mark of marks) {
        ctx.beginPath();
        if (mark.type === "pin") {
            const x = (mark.x - ox) * scale;
            const y = (mark.y - oy) * scale;
            ctx.arc(x, y, Math.max(10, 12 * scale), 0, Math.PI * 2);
            strokeInk(ctx, width);
            ctx.beginPath();
            ctx.arc(x, y, Math.max(2, 2.5 * scale), 0, Math.PI * 2);
            ctx.fillStyle = INK;
            ctx.fill();
            continue;
        }
        mark.points.forEach(([px, py], index) => {
            const x = (px - ox) * scale;
            const y = (py - oy) * scale;
            if (index) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
        });
        strokeInk(ctx, width);
    }
}

const canvasOf = (width, height) => Object.assign(document.createElement("canvas"), { width, height });
const toBase64 = (canvas, quality) => canvas.toDataURL("image/jpeg", quality).split(",")[1];

export async function compose({ image, marks = [], crop, modelWidth, modelHeight }) {
    const img = await loadImage(image);
    const native = img.naturalWidth / innerWidth;
    const full = canvasOf(modelWidth, modelHeight);
    const fullCtx = full.getContext("2d");
    fullCtx.drawImage(img, 0, 0, modelWidth, modelHeight);
    drawMarks(fullCtx, marks, modelWidth / innerWidth);

    let zoom = null;
    if (crop) {
        const [sx, sy, sw, sh] = [crop.x * native, crop.y * native, crop.w * native, crop.h * native];
        const k = Math.min(1, 1280 / Math.max(sw, sh));
        const canvas = canvasOf(Math.round(sw * k), Math.round(sh * k));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        drawMarks(ctx, marks, native * k, crop.x, crop.y);
        zoom = toBase64(canvas, 0.9);
    }
    return { full: toBase64(full, 0.85), crop: zoom };
}
