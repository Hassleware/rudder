// Runs in the background page (it has the model).
// run: scores the shipped filter (probe → judge cascade, probe.js) on the dev passages (filters.json) and the held-out
// ones (filters-test.json). haystack: passing mentions hidden in pages of ordinary text. dump: saves every passage's and
// sentence's 35 layer outputs (f16) to a local server, for research/probe-research.mjs.
import { passages, report } from "./metrics.js";
import { PROBE, sentences } from "../probe.js";

const load = async (f) => (await fetch(new URL(f, import.meta.url))).json();
const SPLITS = [["dev", "filters.json"], ["test", "filters-test.json"]];
const pre = async () => (await load("filters.json")).templates.content.reply.split("{text}")[0];
// a text's sentences and their probe-layer token states
async function read(layerStates, sents) {
  return (await layerStates([await pre(), ...sents, ""], PROBE.layer)).pieces.slice(1, 1 + sents.length);
}

// Each passage is split into sentences and run through the cascade for every filter; it "fires" if any sentence is
// blocked. AUROC uses the cascade's per-sentence score (> 0 = blocked).
export async function run({ layerStates, makeFilter, cascadeRun, log = () => {} }) {
  const start = performance.now(), out = {};
  for (const [split, file] of SPLITS) {
    const b = await load(file), filters = [];
    for (const f of b.filters) filters.push({ id: f.id, fl: await makeFilter(f.sentence) });
    const scores = Object.fromEntries(b.filters.map((f) => [f.id, {}]));
    for (const p of passages(b)) {
      const before = p.kind === "mixed" ? sentences(p.before) : [], sents = p.kind === "mixed" ? [...before, ...sentences(p.after)] : sentences(p.text);
      const st = await read(layerStates, sents);
      for (const { id, fl } of filters) {
        const sc = (await cascadeRun(fl, sents, st)).sentences.map((s) => s.score);
        scores[id][p.id] = p.kind === "mixed" ? { before: sc.slice(0, before.length), after: sc.slice(before.length) } : sc;
      }
    }
    out[split] = report(b, scores, 0.05, 0);
    log(`${split} done, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  }
  return { seconds: Math.round((performance.now() - start) / 1000), ...out };
}

// Needle in a haystack. 1: all pages as one long text, through every filter's cascade (false alarms, judge calls).
// 2: each needle (two passing mentions, one on-topic sentence, one look-alike per filter) hidden after page k, with the
// ~300 words before it and ~40 after: was its sentence blocked?
export async function haystack({ layerStates, makeFilter, cascadeRun, log = () => {} }) {
  const start = performance.now(), h = await load("haystack.json"), filters = [], fls = {};
  for (const [, file] of SPLITS) filters.push(...(await load(file)).filters);
  for (const f of filters) fls[f.id] = await makeFilter(f.sentence);
  const pageSents = h.pages.flatMap((pg) => sentences(pg + "\n\n")), pst = await read(layerStates, pageSents);
  const words = (t) => t.split(/\s+/), quiet = [];
  for (const f of filters) {
    const r = (await cascadeRun(fls[f.id], pageSents, pst)).sentences;
    quiet.push({ filter: f.id, words: words(h.pages.join(" ")).length, blocked: r.filter((s) => s.score > 0).length, judged: r.filter((s) => s.margin !== undefined).length });
  }
  log(`pages alone: ${pageSents.length} sentences, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  const needles = [];
  let k = 0;
  for (const f of filters) {
    for (const [kind, text] of [["mention", h.mentions[f.id][0]], ["mention", h.mentions[f.id][1]], ["direct", f.direct[0]], ["look-alike", f.hardNeg[0]]]) {
      const after = 3 + (k++ % (h.pages.length - 4)); // hide it after this page
      const before = sentences(words(h.pages.slice(0, after).join("\n\n")).slice(-300).join(" ") + "\n\n"), needle = sentences(text);
      const sents = [...before, ...needle, ...sentences(" " + words(h.pages.slice(after).join(" ")).slice(0, 40).join(" "))];
      const r = (await cascadeRun(fls[f.id], sents, await read(layerStates, sents))).sentences;
      const hit = r.slice(before.length, before.length + needle.length).reduce((a, s) => (s.score > a.score ? s : a));
      needles.push({ filter: f.id, kind, text, caught: hit.score > 0, verdict: hit.verdict, peak: hit.peak, margin: hit.margin, falseBefore: r.slice(0, before.length).filter((s) => s.score > 0).length });
    }
    log(`${f.id} needles done, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  }
  return { seconds: Math.round((performance.now() - start) / 1000), quiet, needles };
}

export async function dump({ layerStates, url, log = () => {} }) {
  const dev = await load("filters.json"), p0 = await pre(), index = {};
  const save = async (key, parts, meta) => {
    const states = parts.flat(), file = key.replace(/[^\w.-]/g, "_") + ".bin", buf = new Float16Array(states.length * 35 * 1536);
    states.forEach((s, i) => buf.set(s, i * 35 * 1536));
    await fetch(`${url}?acts-${encodeURIComponent(file)}`, { method: "POST", body: buf.buffer });
    index[key] = { file, n: states.length, parts: parts.map((p) => p.length), ...meta };
  };
  const said = new Set([dev.templates.neutral, ...dev.topicBank]);
  for (const [split, file] of SPLITS) {
    const b = await load(file);
    for (const f of b.filters) [f.sentence, ...f.paraphrases].forEach((s) => said.add(s));
    for (const p of passages(b)) {
      const texts = p.kind === "mixed" ? [p.before, p.after] : [p.text];
      await save(`${split}:${p.id}`, (await layerStates([p0, ...texts, ""])).pieces.slice(1, 1 + texts.length), { split, kind: p.kind, filter: p.filter ?? null });
    }
    log(`${split} passages saved`);
  }
  await save("baseline", [(await layerStates([p0, dev.baselineText, ""])).pieces[1]], { kind: "baseline" });
  for (const s of said) {
    await save(`raw:${s}`, [(await layerStates(["", s, ""])).pieces[1]], { kind: "sentence", mode: "raw", sentence: s });
    await save(`reply:${s}`, [(await layerStates([p0, s, ""])).pieces[1]], { kind: "sentence", mode: "reply", sentence: s });
  }
  await fetch(`${url}?acts-index.json`, { method: "POST", body: JSON.stringify(index) });
  log(`dump done: ${Object.keys(index).length} items`);
}
