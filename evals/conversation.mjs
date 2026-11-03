// Multi-turn scenarios: a scenario with turns plays them one after another in one session, on one screen, and the judge grades the whole exchange.

const LOOP = 44;

// The turns to play: a conversation's own, or the single ask of every other scenario.
export const turnsOf = (scenario) => (Array.isArray(scenario.turns) && scenario.turns.length ? scenario.turns : [{ ask: scenario.ask }]);

// A loose circle around a region, the way the user's pen marks something new partway through.
export function loopAround({ x, y, w, h }) {
    const [cx, cy, rx, ry] = [x + w / 2, y + h / 2, w * 0.56 + 16, h * 0.62 + 16];
    const points = Array.from({ length: LOOP }, (_, i) => {
        const angle = (-100 + (i * 372) / (LOOP - 1)) * (Math.PI / 180);
        return [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))];
    });
    return [{ type: "stroke", points }];
}

// What the user has marked on a turn: the fixture's own circle, a fresh circle around a region, or nothing (they just talk).
export function marksFor(turn, meta, index) {
    if (turn.mark && typeof turn.mark === "object") return loopAround(turn.mark);
    return turn.mark === true || (index === 0 && turn.mark !== false) ? meta.marks : [];
}

// The exchange turn by turn, so the judge grades a conversation and not several separate answers.
export function exchangeLines(record, describeTool) {
    const lines = [];
    for (const [index, turn] of record.turns.entries()) {
        lines.push(
            `## Turn ${index + 1}`,
            `The user ${turn.marked ? "circled something on their screen (magenta) and " : ""}asked: "${turn.ask}"`,
            `It said: "${turn.text.trim() || "(nothing)"}"`,
        );
        if (turn.captions.length) lines.push("Narrated steps:", ...turn.captions.map((caption, i) => `${i + 1}. "${caption}"`));
        lines.push("Tools, in order:", ...(turn.tools.length ? turn.tools.map((tool) => `- ${describeTool(tool)}`) : ["- none"]));
        if (turn.error) lines.push(`This turn ended with an error: ${turn.error}`);
    }
    return lines;
}

// What the conversation left on screen: panels pile up unless Ink Brain updates or clears them.
export function conversationMetrics(record) {
    const counts = record.frames.filter((frame) => frame.layout).map((frame) => frame.layout.panels.length);
    const visuals = record.turns.map((turn) => turn.tools.filter((tool) => tool.name === "live_explain" || tool.name === "live_panel").length);
    return { turns: record.turns.length, panelsAtEnd: counts.at(-1) ?? 0, panelsAtMost: Math.max(0, ...counts), stagesPerTurn: visuals };
}

// Frames for the judge: an even spread inside each turn, so every turn is seen, not just the busiest.
export function pickFrames(record, pick, max = 12) {
    const per = Math.max(2, Math.floor(max / record.turns.length));
    return record.turns.flatMap((turn, index) => {
        const until = record.turns[index + 1]?.at ?? Infinity;
        return pick(record.frames.filter((frame) => frame.at >= turn.at && frame.at < until), per);
    });
}
