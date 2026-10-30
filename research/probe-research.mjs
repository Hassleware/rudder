// Offline research on the one-sentence filter. Loads the layer outputs dumped once from the extension (every
// benchmark passage and every filter sentence, 35 layers × 1536 per token) and scores probe variants on CPU:
// dev = filters.json (choose setups here), test = filters-test.json (held out: report only).
// Every filter is scored with all 5 phrasings of its sentence (e.g. "bees", "I don't want any information on bees").
// Usage: node research/probe-research.mjs <dump dir> <round>
import { readFileSync, writeFileSync } from "node:fs";
import { passages, auroc } from "../extension/bench/metrics.js";

const [DIR, ROUND = "1"] = process.argv.slice(2), L = 35, D = 1536;
const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const index = JSON.parse(readFileSync(`${DIR}/index.json`));
const SPLITS = { dev: json("../extension/bench/filters.json"), test: json("../extension/bench/filters-test.json") };
const T = SPLITS.dev.templates;

// ---- data: every token of every item in one table --------------------------------------------------------------
let N = 0;
const at = {};
for (const [k, v] of Object.entries(index)) { at[k] = { start: N, ...v }; N += v.n; }
const raw = new Float16Array(N * L * D);
for (const [k, v] of Object.entries(at)) {
  const b = readFileSync(`${DIR}/${v.file}`);
  raw.set(new Float16Array(b.buffer, b.byteOffset, b.length / 2), v.start * L * D);
}
const layerCache = [];
// all tokens' outputs of one layer, as f32 [N × D]
const layer = (l) => (layerCache[l] ??= (() => {
  const X = new Float32Array(N * D);
  for (let t = 0; t < N; t++) X.set(raw.subarray((t * L + l) * D, (t * L + l + 1) * D), t * D);
  return X;
})());
const tokens = (key) => { const { start, n } = at[key]; return Array.from({ length: n }, (_, i) => start + i); };
function meanOf(ts, l) {
  const X = layer(l), m = new Float64Array(D);
  for (const t of ts) for (let i = 0; i < D; i++) m[i] += X[t * D + i];
  return m.map((x) => x / ts.length);
}

// ---- spaces: per layer, x → (x − c) / s, fitted on ordinary text only -------------------------------------------
const ORD = tokens("baseline");
const spaceCache = {};
function space(name, l) {
  return (spaceCache[`${name}.${l}`] ??= (() => {
    const c = name === "none" ? new Float64Array(D) : meanOf(ORD, l), s = new Float64Array(D).fill(1);
    if (name.startsWith("white")) { // diagonal whitening, regularised by λ × the average variance
      const X = layer(l), lam = +name.slice(5) || 0.1;
      const v = new Float64Array(D);
      for (const t of ORD) for (let i = 0; i < D; i++) v[i] += (X[t * D + i] - c[i]) ** 2 / ORD.length;
      const avgv = v.reduce((a, b) => a + b) / D;
      for (let i = 0; i < D; i++) s[i] = Math.sqrt(v[i] + lam * avgv);
    }
    return { c, s };
  })());
}
const normCache = {};
// |(x − c)/s| for every token in a layer (for cosine scores)
function norms(name, l) {
  return (normCache[`${name}.${l}`] ??= (() => {
    const X = layer(l), { c, s } = space(name, l), out = new Float32Array(N);
    for (let t = 0; t < N; t++) { let q = 0; for (let i = 0; i < D; i++) q += ((X[t * D + i] - c[i]) / s[i]) ** 2; out[t] = Math.sqrt(q); }
    return out;
  })());
}

