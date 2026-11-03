// Reports completed fields and list objects before the rest of a tool call has arrived.
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
    #child = null;

    constructor(list, nested = {}) {
        this.list = list;
        this.nested = nested;
    }

    // Completed values carry key and json, plus item for list entries and field for a nested object's fields.
    push(chunk) {
        this.#text += chunk;
        const text = this.#text;
        const done = [];
        const flush = (end) => {
            const child = this.#child;
            if (!child) return;
            for (const entry of child.reader.push(text.slice(child.at, end))) done.push({ ...entry, key: child.key, field: entry.key });
            child.at = end;
        };
        const field = (end) => {
            flush(end);
            this.#child = null;
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
                if (this.#depth === 1 && this.#expect === "value") {
                    [this.#start, this.#expect] = [i, "nested"];
                    if (c === "{" && Object.hasOwn(this.nested, this.#key)) this.#child = { key: this.#key, at: i, reader: new ArgumentStream(this.nested[this.#key]) };
                }
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
        flush(text.length);
        return done;
    }
}
