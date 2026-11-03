// Compare repeated evals by scenario rather than treating runs of one scenario as independent tasks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreOf, judgeDisagreement } from "./judge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const se = (values) => (values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length * (values.length - 1))) : null);
const fixed = (value) => (value == null ? "-" : value.toFixed(2));
const signed = (value) => (value == null ? "-" : `${value >= 0 ? "+" : ""}${fixed(value)}`);
const quantile = (sorted, p) => {
    const at = p * (sorted.length - 1);
    const i = Math.floor(at);
    return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (at - i);
};
const random = (seed) => () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);

const valueOf = (run, metric) => {
    const value = metric === "score" ? run.score : metric === "pass" ? Number(run.pass) : metric.startsWith("metrics.") ? run.metrics?.[metric.slice(8)] : run.scores?.[metric];
    return Number.isFinite(value) ? value : null;
};

const group = (runs, metric) => {
    const grouped = new Map();
    for (const run of runs) {
        const value = valueOf(run, metric);
        if (value == null) continue;
        const entry = grouped.get(run.scenario) ?? { category: run.category, values: [] };
        if (entry.category !== run.category) throw new Error(`category changed for ${run.scenario}`);
        entry.values.push(value);
        grouped.set(run.scenario, entry);
    }
    return grouped;
};

// Bootstrap scenarios together, then independently resample each side's model attempts within each scenario.
export function compareRuns(left, right, { metric = "score", bootstrap = 6000, seed = 41 } = {}) {
    const [L, R] = [group(left, metric), group(right, metric)];
    const ids = [...L.keys()].filter((id) => R.has(id)).sort();
    if (!ids.length) throw new Error(`no shared scenarios with ${metric}`);
    for (const id of ids) if (L.get(id).category !== R.get(id).category) throw new Error(`category changed for ${id}`);
    const pairs = ids.map((id) => ({ id, category: L.get(id).category, left: L.get(id).values, right: R.get(id).values }));
    const scenarioMeans = pairs.map(({ left: a, right: b }) => [mean(a), mean(b)]);
    const deltas = scenarioMeans.map(([a, b]) => a - b);
    const meanSE = [se(scenarioMeans.map(([a]) => a)), se(scenarioMeans.map(([, b]) => b))];
    const result = {
        metric,
        scenarios: pairs.length,
        runs: [pairs.reduce((n, p) => n + p.left.length, 0), pairs.reduce((n, p) => n + p.right.length, 0)],
        means: [mean(scenarioMeans.map(([a]) => a)), mean(scenarioMeans.map(([, b]) => b))],
        meanSE,
        delta: mean(deltas),
        pairedSE: se(deltas),
        unpairedSE: pairs.length < 2 ? null : Math.hypot(...meanSE),
        wins: deltas.filter((d) => d > 0).length,
        ties: deltas.filter((d) => d === 0).length,
        losses: deltas.filter((d) => d < 0).length,
        perScenario: pairs.map((p, i) => ({ id: p.id, category: p.category, delta: deltas[i], runs: [p.left.length, p.right.length] })),
        interval: null,
        probabilityPositive: null,
    };
    if (pairs.length < 2 || bootstrap < 1) return result;
    const draw = random(seed);
    const samples = Array.from({ length: bootstrap }, () => {
        let total = 0;
        for (let i = 0; i < pairs.length; i++) {
            const { left: a, right: b } = pairs[Math.floor(draw() * pairs.length)];
            let x = 0;
            let y = 0;
            for (let j = 0; j < a.length; j++) x += a[Math.floor(draw() * a.length)];
            for (let j = 0; j < b.length; j++) y += b[Math.floor(draw() * b.length)];
            total += x / a.length - y / b.length;
        }
        return total / pairs.length;
    });
    result.probabilityPositive = samples.filter((value) => value > 0).length / samples.length;
    samples.sort((a, b) => a - b);
    result.interval = [quantile(samples, 0.025), quantile(samples, 0.975)];
    return result;
}

export function loadResults(labels, { repeats = Infinity } = {}) {
    return labels.split("+").flatMap((label) => {
        if (!/^[\w.-]+$/.test(label) || label.startsWith(".")) throw new Error(`invalid eval label: ${label}`);
        const file = path.join(here, "results", label, "summary.json");
        const results = JSON.parse(fs.readFileSync(file, "utf8")).results;
        return results.filter((run) => Number(run.id.match(/~(\d+)$/)?.[1] ?? 1) <= repeats);
    });
}

export function sameCodeControl(runs, options) {
    const first = runs.filter((run) => !/~\d+$/.test(run.id));
    const second = runs.filter((run) => run.id.endsWith("~2"));
    const shared = new Set(first.map((run) => run.scenario));
    if (!second.some((run) => shared.has(run.scenario))) return null;
    return compareRuns(second, first, options);
}

function printComparison(name, a, b, options) {
    const r = compareRuns(a, b, options);
    const bounds = r.interval ? `[${signed(r.interval[0])}, ${signed(r.interval[1])}]` : "-";
    console.log(`${name}: ${r.scenarios} shared scenarios, ${r.runs.join("/")} runs, ${r.means.map((value, i) => `${fixed(value)} +/- ${fixed(r.meanSE[i])}`).join(" vs ")}, delta ${signed(r.delta)} +/- ${fixed(r.pairedSE)} SE, 95% CI ${bounds}, ${r.wins}/${r.ties}/${r.losses} wins/ties/losses`);
    return r;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
    const split = args.indexOf("vs");
    if (split !== 1 || !args[2]) throw new Error("usage: node evals/stats.mjs candidate[+label] vs baseline[+label] [--repeats N] [--metric score|fidelity|metrics.firstVisual]");
    const repeats = Number(option("--repeats", Infinity));
    if (!(repeats >= 1)) throw new Error("--repeats must be at least 1");
    const [left, right] = [loadResults(args[0], { repeats }), loadResults(args[2], { repeats })];
    const metric = option("--metric", "score");
    const options = { metric };
    const matched = printComparison(`${args[0]} vs ${args[2]}`, left, right, options);
    console.log(`  Unpaired scenario SE ${fixed(matched.unpairedSE)}; judge disagreements ${[left, right].map((runs) => {
        const judged = runs.filter((run) => run.judges?.length);
        return `${judged.filter((run) => judgeDisagreement(run).flagged).length}/${judged.length}`;
    }).join(" vs ")}`);
    if (metric === "score") {
        for (const category of new Set(matched.perScenario.map((row) => row.category))) {
            const [a, b] = [left, right].map((runs) => runs.filter((run) => run.category === category));
            printComparison(`  ${category}`, a, b, options);
            printComparison(`  ${category} ${coreOf(category)}`, a, b, { metric: coreOf(category) });
        }
    }
    for (const { id, delta, runs } of matched.perScenario) console.log(`  ${id.padEnd(22)} ${signed(delta)} (${runs.join("/")} runs)`);
    let controls = 0;
    for (const label of new Set([args[0], args[2]].flatMap((group) => group.split("+")))) {
        const control = sameCodeControl(loadResults(label), options);
        if (control) {
            controls++;
            console.log(`  Null control ${label}, attempt 2 minus 1: ${signed(control.delta)}, 95% CI ${control.interval ? `[${control.interval.map(signed).join(", ")}]` : "-"}`);
        }
    }
    if (controls) console.log("  Null controls use one attempt per side; their intervals cannot rule out model-wide run drift.");
    if (repeats === 1) console.log("  Only one attempt per scenario: the interval does not capture model-run variability.");
}
