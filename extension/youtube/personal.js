// Rudder's own algorithm: it learns what YOU want from the 👍 / 👎 in each video's ⋮ menu, continuously, on your
// device. Nothing leaves the browser.
//   - Every judged video gets a fingerprint: MiniLM's reading of its title and channel (text.js, 384 numbers), shrunk
//     to 256 (a fixed random projection keeps similarities). Fingerprints from before (Gemma's readings) are dropped and
//     your clicks re-read from their titles (reprint).
//   - Examples: your clicks (weight 1), plus videos you were shown and didn't 👎 (weight 0.2: "seen, apparently fine").
//   - A small logistic-regression model on the fingerprints is retrained after every click (milliseconds).
//   - Channels: 2+ 👎 and no 👍 → the channel is hidden; any 👍 and no 👎 → the channel is protected from model-only hides.
const DIM = 256;
const STORE = "rudder-learning-v2", OLD_STORE = "rudder-learning-v1"; // v1 held Gemma fingerprints

// fixed random projection IN → 256 (seeded, so every session and stored fingerprint agree)
const P = new Map();
function projection(IN) {
  if (P.has(IN)) return P.get(IN);
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) + 0.5) / 4294967296; };
  const m = new Float32Array(IN * DIM);
  for (let i = 0; i < m.length; i += 2) { const r = Math.sqrt(-2 * Math.log(rnd())), a = 2 * Math.PI * rnd(); m[i] = r * Math.cos(a); m[i + 1] = r * Math.sin(a); }
  P.set(IN, m);
  return m;
}
// rows of numbers (e.g. one MiniLM reading) → a unit-length 256-number fingerprint, stored as Int8 (×127)
export function fingerprint(rows) {
  if (!rows?.length) return null;
  const IN = rows[0].length, mean = new Float32Array(IN);
  for (const r of rows) for (let k = 0; k < IN; k++) mean[k] += r[k] / rows.length;
  const p = projection(IN), out = new Float32Array(DIM);
  for (let k = 0; k < IN; k++) { const m = mean[k]; if (m) for (let j = 0; j < DIM; j++) out[j] += m * p[k * DIM + j]; }
  const n = Math.hypot(...out) || 1;
  return Int8Array.from(out, (x) => Math.round((127 * x) / n));
}
const b64 = (a) => (a ? btoa(String.fromCharCode(...new Uint8Array(a.buffer, a.byteOffset, a.byteLength))) : null);
const unb64 = (s) => (s ? new Int8Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer) : null);
export const packPrint = (e) => (e ? { t: b64(e.t), i: b64(e.i) } : null);
export const unpackPrint = (e) => (e ? { t: unb64(e.t), i: unb64(e.i) } : null);

// features: text and image fingerprints (image zeros + a flag when there's no thumbnail), centred on the examples' mean
const raw = (e) => { const x = new Float32Array(2 * DIM + 1); for (let j = 0; j < DIM; j++) x[j] = (e.t?.[j] ?? 0) / 127; if (e.i) for (let j = 0; j < DIM; j++) x[DIM + j] = e.i[j] / 127; x[2 * DIM] = e.i ? 1 : 0; return x; };

