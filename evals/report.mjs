// Summarises eval runs and compares them side by side for hill climbing (npm run eval:report -- label [label...]).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const mean = (values) => {
    const list = values.filter((value) => Number.isFinite(value));
    return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
};

const median = (values) => {
    const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    return list.length ? (list[Math.floor((list.length - 1) / 2)] + list[Math.ceil((list.length - 1) / 2)]) / 2 : null;
};

const number = (value) => (value == null ? NaN : Number(value));

// Scenario scores average their repeats; categories and the overall score average scenarios; speed is the median over runs.
export function summarize(label, results, info) {
    const scenarios = Object.fromEntries(
        Object.entries(Object.groupBy(results, (r) => r.scenario)).map(([id, runs]) => {
            const metric = (key) => mean(runs.map((r) => number(r.metrics[key])));
            const s = { category: runs[0].category, score: mean(runs.map((r) => r.score)), pass: mean(runs.map((r) => number(r.pass))), mediaMatch: metric("mediaMatch"), firstVisual: metric("firstVisual"), total: metric("total") };
            return [id, { ...s, overlaps: metric("boardOverlaps"), covered: metric("targetCovered"), failedTools: metric("failedTools") }];
        }),
    );
    const categories = Object.fromEntries(Object.entries(Object.groupBy(Object.values(scenarios), (s) => s.category)).map(([name, list]) => [name, mean(list.map((s) => s.score))]));
    const speed = Object.fromEntries(["firstWords", "firstVisual", "total"].map((key) => [key, median(results.map((r) => number(r.metrics[key])))]));
    return { label, ...info, at: new Date().toISOString(), overall: mean(Object.values(scenarios).map((s) => s.score)), passRate: mean(results.map((r) => number(r.pass))), speed, categories, scenarios, results };
}

export function printReport(summaries) {
    const fixed = (value, digits = 2) => (value == null ? "-" : value.toFixed(digits));
    const row = (name, values, format = fixed) => `${name.padEnd(30)}${values.map((value) => format(value).padStart(14)).join("")}`;
    const seconds = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`);
    const lines = [`${"".padEnd(30)}${summaries.map((s) => s.label.slice(-13).padStart(14)).join("")}`, row("overall", summaries.map((s) => s.overall))];
    for (const category of new Set(summaries.flatMap((s) => Object.keys(s.categories)))) lines.push(row(`  ${category}`, summaries.map((s) => s.categories[category])));
    lines.push(row("pass rate (every criterion 4+)", summaries.map((s) => s.passRate), (value) => (value == null ? "-" : `${Math.round(value * 100)}%`)));
    for (const [key, name] of [["firstWords", "first words"], ["firstVisual", "first visual"], ["total", "done"]]) lines.push(row(`median ${name}`, summaries.map((s) => s.speed?.[key]), seconds));
    lines.push("", "Scenarios (metrics from the last run: expected media, first visual, total time, board overlaps, target covered)");
    const last = summaries.at(-1);
    for (const id of new Set(summaries.flatMap((s) => Object.keys(s.scenarios)))) {
        const s = last.scenarios[id];
        const extra = s ? `   ${s.mediaMatch === 1 ? "media" : "MEDIA"} ${seconds(s.firstVisual).padStart(6)} ${seconds(s.total).padStart(6)}  ${fixed(s.overlaps, 0)} ${fixed(s.covered, 0)}%` : "";
        lines.push(row(`${id} (${summaries.find((x) => x.scenarios[id]).scenarios[id].category})`, summaries.map((x) => x.scenarios[id]?.score)) + extra);
    }
    console.log(lines.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    printReport(process.argv.slice(2).map((label) => JSON.parse(fs.readFileSync(path.join(here, "results", label, "summary.json"), "utf8"))));
}
