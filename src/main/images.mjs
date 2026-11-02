// Image files for live_image and live_cutout, read only from Copilot session folders and the workspace.
import fs from "node:fs";
import path from "node:path";

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_CUTOUTS = 40;

const realOrSelf = (file) => {
    try {
        return fs.realpathSync(file);
    } catch {
        return path.resolve(file);
    }
};

// Returns a data URL for an image inside one of the allowed roots (symlinks are resolved first).
export function readImageFile(file, roots) {
    if (typeof file !== "string" || !file.trim()) throw new Error("Give the path of an image file.");
    const resolved = path.resolve(file.trim().replace(/^file:\/\//, "").replace(/%20/g, " "));
    let real;
    try {
        real = fs.realpathSync(resolved);
    } catch {
        throw new Error(`There is no image at ${resolved}.`);
    }
    const allowed = roots.map(realOrSelf).some((root) => real.startsWith(root + path.sep));
    if (!allowed) throw new Error("Only images made by image_generation or live_cutout can be shown.");
    const type = TYPES[path.extname(real).toLowerCase()];
    if (!type) throw new Error("Only PNG, JPEG and WebP images can be shown.");
    const { size } = fs.statSync(real);
    if (size > MAX_BYTES) throw new Error("The image is too large to show.");
    return `data:${type};base64,${fs.readFileSync(real).toString("base64")}`;
}

// Saves a cutout PNG and keeps only the most recent ones.
export function saveCutout(dir, id, base64) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".png"))
        .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
    for (const old of files.slice(KEEP_CUTOUTS)) fs.rmSync(path.join(dir, old.name), { force: true });
    return file;
}