// ---- the model's own examples (idea a): for each filter phrasing, sentences it wrote about the topic without the
// key word ("pos") and phrases using the key word in another sense ("neg"); saved at layer 7 only.
const genIndex = (() => { try { return JSON.parse(readFileSync(`${DIR}/gen-index.json`)); } catch { return {}; } })();
const genRaw = {};
for (const [k, v] of Object.entries(genIndex)) { const b = readFileSync(`${DIR}/${v.file}`); genRaw[k] = new Float16Array(b.buffer, b.byteOffset, b.length / 2); }
const genCache = {};
function genVec(sentence, kind, readout, l) {
  if (l !== 6) throw new Error("generated examples are saved at layer 7 only");
  return (genCache[`${sentence}|${kind}|${readout}`] ??= (() => {
    const keys = Object.keys(genIndex).filter((k) => genIndex[k].sentence === sentence && genIndex[k].kind === kind), m = new Float64Array(D);
    if (!keys.length) throw new Error(`no generated ${kind} examples for "${sentence}"`);
    for (const k of keys) {
      const x = genRaw[k], n = genIndex[k].n, v = new Float64Array(D);
      if (readout === "last") for (let i = 0; i < D; i++) v[i] = x[(n - 1) * D + i];
      else for (let t = 0; t < n; t++) for (let i = 0; i < D; i++) v[i] += x[t * D + i] / n;
      for (let i = 0; i < D; i++) m[i] += v[i] / keys.length;
    }
    return m;
  })());
}
// the bare key word of a filter (idea b): its first rephrasing ("bees", "firearms", …)
const keywordOf = (sentence) => Object.values(SPLITS).flatMap((b) => b.filters).find((f) => f.sentence === sentence || f.paraphrases.includes(sentence)).paraphrases[0];

// ---- a probe: one direction per layer, from the model's reading of the sentence alone -----------------------------
const sentVec = (sentence, cfg, l) => {
  const ts = tokens(`${cfg.mode}:${sentence}`);
  return cfg.readout === "last" ? meanOf([ts.at(-1)], l) : meanOf(cfg.readout === "skip1" && ts.length > 1 ? ts.slice(1) : ts, l);
};
const refVec = (cfg, l) => {
  const list = { neutral: [T.neutral], bank: SPLITS.dev.topicBank, bankn: [T.neutral, ...SPLITS.dev.topicBank] }[cfg.ref] ??
    (cfg.ref.startsWith("bank:") ? SPLITS.dev.topicBank.slice(0, +cfg.ref.slice(5)) : null); // bank:K = only the first K topics
  if (!list) return null; // "none": relative to ordinary text's mean (the space centre)
  const vs = list.map((s) => sentVec(s, cfg, l));
  return vs[0].map((_, i) => vs.reduce((a, v) => a + v[i], 0) / vs.length);
};
// linear weights per layer: score_l(x) = w·x + b (then ÷|x′| for cosine)
function probe(sentence, cfg) {
  return cfg.layers.map((l) => {
    const { c, s } = space(cfg.space, l), r = refVec(cfg, l) ?? c;
    let f = sentVec(sentence, cfg, l);
    if (cfg.pos && cfg.pos !== "f" && l === 6) { // idea a: the model's own on-topic sentences, alone or averaged with the filter sentence
      const g = genVec(sentence, "pos", cfg.genRead, l);
      f = cfg.pos === "gen" ? g : f.map((x, i) => (x + g[i]) / 2);
    }
    const d = new Float64Array(D);
    for (let i = 0; i < D; i++) d[i] = f[i] - r[i];
    if (cfg.gamma && l === 6) { // idea a: push away from the model's own look-alikes
      const q = genVec(sentence, "neg", cfg.genRead, l);
      for (let i = 0; i < D; i++) d[i] -= cfg.gamma * (q[i] - r[i]);
    }
    if (cfg.proj) { // idea b: remove (part of) the bare key word's direction
      const kw = sentVec(keywordOf(sentence), cfg, l), u = kw.map((x, i) => x - r[i]), un = Math.sqrt(u.reduce((a, x) => a + x * x, 0));
      const du = d.reduce((a, x, i) => a + x * u[i], 0) / un;
      for (let i = 0; i < D; i++) d[i] -= cfg.proj * du * u[i] / un;
    }
    let n = 0;
    for (let i = 0; i < D; i++) { d[i] /= s[i]; n += d[i] * d[i]; }
    n = Math.sqrt(n);
    const w = new Float32Array(D);
    let b = 0;
    for (let i = 0; i < D; i++) { w[i] = d[i] / n / s[i]; b -= w[i] * c[i]; }
    return { l, w, b };
  });
}
// score tokens per layer, then combine layers: "mean" of raw scores, or "min" of per-layer z-scores (every layer
// must agree). zIdx = positions (in ts) of ordinary-text tokens, for z-scoring.
const zscore = (xs, zIdx) => {
  const o = zIdx.map((k) => xs[k]), mu = avgOf(o), sd = Math.sqrt(avgOf(o.map((x) => (x - mu) ** 2))) || 1;
  return xs.map((x) => (x - mu) / sd);
};
function scoreTokens(pr, cfg, ts, zIdx) {
  const per = pr.map(({ l, w, b }) => {
    const X = layer(l), nm = cfg.norm === "cos" ? norms(cfg.space, l) : null, out = new Float32Array(ts.length);
    ts.forEach((t, k) => {
      let dot = b;
      for (let i = 0; i < D; i++) dot += X[t * D + i] * w[i];
      out[k] = nm ? dot / nm[t] : dot;
    });
    return out;
  });
  if (cfg.combine !== "min") return per[0].map((_, k) => avgOf(per.map((p) => p[k])));
  const zs = per.map((p) => zscore(p, zIdx));
  return zs[0].map((_, k) => Math.min(zs[0][k], ...zs.slice(1).map((z) => z[k] + (cfg.delta ?? 0))));
}

