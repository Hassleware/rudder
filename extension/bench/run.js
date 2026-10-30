// Runs in the background page (it has the model).
// run: scores the shipped filter (probe.js) on the dev passages (filters.json) and the held-out ones
// (filters-test.json), at its fixed threshold. dump: saves every passage's and sentence's 35 layer outputs (f16) to
// a local server, for research/probe-research.mjs.
import { passages, report } from "./metrics.js";
import { PROBE, TIERS, score, smooth, confidence } from "../probe.js";

const load = async (f) => (await fetch(new URL(f, import.meta.url))).json();
const SPLITS = [["dev", "filters.json"], ["test", "filters-test.json"]];

export async function run({ layerStates, makeFilter, log = () => {} }) {
  const start = performance.now(), [pre] = (await load("filters.json")).templates.content.reply.split("{text}"), out = {};
  for (const [split, file] of SPLITS) {
    const b = await load(file), probes = [];
    for (const f of b.filters) probes.push({ id: f.id, p: (await makeFilter(f.sentence)).probe });
    const scores = Object.fromEntries(b.filters.map((f) => [f.id, {}]));
    for (const p of passages(b)) {
      const texts = p.kind === "mixed" ? [p.before, p.after] : [p.text];
      const parts = (await layerStates([pre, ...texts, ""], PROBE.layer)).pieces.slice(1, 1 + texts.length);
      for (const { id, p: pr } of probes) {
        const z = smooth(parts.flat().map((x) => score(pr, x))); // smoothing runs straight on across a mixed passage
        scores[id][p.id] = p.kind === "mixed" ? { before: z.slice(0, parts[0].length), after: z.slice(parts[0].length) } : z;
      }
    }
    out[split] = report(b, scores, 0.05, PROBE.z);
    log(`${split} done, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  }
  return { seconds: Math.round((performance.now() - start) / 1000), ...out };
}

export async function dump({ layerStates, url, log = () => {} }) {
  const dev = await load("filters.json"), [pre] = dev.templates.content.reply.split("{text}"), index = {};
  const save = async (key, parts, meta) => {
    const states = parts.flat(), file = key.replace(/[^\w.-]/g, "_") + ".bin", buf = new Float16Array(states.length * 35 * 1536);
    states.forEach((s, i) => buf.set(s, i * 35 * 1536));
    await fetch(`${url}?acts-${encodeURIComponent(file)}`, { method: "POST", body: buf.buffer });
    index[key] = { file, n: states.length, parts: parts.map((p) => p.length), ...meta };
  };
  const sentences = new Set([dev.templates.neutral, ...dev.topicBank]);
  for (const [split, file] of SPLITS) {
    const b = await load(file);
    for (const f of b.filters) [f.sentence, ...f.paraphrases].forEach((s) => sentences.add(s));
    for (const p of passages(b)) {
      const texts = p.kind === "mixed" ? [p.before, p.after] : [p.text];
      await save(`${split}:${p.id}`, (await layerStates([pre, ...texts, ""])).pieces.slice(1, 1 + texts.length), { split, kind: p.kind, filter: p.filter ?? null });
    }
    log(`${split} passages saved`);
  }
  await save("baseline", [(await layerStates([pre, dev.baselineText, ""])).pieces[1]], { kind: "baseline" });
  for (const s of sentences) {
    await save(`raw:${s}`, [(await layerStates(["", s, ""])).pieces[1]], { kind: "sentence", mode: "raw", sentence: s });
    await save(`reply:${s}`, [(await layerStates([pre, s, ""])).pieces[1]], { kind: "sentence", mode: "reply", sentence: s });
  }
  await fetch(`${url}?acts-index.json`, { method: "POST", body: JSON.stringify(index) });
  log(`dump done: ${Object.keys(index).length} items`);
}

// Needle in a haystack. 1: all pages as one long text, scored by every filter (false alarms). 2: each needle (two
// passing mentions, one on-topic sentence, one look-alike per filter) hidden after page k, with the ~300 words before it
// and ~40 after; did the filter flag it, and how confidently (tier of the over-threshold words in it and the 8 after)?
export async function haystack({ layerStates, makeFilter, log = () => {} }) {
  const start = performance.now(), h = await load("haystack.json"), [pre] = (await load("filters.json")).templates.content.reply.split("{text}");
  const filters = [], probes = {};
  for (const [, file] of SPLITS) filters.push(...(await load(file)).filters);
  for (const f of filters) probes[f.id] = (await makeFilter(f.sentence)).probe;
  const zs = (id, xs) => smooth(xs.map((x) => score(probes[id], x)));
  const tierOf = (z, c) => TIERS[Math.max(0, ...c.map((x, i) => (z[i] > PROBE.z ? TIERS.indexOf(x.tier) : 0)))];
  const pages = (await layerStates([pre, h.pages.join("\n\n"), ""], PROBE.layer)).pieces[1];
  const quiet = filters.map((f) => {
    const z = zs(f.id, pages), c = confidence(z), over = c.filter((_, i) => z[i] > PROBE.z);
    return { filter: f.id, tokens: z.length, over: over.length, ...Object.fromEntries(TIERS.slice(1).map((t) => [t, over.filter((x) => x.tier === t).length])) };
  });
  log(`pages alone: ${pages.length} tokens, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  const words = (t) => t.split(/\s+/), needles = [];
  let k = 0;
  for (const f of filters) {
    for (const [kind, text] of [["mention", h.mentions[f.id][0]], ["mention", h.mentions[f.id][1]], ["direct", f.direct[0]], ["look-alike", f.hardNeg[0]]]) {
      const after = 3 + (k++ % (h.pages.length - 4)); // hide it after this page
      const before = words(h.pages.slice(0, after).join("\n\n")).slice(-300).join(" "), rest = words(h.pages.slice(after).join(" ")).slice(0, 40).join(" ");
      const x = (await layerStates([pre, before + "\n\n", text, " " + rest, ""], PROBE.layer)).pieces;
      const z = zs(f.id, [...x[1], ...x[2], ...x[3]]), c = confidence(z), a = x[1].length, b = a + x[2].length + 8;
      needles.push({ filter: f.id, kind, text, tier: tierOf(z.slice(a, b), c.slice(a, b)), peak: Math.max(...z.slice(a, b)), top3: Math.max(...c.slice(a, b).map((y) => y.top3)), falseBefore: z.slice(0, a).filter((y) => y > PROBE.z).length });
    }
    log(`${f.id} needles done, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  }
  return { seconds: Math.round((performance.now() - start) / 1000), quiet, needles };
}
