import assert from "node:assert/strict";
import { test } from "node:test";
import { clearStaleGrants } from "../src/main/helper.mjs";

test("stale grant cleanup never clears a granted permission or the ones macOS re-prompts for", async () => {
    const cleared = [];
    const reset = async (service) => cleared.push(service);
    await clearStaleGrants({ screen: "missing", control: "granted", microphone: "denied", speech: "notDetermined" }, reset);
    await clearStaleGrants({ screen: "granted", control: "missing", microphone: "granted", speech: "granted" }, reset);
    assert.deepEqual(cleared, ["ScreenCapture", "PostEvent"]);
});
