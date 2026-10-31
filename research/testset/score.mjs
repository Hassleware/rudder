// Rudder test set, step 4 (CPU, seconds): score the cached model outputs (features.mjs) as hide/show pipelines.
// Thresholds are tuned on the dev half only; results are on the test half (the user's screenshot is always test).
// Usage: node score.mjs <testset dir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const DIR = process.argv[2];
const { keywordMatch } = await import(pathToFileURL(path.resolve("../../extension/youtube/keywords.js")).href);
const items = JSON.parse(fs.readFileSync(path.join(DIR, "items.json"), "utf8"));
const FILTERS = JSON.parse(fs.readFileSync(path.join(DIR, "filters.json"), "utf8"));
const feat = (n) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, `feat-${n}.json`), "utf8")); } catch { return null; } };
const dev = items.filter((x) => x.split === "dev"), test = items.filter((x) => x.split === "test");
const pc = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%`.padStart(4) : "  - ");

// ---- per-item scores for each signal (higher = more likely hide) ----
const sig = {};
// keywords on the title + channel, and on each OCR's text
sig["keywords: title"] = (x) => (FILTERS.some((f) => keywordMatch(f, x.title, x.channel)) ? 1 : 0);
for (const o of ["tesseract", "florence"]) {
  const ocr = feat("ocr-" + o);
  if (ocr) sig[`keywords: ${o} OCR`] = (x) => (FILTERS.some((f) => keywordMatch(f, ocr[x.id] ?? "")) ? 1 : 0);
}
// SigLIP: per filter, the highest logit over its prompts, standardised against the dev "show" thumbnails; item = max
for (const m of ["siglip", "siglip2"]) {
  const s = feat(m);
  if (!s) continue;
  const byFilter = [...new Set(s.prompts.map((p) => p.f))].map((f) => s.prompts.map((p, k) => (p.f === f ? k : -1)).filter((k) => k >= 0));
  const raw = (x) => byFilter.map((ks) => Math.max(...ks.map((k) => s.logits[x.id][k])));
  const cal = byFilter.map((_, j) => { const v = dev.filter((x) => x.label === "show").map((x) => raw(x)[j]), mu = v.reduce((a, b) => a + b, 0) / v.length; return { mu, sd: Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length) || 1 }; });
  sig[m] = (x) => Math.max(...raw(x).map((r, j) => (r - cal[j].mu) / cal[j].sd));
  sig[m].vec = (x) => raw(x).map((r, j) => (r - cal[j].mu) / cal[j].sd);
}
// zero-shot text classifier: item = highest entailment probability over the filters
for (const n of ["nli-xsmall-title", "nli-xsmall-title+florence", "nli-base-title", "nli-base-title+florence"]) {
  const s = feat(n);
  if (!s) continue;
  sig[n] = (x) => Math.max(...s.scores[x.id]);
  sig[n].vec = (x) => s.scores[x.id];
}

// ---- a pipeline hides if any of its signals is over its threshold; thresholds tuned on dev for a false-hide budget ----
const binary = (n) => /^keywords/.test(n);
const rates = (set, rule) => {
  const hide = set.filter((x) => x.label === "hide"), show = set.filter((x) => x.label === "show");
  return { caught: hide.filter(rule).length, nHide: hide.length, wrong: show.filter(rule).length, nShow: show.length };
};
function tune(names, budget) {
  const learned = names.filter((n) => !binary(n)), fixed = names.filter(binary);
  const grid = (n) => [...new Set(dev.map((x) => sig[n](x)))].sort((a, b) => a - b).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 60)) === 0).concat([Infinity]);
  let best = null;
  const rec = (k, th) => {
    if (k === learned.length) {
      const rule = (x) => fixed.some((n) => sig[n](x) > 0) || learned.some((n, j) => sig[n](x) > th[j]);
      const r = rates(dev, rule);
      if (r.wrong / r.nShow <= budget && (!best || r.caught > best.r.caught || (r.caught === best.r.caught && r.wrong < best.r.wrong))) best = { th: [...th], r, rule };
      return;
    }
    for (const t of grid(learned[k])) rec(k + 1, [...th, t]);
  };
  rec(0, []);
  return best && { ...best, learned };
}
const line = (label, r) => `${label.padEnd(64)} catches ${pc(r.caught, r.nHide)} (${r.caught}/${r.nHide})  wrongly hides ${pc(r.wrong, r.nShow)} (${r.wrong}/${r.nShow})`;
const PIPES = [
  ["keywords: title"],
  ["keywords: title", "keywords: tesseract OCR"],
  ["keywords: title", "keywords: florence OCR"],
  ["keywords: title", "keywords: florence OCR", "siglip"],
  ["keywords: title", "keywords: florence OCR", "siglip2"],
  ["keywords: title", "keywords: florence OCR", "nli-xsmall-title+florence"],
  ["keywords: title", "keywords: florence OCR", "nli-base-title+florence"],
  ["keywords: title", "keywords: florence OCR", "siglip2", "nli-xsmall-title+florence"],
  ["keywords: title", "keywords: florence OCR", "siglip2", "nli-base-title+florence"],
  ["siglip2"], ["nli-base-title+florence"], ["nli-base-title"],
].filter((p) => p.every((n) => sig[n]));
const byGroup = (rule) => ["search", "screenshot", "tbench"].map((g) => { const r = rates(test.filter((x) => x.source.startsWith(g)), rule); return `${g} ${r.caught}/${r.nHide}·${r.wrong}/${r.nShow}`; }).join("  ");
console.log(`test set: ${items.length} items (dev ${dev.length}, test ${test.length}); results on TEST, thresholds from dev\n`);
for (const budget of [0.05, 0.1, 0.15]) {
  console.log(`--- at most ${budget * 100}% of harmless dev videos wrongly hidden ---`);
  for (const p of PIPES) {
    const t = tune(p, budget);
    if (!t) { console.log(`${p.join(" + ").padEnd(64)} (no setting fits the budget)`); continue; }
    console.log(line(p.join(" + "), rates(test, t.rule)) + `   [${byGroup(t.rule)}]`);
  }
  console.log("");
}
// the user's screenshot, under the best combined pipeline at 10%
const bestP = PIPES.filter((p) => p.length > 2).map((p) => ({ p, t: tune(p, 0.1) })).filter((x) => x.t).sort((a, b) => rates(test, b.t.rule).caught - rates(test, a.t.rule).caught)[0];
if (bestP) {
  console.log(`screenshot under ${bestP.p.join(" + ")} (10% budget):`);
  for (const x of items.filter((y) => y.source === "screenshot")) console.log(`  ${x.label.padEnd(5)} ${bestP.t.rule(x) ? "HIDDEN" : "shown "}  ${x.title.slice(0, 60)}`);
}

// ---- learning from you: a small classifier trained on dev labels (standing in for the user's clicks) ----
const vecNames = Object.keys(sig).filter((n) => sig[n].vec);
if (vecNames.length) {
  const fv = (x) => [1, ...Object.keys(sig).filter(binary).map((n) => sig[n](x)), ...vecNames.flatMap((n) => sig[n].vec(x))];
  const X = dev.map(fv), Y = dev.map((x) => (x.label === "hide" ? 1 : 0)), D = X[0].length;
  let w = new Array(D).fill(0);
  for (let it = 0; it < 3000; it++) { // logistic regression, L2
    const g = new Array(D).fill(0);
    X.forEach((x, i) => { const p = 1 / (1 + Math.exp(-x.reduce((a, v, k) => a + v * w[k], 0))); x.forEach((v, k) => (g[k] += (p - Y[i]) * v)); });
    w = w.map((v, k) => v - 0.05 * (g[k] / X.length + (k ? 0.01 * v : 0)));
  }
  const prob = (x) => 1 / (1 + Math.exp(-fv(x).reduce((a, v, k) => a + v * w[k], 0)));
  console.log(`\nlearned from dev labels (${dev.length} examples; features: keywords + ${vecNames.join(", ")}):`);
  for (const budget of [0.05, 0.1, 0.15]) {
    const ts = dev.filter((x) => x.label === "show").map(prob).sort((a, b) => b - a), t = ts[Math.floor(budget * ts.length)] ?? 1;
    console.log(line(`  at ${budget * 100}% budget`, rates(test, (x) => prob(x) > t)) + `   [${byGroup((x) => prob(x) > t)}]`);
  }
}
