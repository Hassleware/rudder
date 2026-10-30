// Thumbnail benchmark, scoring + calibration (CPU). Every thumbnail went through Gemma under the neutral title
// "My weekend vlog"; this scores its image tokens' layer-7 states with each text filter's probe.
// Calibration uses only the ordinary "calib" thumbnails (15 real + 5 neutral text): per filter, the image score's mean
// and spread there, then one global threshold. Everything else is test.
// Usage: node research/thumb-bench.mjs <dir with thumb-index.json, thumb-probes.json, acts/thumb_*.bin>
import { readFileSync } from "node:fs";
import { auroc } from "../extension/bench/metrics.js";

const DIR = process.argv[2], D = 1536;
const items = JSON.parse(readFileSync(`${DIR}/thumb-index.json`)), probes = JSON.parse(readFileSync(`${DIR}/thumb-probes.json`));
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, sd = (xs) => Math.sqrt(avg(xs.map((x) => (x - avg(xs)) ** 2))) || 1;
const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
const pc = (x) => (100 * x).toFixed(0).padStart(3) + "%";

// per thumbnail and filter: z of every image token (tokens 1..n; 0 = <|image>, n+1 = <image|>, then the title)
const AGG = {
  peak: (zs) => Math.max(...zs),
  top3: (zs) => avg([...zs].sort((a, b) => b - a).slice(0, 3)),
  mean: (zs) => avg(zs),
};
const z = {};
for (const it of items) {
  const b = readFileSync(`${DIR}/acts/thumb_${it.key}.bin`), x = new Float16Array(b.buffer, b.byteOffset, b.length / 2);
  z[it.key] = {};
  for (const [f, p] of Object.entries(probes)) {
    const zs = [];
    for (let t = 1; t <= it.n; t++) { let d = p.b; for (let i = 0; i < D; i++) d += x[t * D + i] * p.w[i]; zs.push(d / p.sd); }
    z[it.key][f] = zs;
  }
}
const calib = items.filter((it) => it.split === "calib"), test = items.filter((it) => it.split !== "calib");
const role = (it, f) => it.topic === f ? { pos: "on-topic photo", text: "on-topic text only", look: "look-alike" }[it.kind] : it.kind.startsWith("text") || it.kind === "ordinary" ? (it.topic ? "other topic" : "ordinary") : "other topic";
const ROLES = ["on-topic photo", "on-topic text only", "look-alike", "other topic", "ordinary"];

function evaluate(agg, mode, q) {
  // calibration: per filter, the score's mean/spread on ordinary calib thumbnails; then one global threshold
  const cal = {};
  for (const f of Object.keys(probes)) { const v = calib.map((it) => AGG[agg](z[it.key][f])); cal[f] = mode === "raw" ? { mu: 0, s: 1 } : { mu: avg(v), s: mode === "z" ? sd(v) : 1 }; }
  const score = (it, f) => (AGG[agg](z[it.key][f]) - cal[f].mu) / cal[f].s;
  const tau = pct(Object.keys(probes).flatMap((f) => calib.map((it) => score(it, f))), q);
  const by = Object.fromEntries(ROLES.map((r) => [r, []])), aucs = [];
  for (const f of Object.keys(probes)) {
    const pos = [], neg = [];
    for (const it of test) { const r = role(it, f), s = score(it, f); by[r].push(s > tau); (r.startsWith("on-topic") ? pos : neg).push(s); }
    aucs.push(auroc(pos, neg));
  }
  return { agg, mode, q, tau, auc: avg(aucs), rates: Object.fromEntries(ROLES.map((r) => [r, avg(by[r].map(Number))])), score };
}
const line = (r) => `${`${r.agg} | ${r.mode === "raw" ? "no image calibration" : r.mode === "z" ? "mean+spread per filter" : "mean per filter"} | calib ${pc(1 - r.q)} fire`.padEnd(58)} threshold ${r.tau.toFixed(2).padStart(6)}  AUROC ${r.auc.toFixed(3)} | ` + ROLES.map((k) => `${k} ${pc(r.rates[k])}`).join("  ");

console.log(`${items.length} thumbnails: ${calib.length} calibration, ${test.length} test; ${Object.keys(probes).length} text filters.\n`);
const all = [];
for (const agg of Object.keys(AGG)) for (const mode of ["raw", "mean", "z"]) for (const q of [0.95, 1]) all.push(evaluate(agg, mode, q));
for (const r of all) console.log(line(r));
const best = all.filter((r) => r.q === 0.95).sort((a, b) => b.auc - a.auc)[0];
console.log(`\nBEST by AUROC: ${line(best)}\n`);
// per thumbnail detail for the best setup: own-topic scores, and the highest-scoring wrong filter
for (const it of test.filter((x) => x.topic)) {
  const own = best.score(it, it.topic), others = Object.keys(probes).filter((f) => f !== it.topic).map((f) => [f, best.score(it, f)]).sort((a, b) => b[1] - a[1])[0];
  console.log(`${(it.kind === "pos" ? "photo" : it.kind === "text" ? "TEXT " : "look ").padEnd(6)} ${it.topic.padEnd(9)} own ${own.toFixed(1).padStart(5)} ${own > best.tau ? "FIRES" : "     "} | top other ${others[0]} ${others[1].toFixed(1)} | ${JSON.stringify(it.title).slice(0, 70)}`);
}
const ordFires = test.filter((it) => !it.topic).flatMap((it) => Object.keys(probes).filter((f) => best.score(it, f) > best.tau).map((f) => `${f} on ${JSON.stringify(it.title).slice(0, 50)}`));
console.log(`\nordinary test thumbnails that fired (${ordFires.length}): ${ordFires.join("; ") || "none"}`);
