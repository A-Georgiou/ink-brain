const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stageStatus(stage, id, timeout) {
    let timer;
    try {
        return await Promise.race([
            stage.status(id).catch(() => null),
            new Promise((resolve) => (timer = setTimeout(resolve, timeout))),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function awaitStage(stage, id, index = null, { minimum = 500, limit = 8_000, poll = 150, complete = false, now = Date.now, sleep = delay } = {}) {
    const start = now();
    await sleep(Math.min(minimum, limit));
    for (;;) {
        const state = await stageStatus(stage, id, Math.max(1, Math.min(500, limit - (now() - start))));
        const ms = now() - start;
        if (index != null && (stage.stepIndex(id) > index || state?.index > index)) return { reason: "advanced", ms };
        if (state?.settled && (!complete || !state.building) && (index == null || state.index === index)) return { reason: "settled", ms };
        if (ms >= limit) return { reason: "capped", ms, ...(state?.building ? { building: true } : {}) };
        await sleep(Math.min(poll, limit - ms));
    }
}
