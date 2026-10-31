// One-sentence filter: a cheap probe on every word, cascading into Gemma as a judge (NOTES.md has the numbers).
// Probe setup, once per sentence (research/probe-research.mjs): the model reads the sentence as if it had written it as
// a chat reply; its layer-7 state at the sentence's last token, minus the average of the same for 25 generic topic
// sentences ("anything about the weather", …: a Rocchio negative centroid), is the filter's direction.
// Per word: one dot product with that layer's output (1536 multiply-adds), in units of ordinary text's spread (z),
// smoothed a little, then averaged with the next two words' scores so context can settle the meaning.
// Per sentence: the cascade below decides. No examples, no training.
export const L = 35, D = 1536;
// each layer's output kernel (the residual stream after the layer; stages.js calls it "Layer output")
export const TAP = /_add\d+_multiply\d+(_cast\d+)?_kernel$/;
// layer index (0-based: layer 7), smoothing, words of look-ahead
export const PROBE = { layer: 6, alpha: 0.5, ahead: 2 };

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
const ema = (xs, alpha = PROBE.alpha) => { let e; return xs.map((x) => (e = e === undefined ? x : e + alpha * (x - e))); };
// each word's score averaged with the next `ahead` words' (fewer at the end of a text)
const settle = (zs) => zs.map((_, i) => { const w = zs.slice(i, i + PROBE.ahead + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
// raw per-word scores → the scores the cascade reads
export const smooth = (raw) => settle(ema(raw));
// per word: the average of the 3 highest scores in the last 16 words. A look-alike ("spelling bee") makes one word
// spike; real topic text keeps several words high (research round 6).
export const top3 = (zs) => zs.map((_, i) => {
  const t = zs.slice(Math.max(0, i - 15), i + 1).sort((a, b) => b - a).slice(0, 3);
  return t.reduce((a, b) => a + b, 0) / t.length;
});

// Split text into sentences, keeping every character (joined back together they give the text).
export const sentences = (text) => (text.match(/[^.!?\n]*(?:[.!?\n]+|$)\s*/g) ?? []).filter(Boolean);

// The cascade (research/cascade-sweep.mjs, 2026-10-30), per sentence, from its words' scores:
//   peak ≤ gate              → clear, no judge
//   top-3 average ≥ certain  → blocked, no judge
//   otherwise                → Gemma judges the sentence alone (margin = logit Yes − logit No) and the ensemble
//                              peak + w × margin blocks above t.
// Chosen on the dev filters with look-alike fires counted 3× against hits; held out: look-alikes 37% → 27%, no false
// alarms on ordinary text, the judge runs about 5 times per 1,000 ordinary words.
export const CASCADE = { gate: 1.5, certain: 8, w: 2, t: -8 };
// one sentence's verdict; judge() is only called in the unsure band. score > 0 means blocked.
export async function cascade(peak, best3, judge, rule = CASCADE) {
  if (peak <= rule.gate) return { verdict: "clear", score: peak - rule.gate - 50 };
  if (best3 >= rule.certain) return { verdict: "blocked", score: 50 + best3 };
  const margin = await judge(), ensemble = peak + rule.w * margin;
  return { verdict: ensemble > rule.t ? "judge: blocked" : "judge: cleared", score: ensemble - rule.t, margin, ensemble };
}
// YouTube titles (one short line + channel): the judge's "No" counts for more. Tuned by hand-labelling 132 judged
// home-feed videos for "anything about gaming" / "anything about AI" (2026-10-30): wrong blocks 9 → 6, misses 4 → 5.
export const CASCADE_TITLES = { ...CASCADE, t: -4.5 };
// Rudder's strict rule (the user's choice, 2026-10-31: "be very overcautious"): more titles go to the judge (gate 1.0),
// and the judge must say No firmly to clear one (t -8: with a probe peak of 2, its No margin must be below -5).
export const CASCADE_STRICT = { ...CASCADE, gate: 1, t: -8 };
