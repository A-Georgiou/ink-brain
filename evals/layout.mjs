// Quantifies screen-level obstructions from recorded frame geometry.
const intersection = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const percent = (fraction) => Math.round(100 * fraction);

export function measureLayout(frames, screen) {
    let panelHeaderCovered = 0;
    let panelOffscreen = 0;
    const bounds = { x: 0, y: 0, w: screen.width, h: screen.height };
    for (const { layout } of frames) {
        const panels = layout?.panels ?? [];
        for (const [index, panel] of panels.entries()) {
            if (panel.w <= 0 || panel.h <= 0) continue;
            const titleBar = Math.min(40, panel.h);
            // Ignore the borders; only hiding the title or controls counts.
            const inset = Math.min(8, titleBar / 4);
            const header = { ...panel, y: panel.y + inset, h: titleBar - 2 * inset };
            const blockers = [layout.bubble, ...panels.filter((_, i) => i !== index)].filter(Boolean);
            panelHeaderCovered = Math.max(panelHeaderCovered, ...blockers.map((blocker) => intersection(header, blocker) / (header.w * header.h)));
            panelOffscreen = Math.max(panelOffscreen, 1 - intersection(panel, bounds) / (panel.w * panel.h));
        }
    }
    return { panelHeaderCovered: percent(panelHeaderCovered), panelOffscreen: percent(panelOffscreen) };
}
