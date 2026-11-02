// Diagnoses the native helper: build, permissions, app context, screen capture and voices.
import fs from "node:fs";
import path from "node:path";
import { MODELS_DIR } from "../src/main/config.mjs";
import { Helper } from "../src/main/helper.mjs";

// Usage: npm run doctor [-- --inherit] [-- --speak]
const inherit = process.argv.includes("--inherit");
const speak = process.argv.includes("--speak");
const helper = new Helper({ inheritPermissions: inherit });
const report = (tag) => (label, detail = "") => console.log(`  ${tag.padEnd(6)}${label}${detail ? `: ${detail}` : ""}`);
const [ok, bad, note] = [report("ok"), report("FAIL"), report("--")];
const OPTIONAL = { control: "optional, lets Ink Brain operate your Mac after you approve" };

try {
    const ping = await helper.request("ping");
    ok("helper running", `pid ${ping.pid}, permissions ${ping.responsible === "self" ? "owned by Ink Brain Helper" : "inherited from the launching app"}`);

    const permissions = await helper.request("permissions");
    for (const [name, state] of Object.entries(permissions)) {
        if (state === "granted") ok(`${name} permission`, state);
        else (OPTIONAL[name] ? note : bad)(`${name} permission`, OPTIONAL[name] ? `${state} (${OPTIONAL[name]})` : state);
    }

    const front = await helper.request("frontmost", { excludePids: [process.pid] });
    ok("frontmost app", `${front.app || "?"}${front.title ? ` - "${front.title}"` : ""}`);

    const voices = await helper.request("voices");
    const best = voices.find((v) => v.quality === "premium") ?? voices.find((v) => v.quality === "enhanced");
    ok("voices", `${voices.length} English voices${best ? `, best: ${best.name} (${best.quality})` : " (download an Enhanced or Premium voice for nicer speech)"}`);
    const kokoro = path.join(MODELS_DIR, "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx");
    const cached = fs.existsSync(kokoro) && fs.readdirSync(kokoro).some((file) => file.endsWith(".onnx"));
    (cached ? ok : note)("neural voice", cached ? `Kokoro model cached in ${MODELS_DIR}` : "downloads about 99 MB on first launch; Apple voices are used until it is ready");

    if (permissions.screen === "granted") {
        const started = Date.now();
        const shot = await helper.request("capture", { maxLongEdge: 1600, format: "jpeg", quality: 0.8 }, { timeoutMs: 20_000 });
        ok("screen capture", `${shot.width}x${shot.height} px of a ${shot.pointWidth}x${shot.pointHeight} pt display, ${Math.round((shot.data.length * 3) / 4 / 1024)} KB, ${Date.now() - started} ms`);
    } else {
        bad("screen capture", "skipped until Screen Recording is granted");
    }

    if (speak) {
        const ended = new Promise((resolve) => helper.once("tts.end", resolve));
        await helper.request("speak", { text: "Ink Brain is ready.", utterance: "doctor" });
        await ended;
        ok("speech output");
    }
} catch (error) {
    bad("doctor", error.message);
    process.exitCode = 1;
} finally {
    helper.stop();
}
