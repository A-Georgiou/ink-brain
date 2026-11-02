// Pages: drawings belong to the window and page (title) they were made for.
import { boundsOfPoints } from "./geometry.mjs";

// Unread counts and unsaved markers such as "(3) Inbox" or "● file.ts" do not make a new page.
export function pageTitle(title) {
    return String(title ?? "").replace(/[([]\d+\+?[)\]]/g, "").replace(/^\s*[•●*]\s*/u, "").replace(/\s+/g, " ").trim();
}

const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// A window's anchor, keyed by its position too, so drawings made after it moves get their own layer.
export function anchorOf(win, page = win.page) {
    return { key: `${win.id}|${page}|${Math.round(win.x)},${Math.round(win.y)}`, id: win.id, page, x: win.x, y: win.y, w: win.w, h: win.h };
}

// windows are { id, page, x, y, w, h }, front to back; the topmost under point wins, else the first.
export function anchorAt(windows, point) {
    const win = (point && windows.find((w) => inside(w, point.x, point.y))) || windows[0];
    return win ? anchorOf(win) : null;
}

// A representative point for a set of overlay shapes.
export function centreOf(shapes) {
    const points = [];
    for (const s of shapes ?? []) {
        if (Number.isFinite(s.x) && Number.isFinite(s.y)) points.push([s.x + (s.w || 0) / 2, s.y + (s.h || 0) / 2]);
        for (const key of ["from", "to", "at"]) if (Array.isArray(s[key])) points.push(s[key]);
        if (s.points?.length) points.push(s.points[0]);
        for (const node of s.nodes ?? []) if (Number.isFinite(node.x) && Number.isFinite(node.y)) points.push([node.x, node.y]);
    }
    const box = boundsOfPoints(points);
    return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
}

function intersect(a, b) {
    if (!a) return null;
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x;
    const h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// Fraction of a box covered by any of the rects, sampled on a grid.
export function coverage(box, rects) {
    if (!rects.length) return 0;
    let hit = 0;
    for (let i = 0.5; i < 8; i++) {
        for (let j = 0.5; j < 8; j++) if (rects.some((r) => inside(r, box.x + (box.w * i) / 8, box.y + (box.h * j) / 8))) hit++;
    }
    return hit / 64;
}

// A page's drawings show while windows above cover at most limit of them; dx, dy are how far it moved.
export function pageState(windows, anchor, box = null, limit = 0.3) {
    const index = windows.findIndex((w) => w.id === anchor.id);
    const win = windows[index];
    if (!win || win.page !== anchor.page) return { visible: false };
    const dx = win.x - anchor.x;
    const dy = win.y - anchor.y;
    const area = intersect(box, anchor) ?? anchor;
    const moved = { x: area.x + dx, y: area.y + dy, w: area.w, h: area.h };
    return { visible: coverage(moved, windows.slice(0, index)) <= limit, dx, dy };
}
