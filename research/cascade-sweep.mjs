// Cascade sweep: cheap probe on every word → the judge only on unsure sentences → one ensemble score.
// Input: per-sentence units saved from the extension (probe peak z, confidence, and the judge's Yes−No margin wherever
// the probe's peak was over 1.5). For each setup, per sentence:
//   peak ≤ gate              → clear (no judge)
//   top-3 average ≥ certain  → block (no judge)
//   otherwise                → judge; block if peak + w × margin > t   (the ensemble)
// Chosen on the dev filters, then shown on the held-out ones. Usage: node research/cascade-sweep.mjs <cascade-units.json>
import { readFileSync } from "node:fs";

const units = JSON.parse(readFileSync(process.argv[2]));
const FP_WEIGHT = +(process.argv[3] ?? 1); // how much a look-alike fire counts against a hit
const PAGE_WORDS = JSON.parse(readFileSync(new URL("../extension/bench/haystack.json", import.meta.url))).pages.join(" ").split(/\s+/).length;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pc = (x) => (100 * x).toFixed(0).padStart(3) + "%";
const group = (xs, key) => Object.groupBy(xs, key);

function evaluate(split, c) {
  let judged = 0;
  const block = (u) => {
    if (u.peak <= c.gate) return false;
    if (u.top3 >= c.certain) return true;
    if (c.w === null) return u.peak > c.t; // probe alone
    judged++;
    return u.peak + c.w * u.j > c.t;
  };
  const S = units.filter((u) => u.split === split);
  // short passages: a passage fires if any sentence is blocked
  const bench = S.filter((u) => u.set === "bench"), passes = Object.values(group(bench, (u) => `${u.f}|${u.pid}`));
  const rate = (test) => { const ps = passes.filter((us) => test(us[0])); return avg(ps.map((us) => (us.some(block) ? 1 : 0))); };
  const mixed = passes.filter((us) => us[0].kind === "mixed" && us[0].own);
  // pages: blocked sentences; needles: was the needle sentence blocked
  const pages = S.filter((u) => u.set === "pages"), words = PAGE_WORDS * new Set(pages.map((u) => u.f)).size;
  const pageBlocks = pages.filter(block).length;
  const judgedPages = judged;
  const needles = Object.values(group(S.filter((u) => u.set === "needle"), (u) => u.ni));
  const needleRate = (kind) => avg(needles.filter((us) => us[0].kind === kind).map((us) => (us.filter((u) => u.role === "needle").some(block) ? 1 : 0)));
  const r = {
    direct: rate((u) => u.own && u.kind === "direct"), indirect: rate((u) => u.own && u.kind === "indirect"),
    look: rate((u) => u.own && u.kind === "hardNeg"), cross: rate((u) => !u.own && u.kind !== "mixed" && u.kind !== "benign"),
    ordinary: rate((u) => u.kind === "benign"), mixedEarly: avg(mixed.map((us) => (us.filter((u) => !u.after).some(block) ? 1 : 0))),
    mixedCaught: avg(mixed.map((us) => (us.filter((u) => u.after).some(block) ? 1 : 0))),
    mention: needleRate("mention"), needleDirect: needleRate("direct"), needleLook: needleRate("look-alike"),
    pageBlocks, pageBlocksPer1k: (1000 * pageBlocks) / words, judgePer1k: (1000 * judgedPages) / words,
  };
  r.recall = avg([r.direct, r.indirect, r.mention]);
  r.fp = avg([r.look, r.needleLook]);
  r.score = r.recall - FP_WEIGHT * r.fp;
  r.ok = r.ordinary <= 0.02 && r.pageBlocksPer1k <= 0.5;
  return r;
}
const show = (name, r) => console.log(`${name.padEnd(44)} direct ${pc(r.direct)} indirect ${pc(r.indirect)} mention ${pc(r.mention)} | look-alike ${pc(r.look)} needle-look ${pc(r.needleLook)} other-topic ${pc(r.cross)} ordinary ${pc(r.ordinary)} pages ${r.pageBlocksPer1k.toFixed(2)}/1k | mixed early ${pc(r.mixedEarly)} caught ${pc(r.mixedCaught)} | judge ${r.judgePer1k.toFixed(1)}/1k words`);
const label = (c) => (c.w === null ? `probe alone, z > ${c.t}` : `gate ${c.gate} certain ${c.certain} w ${c.w} t ${c.t}`);

const shipped = { gate: -99, certain: Infinity, w: null, t: 3.44 };
const grid = [];
for (const gate of [1.5, 2, 2.5, 3, 3.5]) for (const certain of [6, 8, 10, 12, Infinity]) for (const w of [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2])
  for (let t = -10; t <= 12; t += 0.5) grid.push({ gate, certain, w, t });
for (const t of [2, 2.5, 3, 3.44, 4, 5, 6]) grid.push({ gate: -99, certain: Infinity, w: null, t });

const dev = grid.map((c) => ({ c, r: evaluate("dev", c) })).filter((x) => x.r.ok).sort((a, b) => b.r.score - a.r.score);
console.log(`${grid.length} setups; ${dev.length} keep ordinary passages ≤ 2% and pages ≤ 0.5 blocks per 1,000 words on dev.\n`);
console.log(`== dev: shipped probe, then the best setups (score = mean of direct/indirect/mention hits − ${FP_WEIGHT} × mean look-alike fires)`);
show("shipped probe alone (z > 3.44)", evaluate("dev", shipped));
for (const x of dev.slice(0, 10)) show(label(x.c), x.r);
console.log("\n== held-out filters, same setups");
show("shipped probe alone (z > 3.44)", evaluate("test", shipped));
for (const x of dev.slice(0, 5)) show(label(x.c), evaluate("test", x.c));
console.log("\nWINNER " + JSON.stringify(dev[0].c));