// ---- evaluation ---------------------------------------------------------------------------------------------------
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const avgOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const ema = (xs, a) => { let e; return xs.map((x) => (e = e === undefined ? x : e + a * (x - e))); };
const splitPass = Object.fromEntries(Object.entries(SPLITS).map(([k, b]) => [k, passages(b)]));
const splitTokens = Object.fromEntries(Object.entries(SPLITS).map(([k]) => [k, [...splitPass[k].flatMap((p) => tokens(`${k}:${p.id}`)), ...ORD]]));

// idea c: judge each word together with the next one(s): "persist2" = both it and the next word must be high,
// "mean3" = the average of it and the next two
const waitFor = (zs, agg) => (agg === "persist2" ? zs.map((z, i) => Math.min(z, zs[i + 1] ?? z))
  : agg === "mean3" ? zs.map((_, i) => avgOf(zs.slice(i, i + 3))) : zs);
// per split, filter and phrasing: each passage's peak z-score (and per-token z for mixed passages)
function run(cfg, split) {
  const b = SPLITS[split], ts = splitTokens[split], pos = new Map(ts.map((t, k) => [t, k])), out = [];
  for (const f of b.filters) for (const [pi, sentence] of [f.sentence, ...f.paraphrases].entries()) {
    const sc = scoreTokens(probe(sentence, cfg), cfg, ts, ORD.map((t) => pos.get(t)));
    const ord = ORD.map((t) => sc[pos.get(t)]), mu = avgOf(ord), sd = Math.sqrt(avgOf(ord.map((x) => (x - mu) ** 2))) || 1;
    const z = (t) => (sc[pos.get(t)] - mu) / sd;
    const peaks = {}, mixed = [], seqs = {};
    for (const p of splitPass[split]) {
      const key = `${split}:${p.id}`, zs = waitFor(ema(tokens(key).map(z), cfg.alpha ?? 1), cfg.agg);
      peaks[p.id] = Math.max(...zs);
      seqs[p.id] = zs;
      if (p.kind === "mixed" && p.filter === f.id) mixed.push({ before: zs.slice(0, at[key].parts[0]), after: zs.slice(at[key].parts[0]) });
    }
    out.push({ f: f.id, pi, peaks, mixed, seqs, ordMax: Math.max(...ema(ord.map((x) => (x - mu) / sd), cfg.alpha ?? 1)) });
  }
  return out;
}
// one summary per run: AUROCs, plus hit/fire rates at a global z threshold tau
function summarise(rs, split, tau) {
  const P = splitPass[split], kinds = (r, test) => P.filter(test).map((p) => r.peaks[p.id]);
  const per = rs.map((r) => {
    const own = (k) => kinds(r, (p) => p.filter === r.f && p.kind === k);
    const pos = [...own("direct"), ...own("indirect")], hard = own("hardNeg"), benign = kinds(r, (p) => p.kind === "benign");
    const cross = kinds(r, (p) => p.filter && p.filter !== r.f && p.kind !== "mixed");
    const fire = (xs) => xs.filter((x) => x > tau).length / xs.length;
    return {
      f: r.f, pi: r.pi, auc: auroc(pos, [...hard, ...benign, ...cross]), aucHard: auroc(pos, hard),
      direct: fire(own("direct")), indirect: fire(own("indirect")), hardNeg: fire(hard), benign: fire(benign), cross: fire(cross),
      early: r.mixed.some((m) => Math.max(...m.before) > tau), delay: r.mixed.map((m) => m.after.findIndex((x) => x > tau))[0],
    };
  });
  const m = (k, test = () => true) => avgOf(per.filter(test).map((x) => x[k]));
  const byFilter = Object.groupBy(per, (x) => x.f);
  return {
    auc: m("auc"), aucCanon: m("auc", (x) => x.pi === 0), aucNeg: m("auc", (x) => x.pi === 2), aucHard: m("aucHard"),
    worstFilter: Math.min(...Object.values(byFilter).map((xs) => avgOf(xs.map((x) => x.auc)))),
    direct: m("direct"), indirect: m("indirect"), hardNeg: m("hardNeg"), benign: m("benign"), cross: m("cross"),
    early: per.filter((x) => x.early).length / per.length, missed: per.filter((x) => x.delay < 0).length / per.length, per,
  };
}
// global threshold from dev: the z that 5% of ordinary dev passages (over every filter and phrasing) go over
let TAU_Q = 0.95;
const tauFrom = (rs) => pct(rs.flatMap((r) => splitPass.dev.filter((p) => p.kind === "benign").map((p) => r.peaks[p.id])), TAU_Q);
const cost = (cfg) => cfg.layers.length * D * (cfg.norm === "cos" ? 2 : 1); // multiply-adds per token
const name = (c) => `${c.mode}|${c.readout}|${c.ref}|${c.space}|${c.norm}${c.combine === "min" ? "|min" : ""}|L${c.layers.length > 3 ? `${c.layers[0] + 1}-${c.layers.at(-1) + 1}` : c.layers.map((l) => l + 1).join(",")}|a${c.alpha ?? 1}${c.pos && c.pos !== "f" ? `|pos:${c.pos}` : ""}${c.gamma ? `|away${c.gamma}` : ""}${c.pos && c.pos !== "f" || c.gamma ? `|${c.genRead}` : ""}${c.proj ? `|proj${c.proj}` : ""}${c.agg ? `|${c.agg}` : ""}${c.delta != null ? `|d${c.delta}` : ""}`;
const f3 = (x) => x.toFixed(3), p0 = (x) => (100 * x).toFixed(0).padStart(3) + "%";
const line = (c, s) => `${name(c).padEnd(62)} cost ${String(cost(c)).padStart(6)}  auc ${f3(s.auc)} canon ${f3(s.aucCanon)} neg ${f3(s.aucNeg)} hard ${f3(s.aucHard)} worst ${f3(s.worstFilter)} | dir ${p0(s.direct)} ind ${p0(s.indirect)} hardNeg ${p0(s.hardNeg)} benign ${p0(s.benign)} cross ${p0(s.cross)} early ${p0(s.early)} miss ${p0(s.missed)}`;

