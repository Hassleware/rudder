// One-sentence filter, as found by research/probe-research.mjs (2026-10-30; NOTES.md has the numbers).
// Setup, once per sentence: the model reads the sentence as if it had written it as a chat reply; its layer-7 state at
// the sentence's last token, minus the average of the same for 25 generic topic sentences ("anything about the
// weather", …: a Rocchio negative centroid), is the filter's direction.
// Per token: one dot product with that layer's output (1536 multiply-adds), in units of ordinary text's spread (z),
// smoothed a little, then averaged with the next two words' scores (context settles the meaning: "spelling bee" vs
// "honeybee"; research round 8), so a word's verdict comes two words later. It fires above one fixed z for every
// filter. No examples, no training.
export const L = 35, D = 1536;
// each layer's output kernel (the residual stream after the layer; stages.js calls it "Layer output")
export const TAP = /_add\d+_multiply\d+(_cast\d+)?_kernel$/;
// layer index (0-based: layer 7), smoothing, words of look-ahead, and the threshold: z where 1% of ordinary dev
// passages fire (held-out: 87% of on-topic passages naming the topic, 74% without the word, 27% of look-alikes)
export const PROBE = { layer: 6, alpha: 0.5, ahead: 2, z: 3.44 };

export function mean(vs) {
  const m = new Float32Array(D);
  for (const v of vs) for (let i = 0; i < D; i++) m[i] += v[i] / vs.length;
  return m;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };

// f = the sentence's vector, ref = the topic-bank mean, ordinary = ordinary-text token vectors (all at the probe layer)
export function makeProbe(f, ref, ordinary) {
  const w = new Float32Array(D);
  for (let i = 0; i < D; i++) w[i] = f[i] - ref[i];
  const n = Math.sqrt(dot(w, w)) || 1;
  for (let i = 0; i < D; i++) w[i] /= n;
  const b = -dot(w, mean(ordinary)), raw = ordinary.map((x) => dot(w, x) + b);
  const mu = raw.reduce((a, x) => a + x, 0) / raw.length, sd = Math.sqrt(raw.reduce((a, x) => a + (x - mu) ** 2, 0) / raw.length) || 1;
  return { w, b: b - mu, sd }; // z = (w·x + b) / sd
}
export const score = (p, x) => (dot(p.w, x) + p.b) / p.sd;
export const ema = (xs, alpha = PROBE.alpha) => { let e; return xs.map((x) => (e = e === undefined ? x : e + alpha * (x - e))); };
// each word's score averaged with the next `ahead` words' (fewer at the end of a text)
export const settle = (zs) => zs.map((_, i) => { const w = zs.slice(i, i + PROBE.ahead + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
// raw per-word scores → the scores the filter fires on
export const smooth = (raw) => settle(ema(raw));

// Confidence per word, from the scores alone (no extra GPU work). A look-alike ("spelling bee") makes one word spike;
// real on-topic text keeps several words high. So over the last 16 words: how many are over the threshold (→ tier),
// and the average of the top 3 scores (a finer number; research round 6: separates look-alikes better than one word).
export const WINDOW = 16, TIERS = ["none", "low", "medium", "high"];
export function confidence(zs) {
  return zs.map((_, i) => {
    const w = zs.slice(Math.max(0, i - WINDOW + 1), i + 1), top = [...w].sort((a, b) => b - a).slice(0, 3);
    const hits = w.filter((z) => z > PROBE.z).length;
    return { hits, top3: top.reduce((a, b) => a + b, 0) / top.length, tier: TIERS[Math.min(3, hits)] };
  });
}
