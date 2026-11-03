// One paired, scenario-level decision report for a candidate and its baseline.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns, loadResults, sameCodeControl } from "./stats.mjs";

const signed = (value, digits = 2) => (value == null ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`);
const range = (result, scale = 1, unit = "") => (result?.interval ? `[${result.interval.map((value) => `${signed(value * scale)}${unit}`).join(", ")}]` : "[insufficient scenarios]");
const compare = (left, right, metric, bootstrap) => {
    try {
        return compareRuns(left, right, { metric, bootstrap });
    } catch (error) {
        if (!error.message.startsWith("no shared scenarios")) throw error;
        return null;
    }
};
const control = (runs, metric, bootstrap) => {
    try {
        return sameCodeControl(runs, { metric, bootstrap });
    } catch (error) {
        if (!error.message.startsWith("no shared scenarios")) throw error;
        return null;
    }
};

export function checkMeasurement(summaries) {
    if (new Set(summaries.map((summary) => summary.judge)).size > 1) throw new Error("judge models differ between arms; rejudge both before comparing");
    if (new Set(summaries.map((summary) => summary.measurement).filter(Boolean)).size > 1) throw new Error("measurement code differs between arms; rejudge or replay both before comparing");
    return summaries.some((summary) => !summary.measurement) ? "Measurement version was not recorded on every label; verify identical judge, harness and fixtures before merging." : null;
}

export function integrationReport(candidate, baseline, { controls = {}, top = 3, bootstrap = 6000 } = {}) {
    const score = compareRuns(candidate, baseline, { bootstrap });
    const ids = new Set(score.perScenario.map(({ id }) => id));
    const [left, right] = [candidate, baseline].map((runs) => runs.filter((run) => ids.has(run.scenario)));
    const metrics = (a, b) => ({
        score: compare(a, b, "score", bootstrap),
        pass: compare(a, b, "pass", bootstrap),
        firstWords: compare(a, b, "metrics.firstWords", bootstrap),
        firstVisual: compare(a, b, "metrics.firstVisual", bootstrap),
        total: compare(a, b, "metrics.total", bootstrap),
    });
    const categories = [...new Set(score.perScenario.map((row) => row.category))].sort().map((category) => ({
        category,
        ...metrics(left.filter((run) => run.category === category), right.filter((run) => run.category === category)),
    }));
    const ranked = [...score.perScenario].sort((a, b) => a.delta - b.delta);
    return {
        overall: metrics(left, right),
        categories,
        regressions: ranked.filter((row) => row.delta < 0).slice(0, top),
        improvements: ranked.reverse().filter((row) => row.delta > 0).slice(0, top),
        nulls: Object.entries(controls).map(([label, runs]) => ({ label, score: control(runs, "score", bootstrap), firstVisual: control(runs, "metrics.firstVisual", bootstrap) })),
        unpaired: score.perScenario.filter((row) => row.runs.includes(1)).length,
    };
}

export function printIntegration(report, candidate, baseline) {
    const delta = (result, scale = 1, unit = "") => result ? `${signed(result.delta * scale)}${unit} ${range(result, scale, unit)}` : "-";
    const row = (name, value) => {
        const { score, pass, firstWords, firstVisual, total } = value;
        const paired = (result, scale = 1, unit = "") => `${delta(result, scale, unit)}${result && result.scenarios < score.scenarios ? ` (${result.scenarios} paired)` : ""}`;
        console.log(`${name} (${score.scenarios} scenarios; ${score.runs.join("/")} runs): score ${score.means.map((n) => n.toFixed(2)).join(" vs ")} Δ${delta(score)}; pass ${pass ? `${pass.means.map((n) => `${(n * 100).toFixed(0)}%`).join(" vs ")} Δ${paired(pass, 100, "pp")}` : "-"}`);
        console.log(`  Latency Δ first words ${paired(firstWords, 0.001, "s")}; first visual ${paired(firstVisual, 0.001, "s")}; done ${paired(total, 0.001, "s")}`);
    };
    console.log(`Integration: ${candidate} (candidate) vs ${baseline} (baseline); paired scenario means and 95% bootstrap CIs; negative latency is faster.`);
    row("Overall", report.overall);
    for (const { category, ...value } of report.categories) row(category, value);
    for (const [title, rows] of [["Top regressions", report.regressions], ["Top improvements", report.improvements]]) {
        console.log(`${title}: ${rows.length ? rows.map((row) => `${row.id} ${signed(row.delta)} (${row.runs.join("/")} runs)`).join("; ") : "none"}`);
    }
    console.log("Null controls (same code, attempt 2 minus attempt 1):");
    for (const { label, score, firstVisual } of report.nulls) console.log(`  ${label}: score ${delta(score)}; first visual ${delta(firstVisual, 0.001, "s")}`);
    if (report.unpaired) console.log(`${report.unpaired} shared scenarios have only one attempt in at least one arm; CIs cannot capture model-run variability there.`);
    if (report.nulls.some((entry) => entry.score)) console.log("Null intervals have only one attempt per side and cannot rule out model-wide drift.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const topAt = args.indexOf("--top");
    const repeatsAt = args.indexOf("--repeats");
    if (args[1] !== "vs" || !args[2] || args.some((arg) => arg.startsWith("--") && !["--top", "--repeats"].includes(arg))) throw new Error("usage: node evals/integration.mjs candidate[+label] vs baseline[+label] [--top N] [--repeats N]");
    const top = topAt < 0 ? 3 : Number(args[topAt + 1]);
    const repeats = repeatsAt < 0 ? Infinity : Number(args[repeatsAt + 1]);
    if (!Number.isInteger(top) || top < 1 || !(repeats >= 1)) throw new Error("--top and --repeats must be positive");
    const labels = [...new Set([args[0], args[2]].flatMap((group) => group.split("+")))];
    for (const label of labels) if (!/^[\w.-]+$/.test(label) || label.startsWith(".")) throw new Error(`invalid eval label: ${label}`);
    const summaries = labels.map((label) => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "results", label, "summary.json"), "utf8")));
    const warning = checkMeasurement(summaries);
    const options = { repeats };
    const controls = Object.fromEntries(labels.map((label) => [label, loadResults(label, options)]));
    if (warning) console.log(`WARNING: ${warning}`);
    printIntegration(integrationReport(loadResults(args[0], options), loadResults(args[2], options), { top, controls }), args[0], args[2]);
}