function evalDev(cfgs, label) {
  const t0 = performance.now(), res = cfgs.map((c) => { const rs = run(c, "dev"), tau = tauFrom(rs); return { c, tau, dev: summarise(rs, "dev", tau) }; });
  res.sort((a, b) => b.dev.auc - a.dev.auc);
  console.log(`\n== ${label}: ${cfgs.length} setups on dev (${((performance.now() - t0) / 1000).toFixed(0)} s), ranked by AUROC over all phrasings`);
  for (const r of res.slice(0, 15)) console.log(line(r.c, r.dev));
  return res;
}
function evalTest(res, k, label) {
  console.log(`\n== ${label}: held-out test, threshold from dev`);
  for (const r of res.slice(0, k)) {
    const t = summarise(run(r.c, "test"), "test", r.tau);
    console.log(line(r.c, t));
    r.test = t;
  }
}
const grid = (o) => Object.entries(o).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const BANDS = { all: range(0, 35), early: range(0, 12), mid: range(12, 24), late: range(24, 35) };
const save = (res, file) => writeFileSync(`${DIR}/../${file}`, JSON.stringify(res.map((r) => ({ name: name(r.c), cost: cost(r.c), tau: r.tau, dev: { ...r.dev, per: undefined }, test: r.test && { ...r.test, per: undefined } })), null, 1));

