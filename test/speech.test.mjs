import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechChunker, toSpeakable } from "../src/shared/speech.mjs";

test("toSpeakable drops code, links and markdown syntax", () => {
    const markdown = "## Fix\nRun `npm test` then see [the docs](https://example.com).\n```js\nconst x = 1;\n```\n- **Bold** item";
    assert.equal(toSpeakable(markdown), "Fix Run npm test then see the docs. Bold item");
});

test("chunker emits complete sentences as they stream and holds partial ones", () => {
    const chunker = new SpeechChunker();
    assert.deepEqual(chunker.push("That button saves your"), []);
    assert.deepEqual(chunker.push(" work. The other one"), ["That button saves your work."]);
    assert.deepEqual(chunker.push(" costs 3.5 dollars"), []);
    assert.deepEqual(chunker.flush(), ["The other one costs 3.5 dollars"]);
});

test("chunker never speaks code blocks split across deltas", () => {
    const chunker = new SpeechChunker();
    const spoken = [...chunker.push("Here is the fix.\n```py\nprint('a"), ...chunker.push("')\n```\nRun it again."), ...chunker.flush()];
    assert.deepEqual(spoken, ["Here is the fix.", "Run it again."]);
});

test("chunker stops speaking after the character budget", () => {
    const chunker = new SpeechChunker({ maxChars: 30 });
    const spoken = [...chunker.push("This first sentence is long enough. This one is skipped. "), ...chunker.flush()];
    assert.deepEqual(spoken, ["This first sentence is long enough."]);
});
