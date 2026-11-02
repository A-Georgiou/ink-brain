// Turns streamed Markdown replies into short, speakable sentences for text-to-speech.

export function toSpeakable(markdown) {
    return markdown
        .replace(/```[\s\S]*?(?:```|$)/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/^\s*\|.*$/gm, " ")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1")
        .replace(/~~(.+?)~~/g, "$1")
        .replace(/\*/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Index just past the first sentence or line end outside a code fence with minChars to say, or -1.
export function findBoundary(text, minChars = 12) {
    let inFence = false;
    for (let i = 0; i < text.length; i++) {
        if (text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
            inFence = !inFence;
            i += 2;
            continue;
        }
        if (inFence) continue;
        const ch = text[i];
        const next = text[i + 1];
        const isEnd = ch === "\n" || (".!?:;".includes(ch) && next !== undefined && /\s/.test(next));
        if (isEnd && toSpeakable(text.slice(0, i + 1)).length >= minChars) return i + 1;
    }
    return -1;
}

export class SpeechChunker {
    #pending = "";
    #spoken = 0;

    constructor({ maxChars = 700, minChars = 12 } = {}) {
        this.maxChars = maxChars;
        this.minChars = minChars;
    }

    push(delta) {
        this.#pending += delta;
        const out = [];
        let cut;
        while ((cut = findBoundary(this.#pending, this.minChars)) > 0) {
            this.#take(this.#pending.slice(0, cut), out);
            this.#pending = this.#pending.slice(cut);
        }
        return out;
    }

    flush() {
        const out = [];
        this.#take(this.#pending, out);
        this.#pending = "";
        return out;
    }

    #take(piece, out) {
        const text = toSpeakable(piece);
        if (!text || this.#spoken >= this.maxChars) return;
        this.#spoken += text.length;
        out.push(text);
    }
}