// ---- rounds ---------------------------------------------------------------------------------------------------------
const rounds = {
  // 1: today's viewer setup, then every single layer (the cheapest probe) across the main choices
  1() {
    const now = { mode: "raw", readout: "mean", ref: "neutral", space: "center", norm: "cos", layers: BANDS.early };
    evalTest(evalDev([now], "viewer setup today"), 1, "viewer setup today");
    const res = evalDev(grid({ mode: ["raw", "reply"], readout: ["mean", "last"], ref: ["neutral", "bankn"], space: ["center", "white0.1"], norm: ["cos", "dot"], layers: range(0, 35).map((l) => [l]) }), "round 1: single layers");
    save(res, "round1.json");
  },
  // 2: around round 1's winner (reply, last token, topic-bank reference, layer ~7): layer pairs (an early "topic"
  // layer + a deeper "meaning" layer, against look-alikes like "spelling bee"), whitening strength, smoothing
  2() {
    const layers = [[5], [6], [7], [8], [9], [6, 7], [7, 8], [6, 8], [7, 12], [7, 16], [7, 20], [7, 24], range(5, 10), range(4, 11)];
    const res = evalDev(grid({ mode: ["reply"], readout: ["last"], ref: ["bankn", "bank"], space: ["center", "white0.1", "white1"], norm: ["dot", "cos"], layers: layers.map((ls) => ls.map((l) => l - 1)), alpha: [1, 0.5, 0.3] }), "round 2");
    // best per cost, so the cheapest robust option is visible
    console.log("\n== round 2: best AUROC at each cost");
    const byCost = Object.groupBy(res, (r) => cost(r.c));
    for (const [k, rs] of Object.entries(byCost).sort((a, b) => a[0] - b[0])) console.log(line(rs[0].c, rs[0].dev));
    console.log("\n== round 2: best on look-alikes (hard-negative AUROC), among setups with AUROC ≥ 0.97");
    for (const r of res.filter((r) => r.dev.auc >= 0.97).sort((a, b) => b.dev.aucHard - a.dev.aucHard).slice(0, 8)) console.log(line(r.c, r.dev));
    save(res, "round2.json");
  },
  // 3: smoothing fine-tune, negative-bank size, then the finalists on the held-out test set
  3() {
    const base = { mode: "reply", readout: "last", ref: "bankn", space: "center", norm: "dot" };
    const res = evalDev([
      ...grid({ ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [v]])), layers: [[6], [5, 7]], alpha: [1, 0.7, 0.5, 0.4, 0.3, 0.2] }),
      ...grid({ ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [v]])), ref: ["neutral", "bank:3", "bank:6", "bank:12", "bank:25"], layers: [[6]], alpha: [1] }),
    ], "round 3: smoothing and bank size (L7 and L6+8, dot)");
    console.log("\n== bank size (L7, dot, no smoothing)");
    for (const r of res.filter((r) => r.c.layers.length === 1 && r.c.alpha === 1 && r.c.ref !== "bankn")) console.log(line(r.c, r.dev));
    const pick = (o) => res.find((r) => Object.entries(o).every(([k, v]) => JSON.stringify(r.c[k]) === JSON.stringify(v)));
    const today = evalDev([{ mode: "raw", readout: "mean", ref: "neutral", space: "center", norm: "cos", layers: BANDS.early, alpha: 1 }], "today");
    const finalists = [today[0], pick({ layers: [6], alpha: 1, ref: "bankn" }), pick({ layers: [6], alpha: 0.5, ref: "bankn" }), pick({ layers: [5, 7], alpha: 0.5, ref: "bankn" }), pick({ layers: [5, 7], alpha: 0.3, ref: "bankn" })];
    evalTest(finalists, finalists.length, "round 3 finalists");
    for (const r of finalists.slice(1)) {
      console.log(`\n${name(r.c)} on test, per filter (AUROC averaged over the 5 phrasings; phrasing 3 = "I don't want any information on …"):`);
      for (const [f, xs] of Object.entries(Object.groupBy(r.test.per, (x) => x.f)))
        console.log(`  ${f.padEnd(9)} auc ${xs.map((x) => f3(x.auc)).join(" ")}  hard ${f3(avgOf(xs.map((x) => x.aucHard)))}  hardNeg fire ${p0(avgOf(xs.map((x) => x.hardNeg)))}  indirect ${p0(avgOf(xs.map((x) => x.indirect)))}  mixed delay ${xs.map((x) => x.delay).join(",")}`);
    }
    save(finalists, "round3.json");
  },
  // 4: look-alikes. Two cheap layer probes that must both agree (min of z-scores), and the threshold trade-off
  4() {
    const res = evalDev(grid({ mode: ["reply"], readout: ["last"], ref: ["bankn"], space: ["center"], norm: ["dot"], combine: ["mean", "min"],
      layers: [[7, 8], [7, 9], [7, 10], [6, 9], [8, 9], [6, 10], [7, 12], [7, 27]].map((ls) => ls.map((l) => l - 1)), alpha: [1, 0.5, 0.3] }), "round 4: layer pairs, mean vs both-must-agree");
    console.log("\n== round 4: best on look-alikes, among setups with AUROC ≥ 0.975");
    for (const r of res.filter((r) => r.dev.auc >= 0.975).sort((a, b) => b.dev.aucHard - a.dev.aucHard).slice(0, 6)) console.log(line(r.c, r.dev));
    // trade-off: hit and false-fire rates as the global threshold gets stricter (ordinary-passage fire rate on dev)
    const one = { mode: "reply", readout: "last", ref: "bankn", space: "center", norm: "dot", layers: [6], alpha: 0.5 };
    const best = res.filter((r) => r.dev.auc >= 0.975).sort((a, b) => b.dev.aucHard - a.dev.aucHard)[0].c;
    for (const c of [one, best]) {
      const dev = run(c, "dev"), test = run(c, "test"), benign = dev.flatMap((r) => splitPass.dev.filter((p) => p.kind === "benign").map((p) => r.peaks[p.id]));
      console.log(`\n${name(c)}: threshold trade-off (set on dev, shown on held-out test)`);
      for (const q of [0.9, 0.95, 0.98, 0.99]) { const s = summarise(test, "test", pct(benign, q)); console.log(`  dev ordinary fire ${p0(1 - q)}: test direct ${p0(s.direct)} indirect ${p0(s.indirect)} look-alike ${p0(s.hardNeg)} other-topic ${p0(s.cross)} ordinary ${p0(s.benign)} mixed missed ${p0(s.missed)}`); }
    }
    save(res, "round4.json");
  },
  // 6: confidence. Which per-passage number best separates real hits from look-alikes ("spelling bee")?
  // All from the shipped probe's per-token z (free) except "agree": the lower of layer 7's and layer 9's z (1 more dot).
  6() {
    const c = { mode: "reply", readout: "last", ref: "bankn", space: "center", norm: "dot", layers: [6], alpha: 0.5 };
    const c9 = { ...c, layers: [6, 8], combine: "min" }, TAU = 3.54;
    const desc = (zs) => [...zs].sort((a, b) => b - a);
    const FEATS = {
      "peak (shipped)": (zs) => Math.max(...zs),
      "2nd-highest word": (zs) => desc(zs)[1] ?? desc(zs)[0],
      "mean of top 3 words": (zs) => avgOf(desc(zs).slice(0, 3)),
      "words over threshold": (zs) => zs.filter((z) => z > TAU).length,
      "area over threshold": (zs) => zs.reduce((a, z) => a + Math.max(0, z - TAU), 0),
    };
    for (const split of ["dev", "test"]) {
      const rs = run(c, split), r9 = run(c9, split), P = splitPass[split];
      const feats = { ...FEATS, "agree: min(layer 7, layer 9)": null };
      console.log(`\n== ${split}: AUROC of each confidence score, real on-topic passages vs look-alikes (and vs everything off-topic)`);
      for (const [nm, fn] of Object.entries(feats)) {
        const hard = [], all = [];
        rs.forEach((r, k) => {
          const val = (p) => (fn ? fn(r.seqs[p.id]) : r9[k].peaks[p.id]);
          const pos = P.filter((p) => p.filter === r.f && (p.kind === "direct" || p.kind === "indirect")).map(val);
          const look = P.filter((p) => p.filter === r.f && p.kind === "hardNeg").map(val);
          const off = P.filter((p) => p.kind !== "mixed" && !(p.filter === r.f && p.kind !== "hardNeg")).map(val);
          hard.push(auroc(pos, look)); all.push(auroc(pos, off));
        });
        console.log(`  ${nm.padEnd(32)} vs look-alikes ${f3(avgOf(hard))}   vs all off-topic ${f3(avgOf(all))}`);
      }
      // a two-number rule: peak over the threshold AND at least m words over it
      console.log(`  rule "peak > ${TAU} and at least m words over it":`);
      for (const m of [1, 2, 3, 4]) {
        const rate = (test) => avgOf(rs.map((r) => { const ps = P.filter((p) => test(p, r)); return ps.filter((p) => r.seqs[p.id].filter((z) => z > TAU).length >= m).length / ps.length; }));
        console.log(`    m=${m}: direct ${p0(rate((p, r) => p.filter === r.f && p.kind === "direct"))} indirect ${p0(rate((p, r) => p.filter === r.f && p.kind === "indirect"))} look-alike ${p0(rate((p, r) => p.filter === r.f && p.kind === "hardNeg"))} other-topic ${p0(rate((p, r) => p.filter && p.filter !== r.f && p.kind !== "mixed"))} ordinary ${p0(rate((p) => p.kind === "benign"))}`);
      }
    }
  },
  // 7: look-alikes. a = the model's own examples (needs gen-index.json), b = remove the bare key word,
  // c = wait for the next word(s), d = a deeper layer must not disagree. Threshold: 2% of ordinary dev passages.
  7() {
    TAU_Q = 0.98;
    const base = { mode: "reply", readout: "last", ref: "bankn", space: "center", norm: "dot", layers: [6], alpha: 0.5 };
    const cfgs = [base,
      ...[0.5, 1].map((proj) => ({ ...base, proj })),
      ...["persist2", "mean3"].map((agg) => ({ ...base, agg })),
      ...grid({ deep: [8, 10, 12, 14], delta: [0, 1, 2] }).map(({ deep, delta }) => ({ ...base, layers: [6, deep], combine: "min", delta })),
    ];
    if (Object.keys(genIndex).length) cfgs.push(...grid({ pos: ["f", "both", "gen"], gamma: [0, 0.5, 1], genRead: ["last", "mean"], agg: [undefined, "persist2"] })
      .filter((g) => g.pos !== "f" || g.gamma).map((g) => ({ ...base, ...g })));
    const res = evalDev(cfgs, "round 7: look-alike fixes");
    const show = (rs) => rs.forEach((r) => console.log(line(r.c, r.dev)));
    console.log("\n== round 7: ranked by look-alike AUROC (dev), among setups with overall AUROC ≥ 0.975");
    const good = res.filter((r) => r.dev.auc >= 0.975).sort((a, b) => b.dev.aucHard - a.dev.aucHard);
    show(good.slice(0, 15));
    console.log("\n== shipped probe for reference");
    show(res.filter((r) => r.c === base));
    const finalists = [res.find((r) => r.c === base), ...good.filter((r) => r.c !== base).slice(0, 5)];
    evalTest(finalists, finalists.length, "round 7 finalists");
    save(finalists, "round7.json");
  },
  // 8: shipped vs "wait for the next two words" (mean3) at matching strictness: thresholds set on dev, shown on test
  8() {
    const base = { mode: "reply", readout: "last", ref: "bankn", space: "center", norm: "dot", layers: [6], alpha: 0.5 };
    for (const c of [base, { ...base, agg: "mean3" }]) {
      const dev = run(c, "dev"), test = run(c, "test"), benign = dev.flatMap((r) => splitPass.dev.filter((p) => p.kind === "benign").map((p) => r.peaks[p.id]));
      console.log(`\n${name(c)}`);
      for (const q of [0.95, 0.98, 0.99, 0.995]) {
        const tau = pct(benign, q), s = summarise(test, "test", tau);
        console.log(`  z > ${tau.toFixed(2)} (dev ordinary ${p0(1 - q)}): test direct ${p0(s.direct)} indirect ${p0(s.indirect)} look-alike ${p0(s.hardNeg)} other-topic ${p0(s.cross)} ordinary ${p0(s.benign)} mixed missed ${p0(s.missed)}`);
      }
    }
  },
  // 5: the chosen probe: its global z threshold (2% of ordinary dev passages fire), and how it does on test with it
  5() {
    const c = { mode: "reply", readout: "last", ref: "bankn", space: "center", norm: "dot", layers: [6], alpha: 0.5 };
    const dev = run(c, "dev"), tau = pct(dev.flatMap((r) => splitPass.dev.filter((p) => p.kind === "benign").map((p) => r.peaks[p.id])), 0.98);
    console.log(`threshold z = ${tau.toFixed(3)}`);
    console.log("dev  " + line(c, summarise(dev, "dev", tau)));
    console.log("test " + line(c, summarise(run(c, "test"), "test", tau)));
  },
};
rounds[ROUND]();
