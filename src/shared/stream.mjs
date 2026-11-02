// Reads a tool call's JSON arguments while they stream in, reporting each top-level field once its value is complete
// and each object in one list field as soon as it closes, so work can start before the call is finished.
export class ArgumentStream {
    #text = "";
    #at = 0;
    #depth = 0;
    #string = -1;
    #escape = false;
    #expect = "key";
    #key = null;
    #start = -1;
    #item = -1;

    constructor(list) {
        this.list = list;
    }

    // Appends a chunk and returns what it completed, in order: { key, json } for fields and { key, json, item: true } for list items.
    push(chunk) {
        this.#text += chunk;
        const text = this.#text;
        const done = [];
        const field = (end) => {
            done.push({ key: this.#key, json: text.slice(this.#start, end).trim() });
            this.#expect = "comma";
        };
        for (; this.#at < text.length; this.#at++) {
            const i = this.#at;
            const c = text[i];
            if (this.#string >= 0) {
                if (this.#escape) this.#escape = false;
                else if (c === "\\") this.#escape = true;
                else if (c === '"') {
                    const start = this.#string;
                    this.#string = -1;
                    if (this.#depth !== 1) continue;
                    if (this.#expect === "key") [this.#key, this.#expect] = [JSON.parse(text.slice(start, i + 1)), "colon"];
                    else if (this.#expect === "string") field(i + 1);
                }
                continue;
            }
            if (c === '"') {
                this.#string = i;
                if (this.#depth === 1 && this.#expect === "value") [this.#start, this.#expect] = [i, "string"];
            } else if (c === "{" || c === "[") {
                if (this.#depth === 1 && this.#expect === "value") [this.#start, this.#expect] = [i, "nested"];
                else if (this.#depth === 2 && c === "{" && this.#key === this.list && text[this.#start] === "[") this.#item = i;
                this.#depth++;
            } else if (c === "}" || c === "]") {
                if (this.#depth === 1 && this.#expect === "primitive") field(i);
                this.#depth--;
                if (this.#depth === 2 && this.#item >= 0) {
                    done.push({ key: this.#key, json: text.slice(this.#item, i + 1), item: true });
                    this.#item = -1;
                } else if (this.#depth === 1 && this.#expect === "nested") field(i + 1);
            } else if (this.#depth === 1) {
                if (c === ":" && this.#expect === "colon") this.#expect = "value";
                else if (c === ",") {
                    if (this.#expect === "primitive") field(i);
                    this.#expect = "key";
                } else if (this.#expect === "value" && !/\s/.test(c)) [this.#start, this.#expect] = [i, "primitive"];
            }
        }
        return done;
    }
}