export function createLearner(storage = globalThis.browser?.storage?.local) {
  const st = { examples: [], shown: [] }; // examples: { id, title, channel, like, e: {t,i}, at }; shown: { id, channel, e, at }
  let model = null, loaded = null, saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => storage?.set({ [STORE]: { examples: st.examples.map((x) => ({ ...x, e: packPrint(x.e) })), shown: st.shown.map((x) => ({ ...x, e: packPrint(x.e) })) } }).catch(() => {}), 500); };
  const load = () => (loaded ??= (async () => {
    const got = (await storage?.get([STORE, OLD_STORE]).catch(() => ({}))) ?? {};
    // from v1: keep your clicks (without their old fingerprints; reprint reads them again), drop the "shown" records
    const s = got[STORE] ?? (got[OLD_STORE] && { examples: got[OLD_STORE].examples.map((x) => ({ ...x, e: null })), shown: [] });
    // merged with anything recorded while loading (the first screen's videos are shown before this finishes)
    if (s) {
      const ids = new Set(st.examples.map((x) => x.id));
      st.examples = [...s.examples.map((x) => ({ ...x, e: unpackPrint(x.e) })).filter((x) => !ids.has(x.id)), ...st.examples];
      st.shown = [...s.shown.map((x) => ({ ...x, e: unpackPrint(x.e) })), ...st.shown];
    }
    train();
  })());

  function train() {
    const ex = st.examples.filter((x) => x.e), seen = new Set(ex.map((x) => x.id));
    const weak = st.shown.filter((x) => x.e && !seen.has(x.id)).slice(-300);
    const data = [...ex.map((x) => ({ x: raw(x.e), y: x.like ? 0 : 1, w: 1 })), ...weak.map((x) => ({ x: raw(x.e), y: 0, w: 0.2 }))];
    const dislikes = ex.filter((x) => !x.like).length;
    if (dislikes < 3 || data.length - dislikes < 3) { model = null; return; } // not enough yet: 3 👎 and 3 videos that were fine (👍 or seen)
    const D = 2 * DIM + 1, mu = new Float32Array(D);
    for (const d of data) for (let k = 0; k < D; k++) mu[k] += d.x[k] / data.length;
    for (const d of data) for (let k = 0; k < D; k++) d.x[k] -= mu[k];
    // class weights: dislikes are rare; balance them so the model doesn't just say "fine"
    const wPos = data.filter((d) => d.y).reduce((a, d) => a + d.w, 0), wNeg = data.filter((d) => !d.y).reduce((a, d) => a + d.w, 0);
    for (const d of data) d.w *= d.y ? 0.5 / wPos : 0.5 / wNeg;
    let w = new Float32Array(D), b = 0;
    for (let it = 0; it < 300; it++) { // full-batch gradient descent with L2
      const g = new Float32Array(D);
      let gb = 0;
      for (const d of data) {
        let z = b; for (let k = 0; k < D; k++) z += w[k] * d.x[k];
        const e = (1 / (1 + Math.exp(-z)) - d.y) * d.w;
        gb += e; for (let k = 0; k < D; k++) g[k] += e * d.x[k];
      }
      for (let k = 0; k < D; k++) w[k] -= 2 * (g[k] + 0.002 * w[k]);
      b -= 2 * gb;
    }
    model = { w, b, mu, n: ex.length };
  }
  // probability that you'd 👎 this video (null: no model yet or no fingerprint)
  function dislike(e) {
    if (!model || !e) return null;
    const x = raw(e);
    let z = model.b; for (let k = 0; k < x.length; k++) z += model.w[k] * (x[k] - model.mu[k]);
    return 1 / (1 + Math.exp(-z));
  }
  const channelStats = (ch) => { let up = 0, down = 0; if (ch) for (const x of st.examples) if (x.channel === ch) x.like ? up++ : down++; return { up, down }; };

  return {
    load,
    stats: () => ({ likes: st.examples.filter((x) => x.like).length, dislikes: st.examples.filter((x) => !x.like).length, learning: !!model, seen: st.shown.length, channels: [...new Set(st.examples.filter((x) => !x.like && x.channel).map((x) => x.channel))].filter((c) => { const s = channelStats(c); return s.down >= 2 && !s.up; }) }),
    // a 👍 / 👎 from the ⋮ menu (or the popup's review list)
    async feedback(v, like) {
      await load();
      st.examples = st.examples.filter((x) => x.id !== v.id);
      st.examples.push({ id: v.id, title: v.title ?? "", channel: v.channel ?? "", like, e: v.print ?? null, at: Date.now() });
      if (st.examples.length > 3000) st.examples.splice(0, st.examples.length - 3000);
      train();
      save();
    },
    // a video you were shown (weak "fine" unless you 👎 it)
    shown(v) {
      if (!v.print || st.shown.some((x) => x.id === v.id)) return;
      st.shown.push({ id: v.id, channel: v.channel ?? "", e: v.print, at: Date.now() });
      if (st.shown.length > 500) st.shown.splice(0, st.shown.length - 500);
      save();
    },
    forget() { st.examples = []; st.shown = []; model = null; save(); },
    // clicks without a fingerprint (from before, or made before it was read): read them now, from their titles
    async reprint(print) {
      await load();
      let n = 0;
      for (const x of st.examples) if (!x.e && x.title) { try { const e = await print(x); x.e = e?.t ? e : null; n++; } catch {} }
      if (n) { train(); save(); }
    },
    has: (id) => st.examples.some((x) => x.id === id),
    // what your feedback says about this video: { verdict: "hide" | "show" | null, why }
    judge(v) {
      const own = st.examples.find((x) => x.id === v.id);
      if (own) return { verdict: own.like ? "show" : "hide", why: own.like ? "you liked it" : "you disliked it", explicit: true };
      const ch = channelStats(v.channel);
      if (ch.down >= 2 && !ch.up) return { verdict: "hide", why: "a channel you disliked" };
      const p = dislike(v.print);
      if (p !== null && p > 0.75) return { verdict: "hide", why: `like videos you disliked (${Math.round(p * 100)}%)`, p };
      if (ch.up && !ch.down) return { verdict: "show", why: "a channel you liked" };
      if (p !== null && p < 0.1) return { verdict: "show", why: "like videos you liked", p };
      return { verdict: null, p };
    },
  };
}
