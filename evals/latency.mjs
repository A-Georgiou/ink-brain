const VISUAL_BUDGETS = { "3d": 15_000, maths: 10_000, diagram: 10_000, pointing: 6_000, research: 15_000 };

export function latencyMetrics(category, record) {
    const firstVisualBudget = VISUAL_BUDGETS[category] ?? 10_000;
    return {
        firstNarration: record.firstNarration ?? null,
        firstVisualBudget,
        firstVisualWithinBudget: Number.isFinite(record.firstVisual) && record.firstVisual >= 0 && record.firstVisual <= firstVisualBudget,
    };
}

// Timed deltas let a replay measure streaming changes without asking the model for different content.
export function replayTimeline(record) {
    return [...(record.timeline ?? []), ...record.tools.map((tool) => ({ kind: "tool", at: tool.at, tool }))].sort((a, b) => a.at - b.at);
}
