// Scripted learner for tutor evals. Kept in its own module so multi-turn harness work can land beside it.
import { matchChoice } from "../src/main/tutor.mjs";

// The next scripted click or spoken answer for this check. pick "wrong" selects a wrong choice the model offered.
export function scriptedAnswer(scenario, check, asked = 0) {
    const steps = Array.isArray(scenario?.learner) ? scenario.learner : [];
    const step = steps[asked] ?? steps.at(-1) ?? { pick: "wrong" };
    const choices = Array.isArray(check?.choices) ? check.choices : [];
    if (step.say) {
        const matched = matchChoice(choices, step.say);
        return matched ? { id: matched.id, label: matched.label, via: "voice" } : { id: null, label: String(step.say), via: "voice", say: String(step.say) };
    }
    if (step.pick === "right") {
        const choice = choices.find((item) => item.correct);
        return choice ? { id: choice.id, label: choice.label, via: "click" } : null;
    }
    const wanted = step.match instanceof RegExp ? step.match : null;
    const wrong = choices.filter((item) => !item.correct);
    const choice = (wanted && wrong.find((item) => wanted.test(`${item.label} ${item.misconception ?? ""}`))) || wrong[0] || choices[0];
    return choice ? { id: choice.id, label: choice.label, via: "click" } : null;
}

// Records what the judge needs: the question, the scripted answer, and the misconception that answer reveals.
export function recordCheck(scenario, check, asked) {
    const answer = scriptedAnswer(scenario, check, asked);
    const chosen = answer?.id ? check.choices.find((item) => item.id === answer.id) : null;
    return {
        answer,
        entry: {
            question: check.question,
            correctLabel: check.choices.find((item) => item.correct)?.label ?? "",
            misconception: chosen && !chosen.correct ? chosen.misconception : "",
            answer: answer ? { id: answer.id, label: answer.label || answer.say || "", via: answer.via, correct: Boolean(chosen?.correct) } : null,
        },
    };
}
