// Summarises eval runs and compares them side by side for hill climbing (npm run eval:report -- label [label...]).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const mean = (values) => {
    const list = values.filter((value) => Number.isFinite(value));
    return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
};

// Scenario scores average their repeats; categories and the overall score average scenarios.
export function summarize(label, results, info) {
    const scenarios = Object.fromEntries(
        Object.entries(Object.groupBy(results, (r) => r.scenario)).map(([id, runs]) => {
            const metric = (key) => mean(runs.map((r) => (r.metrics[key] == null ? NaN : Number(r.metrics[key]))));
            const s = { category: runs[0].category, score: mean(runs.map((r) => r.score)), mediaMatch: metric("mediaMatch"), firstVisual: metric("firstVisual"), total: metric("total") };
            return [id, { ...s, overlaps: metric("boardOverlaps"), covered: metric("targetCovered"), failedTools: metric("failedTools") }];
        }),
    );
    const categories = Object.fromEntries(Object.entries(Object.groupBy(Object.values(scenarios), (s) => s.category)).map(([name, list]) => [name, mean(list.map((s) => s.score))]));
    return { label, ...info, at: new Date().toISOString(), overall: mean(Object.values(scenarios).map((s) => s.score)), categories, scenarios, results };
}

export function printReport(summaries) {
    const number = (value, digits = 2) => (value == null ? "-" : value.toFixed(digits));
    const row = (name, values) => `${name.padEnd(30)}${values.map((value) => number(value).padStart(14)).join("")}`;
    const lines = [`${"".padEnd(30)}${summaries.map((s) => s.label.slice(-13).padStart(14)).join("")}`, row("overall", summaries.map((s) => s.overall))];
    for (const category of new Set(summaries.flatMap((s) => Object.keys(s.categories)))) lines.push(row(`  ${category}`, summaries.map((s) => s.categories[category])));
    lines.push("", "Scenarios (metrics from the last run: expected media, first visual, total time, board overlaps, target covered)");
    const last = summaries.at(-1);
    for (const id of new Set(summaries.flatMap((s) => Object.keys(s.scenarios)))) {
        const s = last.scenarios[id];
        const seconds = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(0)}s`);
        const extra = s ? `   ${s.mediaMatch === 1 ? "media" : "MEDIA"} ${seconds(s.firstVisual).padStart(4)} ${seconds(s.total).padStart(4)}  ${number(s.overlaps, 0)} ${number(s.covered, 0)}%` : "";
        lines.push(row(`${id} (${summaries.find((x) => x.scenarios[id]).scenarios[id].category})`, summaries.map((x) => x.scenarios[id]?.score)) + extra);
    }
    console.log(lines.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    printReport(process.argv.slice(2).map((label) => JSON.parse(fs.readFileSync(path.join(here, "results", label, "summary.json"), "utf8"))));
}
