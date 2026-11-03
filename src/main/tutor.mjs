// Predict-then-reveal checks: validate the question, wait for a click or spoken answer, and tell the model which misconception to address.
const WORDS = /\p{L}[\p{L}\p{N}]{2,}/gu;

export function normalizeCheck(args) {
    const question = String(args?.question ?? "").trim().slice(0, 280);
    const choices = (Array.isArray(args?.choices) ? args.choices : []).slice(0, 4).map((choice, index) => ({
        id: `c${index + 1}`,
        label: String(choice?.label ?? "").trim().slice(0, 180),
        correct: choice?.correct === true,
        misconception: String(choice?.misconception ?? "").trim().slice(0, 300),
    })).filter((choice) => choice.label);
    return { question, choices };
}

export function validateCheck(args) {
    const check = normalizeCheck(args);
    if (!check.question) return "live_check needs a question";
    if (check.choices.length < 2) return "live_check needs 2 to 4 choices with labels";
    if (check.choices.filter((choice) => choice.correct).length !== 1) return "live_check needs exactly one correct choice";
    return null;
}

export const publicChoices = (choices) => choices.map(({ id, label }) => ({ id, label }));

// Matches a spoken answer to a choice by overlap, or by "2" / "option 2".
export function matchChoice(choices, text) {
    const said = String(text ?? "").trim().toLowerCase();
    if (!said || !Array.isArray(choices)) return null;
    const ordinal = said.match(/\b(?:option|choice|number)?\s*([1-4])\b/);
    if (ordinal && choices[Number(ordinal[1]) - 1]) return choices[Number(ordinal[1]) - 1];
    const contains = choices.find((choice) => {
        const label = choice.label.toLowerCase();
        return said.includes(label) || (label.length > 2 && label.includes(said));
    });
    if (contains) return contains;
    const ranked = choices
        .map((choice) => ({ choice, score: overlap(said, choice.label) }))
        .sort((a, b) => b.score - a.score);
    return ranked[0]?.score >= 0.5 ? ranked[0].choice : null;
}

function overlap(said, label) {
    const words = (label.toLowerCase().match(WORDS) ?? []).filter((word) => word.length > 3);
    if (!words.length) return 0;
    return words.filter((word) => said.includes(word)).length / words.length;
}

// What the model should do with the learner's answer. The misconception is for the model, not shown as the reveal.
export function describeAnswer(check, answer, stageId = null) {
    const right = check.choices.find((choice) => choice.correct);
    const rightLabel = right?.label ?? "the correct choice";
    const said = String(answer?.say || answer?.label || "").trim();
    const visual = stageId
        ? ` Then call live_explain with id "${stageId}" (steps only, no new board or scene) to visibly show the reveal on the stage already on screen, hiding or transforming any pre-check labels it replaces.`
        : "";
    if (!answer || (!answer.id && !said)) return `The learner did not answer. Give one short hint that names the idea to use, then reveal the right answer.${visual}`;
    const choice = answer.id ? check.choices.find((item) => item.id === answer.id) : null;
    if (choice?.correct) return `The learner chose "${choice.label}", which is right. Confirm it in one sentence, then show why it is right.${visual}`;
    if (choice) {
        const why = choice.misconception || "they picked a plausible but incorrect idea";
        return `The learner chose "${choice.label}", which is wrong. Misconception: ${why}. Explicitly name that specific mistake in your own words, then reveal the right answer ("${rightLabel}").${visual} Do not just say try again.`;
    }
    return `The learner said "${said}", which is not one of the choices. Treat it as their prediction. If it is wrong, explicitly name the specific mix-up, then reveal the right answer ("${rightLabel}").${visual}`;
}

// Shows a check and resolves when the learner clicks or speaks, or when the wait times out.
export function createCheckWaiter({ show, pick, timeoutMs = 90_000 } = {}) {
    let pending = null;
    const finish = (answer) => {
        if (!pending) return false;
        clearTimeout(pending.timer);
        const resolve = pending.resolve;
        pending = null;
        resolve(answer);
        return true;
    };
    return {
        get open() {
            return Boolean(pending);
        },
        async ask(check) {
            await show?.(check);
            return new Promise((resolve) => {
                const timer = setTimeout(() => finish(null), timeoutMs);
                pending = { check, resolve, timer };
            });
        },
        answer(value) {
            if (!pending) return false;
            const choice = pending.check.choices.find((item) => item.id === value?.id);
            const answer = choice ? { id: choice.id, label: choice.label, via: value?.via ?? "click", correct: choice.correct } : null;
            pick?.(answer);
            return finish(answer);
        },
        answerText(text) {
            if (!pending) return false;
            const choice = matchChoice(pending.check.choices, text);
            if (choice) return this.answer({ id: choice.id, via: "voice" });
            pick?.(null);
            return finish({ id: null, label: String(text ?? "").trim(), via: "voice", say: String(text ?? "").trim() });
        },
    };
}
