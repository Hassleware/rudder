// Scores the filter benchmark (filters.json). Input: scores[filterId][passageId] = the filter's smoothed similarity
// for each token of that passage (for mixed passages: { before: [...], after: [...] }). A passage "fires" when any
// token goes over the threshold, as it would while streaming. The threshold comes from ordinary text only (no labels).

export function passages(bench) {
  const out = bench.benign.map((text, i) => ({ id: `benign.${i}`, kind: "benign", text }));
  for (const f of bench.filters) {
    for (const kind of ["direct", "indirect", "hardNeg"]) f[kind].forEach((text, i) => out.push({ id: `${f.id}.${kind}.${i}`, filter: f.id, kind, text }));
    f.mixed.forEach((m, i) => out.push({ id: `${f.id}.mixed.${i}`, filter: f.id, kind: "mixed", ...m }));
  }
  return out;
}

const peak = (s) => Math.max(...s);
// chance a random on-topic passage scores above a random off-topic one (1 = perfect, 0.5 = guessing)
export function auroc(pos, neg) {
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
// lowest score that at most `rate` of ordinary passages go over
export const threshold = (benign, rate) => [...benign].sort((a, b) => b - a)[Math.floor(rate * benign.length)];

// fixed: use this threshold instead of one from the ordinary passages
export function report(bench, scores, rate = 0.05, fixed = null) {
  const all = passages(bench);
  return bench.filters.map((f) => {
    const S = scores[f.id];
    const of = (test) => all.filter(test).map((p) => peak(p.kind === "mixed" ? [...S[p.id].before, ...S[p.id].after] : S[p.id]));
    const own = (kind) => of((p) => p.filter === f.id && p.kind === kind);
    const benign = of((p) => p.kind === "benign");
    const cross = of((p) => p.filter && p.filter !== f.id && p.kind !== "mixed"); // other filters' passages: off topic here
    const t = fixed ?? threshold(benign, rate), fire = (xs) => xs.filter((x) => x > t).length / xs.length;
    return {
      filter: f.id,
      auroc: auroc([...own("direct"), ...own("indirect")], [...own("hardNeg"), ...benign, ...cross]),
      direct: fire(own("direct")), indirect: fire(own("indirect")),
      hardNeg: fire(own("hardNeg")), cross: fire(cross), benign: fire(benign),
      // early = fired before the topic started; delay = tokens after it started until firing (-1 = never)
      mixed: all.filter((p) => p.filter === f.id && p.kind === "mixed")
        .map((p) => ({ early: peak(S[p.id].before) > t, delay: S[p.id].after.findIndex((x) => x > t) })),
    };
  });
}

// self-check with made-up scores: `node extension/bench/metrics.js`
if (typeof process !== "undefined" && process.argv[1]?.endsWith("metrics.js")) {
  const { readFileSync } = await import("node:fs");
  const bench = JSON.parse(readFileSync(new URL("./filters.json", import.meta.url)));
  const fake = (on) => Object.fromEntries(passages(bench).map((p) => {
    const hit = p.filter === on && (p.kind === "direct" || p.kind === "indirect");
    if (p.kind === "mixed") return [p.id, { before: [0.1, 0.2], after: p.filter === on ? [0.3, 0.9, 0.9] : [0.1] }];
    return [p.id, [0.1, hit ? 0.9 : 0.2 + (p.kind === "benign" ? Number(p.id.split(".")[1]) / 100 : 0)]];
  }));
  const r = report(bench, Object.fromEntries(bench.filters.map((f) => [f.id, fake(f.id)])));
  const ok = r.every((x) => x.auroc === 1 && x.direct === 1 && x.indirect === 1 && x.hardNeg === 0 && x.cross === 0 &&
    x.benign === 0.05 && x.mixed[0].early === false && x.mixed[0].delay === 1);
  console.log(ok ? "metrics self-check: PASS" : "metrics self-check: FAIL", JSON.stringify(r[0]));
  if (!ok) process.exit(1);
}
