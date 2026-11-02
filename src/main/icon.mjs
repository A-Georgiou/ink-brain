// Draws the menu bar template icon (an ink drop with a highlight) so no image assets are needed.
import { nativeImage } from "electron";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function trayIcon() {
    const scale = 2;
    const size = 18 * scale;
    const pixels = Buffer.alloc(size * size * 4);
    // A circle of radius r under a pointed tip, the sides tangent to it (30 degrees either side).
    const [cx, cy, r, tip] = [18, 22.5, 9.5, 3.5];
    const sin = r / (cy - tip);
    const cos = Math.sqrt(1 - sin * sin);
    const shoulder = cy - r * sin;
    // The highlight is an arc on the upper left of the round part, with rounded ends.
    const [hr, hw, from, to] = [5.6, 0.85, (160 * Math.PI) / 180, (230 * Math.PI) / 180];
    const ends = [from, to].map((a) => [cx + hr * Math.cos(a), cy + hr * Math.sin(a)]);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const [px, py] = [x + 0.5, y + 0.5];
            const centre = Math.hypot(px - cx, py - cy);
            const sides = Math.max(cos * (px - cx) - sin * (py - tip), -cos * (px - cx) - sin * (py - tip), py - shoulder);
            const drop = Math.min(centre - r, sides);
            let angle = Math.atan2(py - cy, px - cx);
            if (angle < 0) angle += Math.PI * 2;
            const highlight = angle >= from && angle <= to ? Math.abs(centre - hr) - hw : Math.min(...ends.map(([ex, ey]) => Math.hypot(px - ex, py - ey))) - hw;
            pixels[(y * size + x) * 4 + 3] = Math.round(clamp01(0.5 - drop) * (1 - clamp01(0.5 - highlight)) * 255);
        }
    }
    const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: scale });
    image.setTemplateImage(true);
    return image;
}
