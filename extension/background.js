// Runs the model. The background page lives as long as Firefox, so the popup can close and reopen instantly.
// The model downloads once (~2.9 GB) into the extension's own storage; after that it loads from disk.
import "./gpu-fixes.js";
import { CreateMLCEngine, hasModelInCache } from "./vendor/web-llm.js";
import { videos as youtubeVideos, setJudge as setYoutubeJudge, setFilters as setYoutubeFilters, setEnabled as setYoutubeEnabled, stats as youtubeStats } from "./youtube/intercept.js";
import { TAP, PROBE, mean, makeProbe, score, smooth, top3, sentences, cascade, CASCADE, CASCADE_TITLES } from "./probe.js";

const MODEL_ID = "gemma-4-E2B-it-q4f16_1-MLC";
const IDLE_MS = 10 * 60 * 1000; // free the VRAM after 10 minutes without use
const firefox = /firefox/i.test(navigator.userAgent);

let engine = null, loading = null, idleTimer = null;
let status = "Starting…", history = [], partial = null; // partial = reply being written right now
const ports = new Set();

const send = (msg) => ports.forEach((p) => p.postMessage(msg));
const setStatus = (text) => { status = text; send({ type: "status", text }); };
let installed = null; // is the model on disk? null = not checked yet
// setup = show the popup's Download / Import buttons
let snapOn = false; // record each reply for the snapshot viewer
const snapshot = () => ({ type: "init", history, partial, status, snapOn, setup: installed === false && !engine && !loading });

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(unload, IDLE_MS);
}

async function unload() {
  if (partial !== null || ports.size) return touch(); // never while chatting or while the popup is open
  const e = engine;
  engine = null; loading = null;
  await e?.unload();
  setStatus("Unloaded to free GPU memory. It reloads when you send a message.");
}

// Mirror of the model's memory (KV cache): every token id it holds, in order. Every token reaches the cache through
// one of the pipeline's forward functions (Gemma 4 uses the "artifact" pair), and WebLLM updates
// filledKVCacheLength inside them, so trimming to that length keeps the mirror exact across turns, New chat and
// re-reads. While recording, each forward pass is logged too.
let kv = [], passes = null;
function trackKV(e) {
  const p = e.loadedModelIdToPipeline.get(MODEL_ID);
  const note = (ids, reading) => {
    const pos = p.filledKVCacheLength - ids.length;
    kv.length = Math.max(0, pos);
    kv.push(...ids);
    passes?.push({ pos, n: ids.length, reading });
  };
  const pre = p.artifactPrefillAndForward.bind(p), dec = p.artifactDecodeAndForward.bind(p);
  p.artifactPrefillAndForward = (emb, ids, mod) => { const r = pre(emb, ids, mod); note(Array.from(ids), true); return r; };
  p.artifactDecodeAndForward = (id) => { const r = dec(id); note([id], false); return r; };
}

function load() {
  if (engine) return Promise.resolve(engine);
  if (!loading) setStatus("Loading model…");
  return (loading ??= (async () => {
    // WebLLM waits for the GPU after each of ~1700 weight uploads; in Firefox each wait costs ~100 ms.
    // During load only really wait every 32nd time (uploads stay in order on the GPU queue).
    const q = GPUQueue.prototype, realDone = q.onSubmittedWorkDone;
    let calls = 0;
    if (firefox) q.onSubmittedWorkDone = function () { return ++calls % 32 ? Promise.resolve() : realDone.call(this); };
    try {
      const e = await CreateMLCEngine(MODEL_ID, { initProgressCallback: (p) => setStatus(p.text) });
      q.onSubmittedWorkDone = realDone;
      kv = [];
      trackKV(e);
      // Firefox takes ~40 s to compile the prompt-reading attention kernel; 1 token per step avoids it.
      if (firefox) e.loadedModelIdToPipeline.get(MODEL_ID).prefillChunkSize = 1;
      setStatus("Warming up GPU…");
      await e.chat.completions.create({ messages: [{ role: "user", content: "hi" }], max_tokens: 2, temperature: 0 });
      await e.resetChat();
      if (firefox && !wide) { // build the multi-token kernel once, so filters can read text in one pass (see feed())
        setStatus("Preparing the filters' fast reader (once per Firefox session)…");
        const t0 = performance.now(), p = e.loadedModelIdToPipeline.get(MODEL_ID);
        wide = true;
        feed(p, Array.from({ length: 32 }, (_, i) => 1000 + i)); // a title-sized read, so the first real one isn't slow
        await p.device.sync();
        await e.resetChat();
        console.log(`fast reader built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      }
      engine = e;
      setStatus("Ready.");
      return e;
    } catch (err) {
      q.onSubmittedWorkDone = realDone;
      loading = null;
      setStatus("Load failed: " + err.message);
      throw err;
    }
  })());
}

// Keeps the recorded reply for snapshot.html: steps[k] = every GPU output while picking word k.
async function saveSnapshot() {
  const steps = await globalThis.gpuSnapshot.stop();
  const tok = engine?.loadedModelIdToPipeline.get(MODEL_ID)?.tokenizer;
  const text = (id) => (id === undefined || !tok ? "?" : tok.decode(Int32Array.of(id)));
  // the word each step picked is the sampler's last output
  const words = steps.map((s) => {
    const id = s.findLast((r) => r.name === "output_index_ptr")?.values[0];
    return { id, text: text(id) };
  });
  // which forward pass each step was: the last prompt-reading pass picks word 1, then one pass per word
  const p = passes ?? [];
  passes = null;
  const at = [p.filter((x) => x.reading).at(-1), ...p.filter((x) => !x.reading)].slice(0, steps.length);
  // the memory's tokens up to the last pass (each as text, so token boundaries can be shown)
  const last = at.at(-1);
  const tokens = kv.slice(0, last ? last.pos + last.n : 0).map((id) => ({ id, text: text(id) }));
  window.lastSnapshot = { steps, words, at, tokens, filter: await scoreSteps(steps, words) };
  setStatus(`${status} · snapshot: ${steps.length} words${steps.length >= 100 ? " (the first 100)" : ""}`);
  showViewer();
}

// refresh an open viewer, or open one
function showViewer() {
  const views = browser.extension.getViews({ type: "tab" }).filter((v) => v.location.pathname.endsWith("/snapshot.html"));
  if (views.length) views.forEach((v) => v.location.reload());
  else browser.tabs.create({ url: "snapshot.html" });
}

// Reads token ids into the model's memory. Firefox's build reads chat prompts one token at a time, because its
// multi-token kernel takes Firefox ~40 s to build; load() builds it once per session for the filters, and then this
// reads up to 512 tokens per GPU pass (chat keeps one token at a time, so the snapshot viewer is unchanged).
// logits: keep the last token's scores on the CPU (p.logitsOnCPU).
let wide = !firefox;
function feed(p, ids, logits = false) {
  const chunk = wide ? 512 : 1, size = p.prefillChunkSize;
  p.prefillChunkSize = chunk;
  try {
    for (let i = 0; i < ids.length; i += chunk) {
      const c = ids.slice(i, i + chunk);
      p.tvm.beginScope();
      const l = p.artifactPrefillAndForward(p.getArtifactTextEmbeddings(c), c, new Array(c.length).fill(0));
      if (logits && i + chunk >= ids.length) p.updateLogitsOnCPU(l);
      p.tvm.endScope();
    }
  } finally {
    p.prefillChunkSize = size;
  }
}

// Runs text through the model one token at a time (the same program Firefox uses to read a prompt) and returns each
// token's 35 layer outputs (35 × 1536 numbers), or only layer `layer`'s 1536 (long texts), grouped by piece: pieces
// are strings, read in order after <bos>. Clears the model's memory; the next chat message re-reads the history.
let probing = false;
async function layerStates(pieces, layer = null) {
  if (partial !== null || probing) throw new Error("The model is busy.");
  probing = true;
  try {
    const e = await load(), p = e.loadedModelIdToPipeline.get(MODEL_ID);
    const ids = pieces.map((s) => (s ? Array.from(p.tokenizer.encode(s)) : []));
    const all = [p.bosTokenId, ...ids.flat()], states = [];
    judgeKept = null;
    await e.resetChat();
    if (wide && layer !== null && layer < 34) { // one GPU pass; copy only that layer's output (all tokens at once)
      for (let i = 0; i < all.length; i += 512) {
        const chunk = all.slice(i, i + 512);
        let recs = [];
        globalThis.gpuSnapshot.start({ only: TAP, run: layer + 1, maxSteps: 1, bytes: chunk.length * 1536 * 4 });
        try {
          feed(p, chunk);
          await p.device.sync();
          globalThis.gpuSnapshot.tick();
        } finally {
          recs = (await globalThis.gpuSnapshot.stop()).flat();
        }
        if (recs.length !== 1) throw new Error(`Expected layer ${layer + 1}'s output once, got ${recs.length}.`);
        for (let t = 0; t < chunk.length; t++) states.push(Float32Array.from(recs[0].values.subarray(t * 1536, (t + 1) * 1536)));
      }
      await e.resetChat();
      let t = 1;
      return { pieces: ids.map((x) => states.slice(t, (t += x.length))) };
    }
    for (let i = 0; i < all.length; i += 32) { // 32 tokens × 35 outputs fit the 12 MB collection buffer
      const chunk = all.slice(i, i + 32);
      let recs = [];
      globalThis.gpuSnapshot.start({ only: TAP, maxSteps: 1, bytes: 1536 * 4 });
      try {
        for (const id of chunk) {
          p.tvm.beginScope();
          p.artifactPrefillAndForward(p.getArtifactTextEmbeddings([id]), [id], [0]);
          p.tvm.endScope();
        }
        await p.device.sync();
        globalThis.gpuSnapshot.tick();
      } finally {
        recs = (await globalThis.gpuSnapshot.stop()).flat();
      }
      if (recs.length !== chunk.length * 35) throw new Error(`Expected 35 layer outputs per token, got ${recs.length / chunk.length}.`);
      for (let t = 0; t < chunk.length; t++) {
        states.push(layer === null ? stack(recs.slice(t * 35, t * 35 + 35)) : Float32Array.from(recs[t * 35 + layer].values.subarray(0, 1536)));
      }
    }
    await e.resetChat();
    let t = 1; // after <bos>
    return { pieces: ids.map((x) => states.slice(t, (t += x.length))) };
  } finally {
    probing = false;
  }
}
// Gemma as a Yes/No judge of one piece of text against a filter sentence: returns logit(Yes) − logit(No) for its first
// answer word. The fixed start of the prompt (with the filter sentence) stays in the model's memory between calls and
// each call reads only the text and the question, then rolls the memory back (TVM's kv_state_popn). With the fast
// reader (feed()) the whole prompt is read in one pass from empty memory instead. Clears the chat's memory like layerStates.
let judgeKept = null; // { sentence, n }: the prompt start currently in memory
async function judge(filterSentence, text) {
  if (partial !== null || probing) throw new Error("The model is busy.");
  probing = true;
  try {
    const e = await load(), p = e.loadedModelIdToPipeline.get(MODEL_ID), tok = p.tokenizer;
    const question = `"\nDoes the text contain anything the filter describes? Answer only Yes or No.<turn|>\n<|turn>model\n`;
    if (wide) { // the whole prompt in one pass from empty memory (adding onto kept memory needs another kernel, ~40 s to build)
      judgeKept = null;
      await e.resetChat();
      feed(p, [p.bosTokenId, ...tok.encode(`<|turn>user\nYou are a content filter. Filter: "${filterSentence}"\nText: "${text}${question}`)], true);
      await p.device.sync();
      const a = p.logitsOnCPU.toArray();
      return a[YES_NO(tok)[0]] - a[YES_NO(tok)[1]];
    }
    if (judgeKept?.sentence !== filterSentence || p.filledKVCacheLength !== judgeKept.n) {
      await e.resetChat();
      feed(p, [p.bosTokenId, ...tok.encode(`<|turn>user\nYou are a content filter. Filter: "${filterSentence}"\nText: "`)]);
      judgeKept = { sentence: filterSentence, n: p.filledKVCacheLength };
    }
    const ids = Array.from(tok.encode(`${text}${question}`));
    feed(p, ids, true);
    await p.device.sync();
    const a = p.logitsOnCPU.toArray(), margin = a[YES_NO(tok)[0]] - a[YES_NO(tok)[1]];
    try { // roll back to the prompt start
      popn ??= p.tvm.getGlobalFunc("vm.builtin.kv_state_popn");
      for (const s of p.getActiveKVStates()) popn(s, p.tvm.scalar(0, "int64"), p.tvm.scalar(ids.length, "int32"));
      p.filledKVCacheLength -= ids.length;
    } catch {
      judgeKept = null; // no roll-back: start fresh next time
    }
    return margin;
  } finally {
    probing = false;
  }
}
let popn = null, yesNo = null;
const YES_NO = (tok) => (yesNo ??= [tok.encode("Yes")[0], tok.encode("No")[0]]);

// one token's 35 layer-output records → one 35 × 1536 vector
function stack(taps) {
  const v = new Float32Array(35 * 1536);
  taps.forEach((r, l) => v.set(r.values.subarray(0, 1536), l * 1536));
  return v;
}

// The filter set in the viewer (method and numbers in probe.js). The topic bank and ordinary text are the same for
// every filter, so they're read once and kept.
let filter = null, benchFile = null, common = null;
const bench = async () => (benchFile ??= await (await fetch("bench/filters.json")).json());
async function makeFilter(sentence) {
  const b = await bench(), [pre] = b.templates.content.reply.split("{text}");
  const read = async (s) => (await layerStates([pre, s, ""], PROBE.layer)).pieces[1].at(-1); // the sentence as a chat reply, last token
  if (!common) {
    const bank = [];
    for (const s of [b.templates.neutral, ...b.topicBank]) bank.push(await read(s));
    common = { ref: mean(bank), ordinary: (await layerStates([pre, b.baselineText, ""], PROBE.layer)).pieces[1] };
  }
  return { sentence, probe: makeProbe(await read(sentence), common.ref, common.ordinary) };
}
// The cascade over a run of sentences (each sentence's tokens' probe-layer states): per-word scores and
// and one verdict per sentence (the judge only reads sentences in the unsure band).
async function cascadeRun(fl, sents, states, rule = CASCADE) {
  const z = smooth(states.flat().map((x) => score(fl.probe, x))), best3 = top3(z), out = [];
  let i = 0;
  for (const [k, ss] of states.entries()) {
    const a = i, b = (i += ss.length);
    if (a === b) { out.push({ a, b, verdict: "clear", score: -99 }); continue; }
    const peak = Math.max(...z.slice(a, b)), b3 = Math.max(...best3.slice(a, b));
    out.push({ a, b, peak, top3: b3, ...(await cascade(peak, b3, () => judge(fl.sentence, sents[k].trim()), rule)) });
  }
  return { z, sentences: out };
}
// Score a recorded reply: word k's own state is in step k + 1 (when it's fed back in to pick the next word), so the
// last word has none. Words are grouped into sentences for the cascade.
async function scoreSteps(steps, words) {
  if (!filter) return null;
  const state = (recs) => {
    const taps = (recs ?? []).filter((r) => TAP.test(r.kernel));
    return taps.length === 35 ? Float32Array.from(taps[PROBE.layer].values.subarray(0, 1536)) : null;
  };
  const n = words.findLastIndex((_, k) => state(steps[k + 1])) + 1, groups = [];
  for (let k = 0; k < n; k++) {
    if (!groups.length || /[.!?\n]/.test(words[k - 1].text)) groups.push([]);
    groups.at(-1).push(k);
  }
  const r = await cascadeRun(filter, groups.map((g) => g.map((k) => words[k].text).join("")), groups.map((g) => g.map((k) => state(steps[k + 1]))));
  const verdict = Array(words.length).fill(null);
  r.sentences.forEach((s, g) => groups[g].forEach((k) => (verdict[k] = s)));
  return { sentence: filter.sentence, ...CASCADE, smooth: r.z, verdict };
}
// for the viewer: set (or clear, with "") the filter and rescore the last snapshot
window.setFilter = async (sentence) => {
  filter = sentence ? await makeFilter(sentence) : null;
  if (window.lastSnapshot) window.lastSnapshot.filter = await scoreSteps(window.lastSnapshot.steps, window.lastSnapshot.words);
  showViewer();
};
window.filterSentence = () => filter?.sentence ?? "";
// for bench/bench.html: score the filter on the benchmark (GPU, about a minute)
window.runBench = async (log) => (await import("./bench/run.js")).run({ layerStates, makeFilter, cascadeRun, log });
// for research/probe-research.mjs: dump every benchmark passage's layer outputs to a local server (GPU, about a minute)
// for bench/bench.html: a passing mention hidden in pages of ordinary text (GPU, a few minutes)
window.runHaystack = async (log) => (await import("./bench/run.js")).haystack({ layerStates, makeFilter, cascadeRun, log });
window.dumpBench = async (url, log) => (await import("./bench/run.js")).dump({ layerStates, url, log });

async function chat(text) {
  if (partial !== null || !text) return;
  if (probing) { send({ type: "error", text: "The filter probe is using the model; try again in a moment." }); return send({ type: "done" }); }
  touch();
  history.push({ role: "user", content: text });
  partial = "";
  send({ type: "user", text });
  const start = performance.now();
  let t0 = 0, n = 0;
  let recording = false;
  try {
    const e = await load();
    if (judgeKept) { judgeKept = null; await e.resetChat(); } // the judge's prompt start is in memory
    // Snapshot on: record every layer's output for each word of this reply. The first job of a forward pass is
    // the embedding lookup; prompt-reading passes that pick no word are dropped.
    if (snapOn) { globalThis.gpuSnapshot.start({ stepStart: /^fused_dequantize_take2/ }); passes = []; recording = true; }
    const stream = await e.chat.completions.create({
      messages: history, stream: true, temperature: 0, max_tokens: 1024,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        if (!t0) t0 = performance.now(); else n++;
        partial += delta;
        send({ type: "delta", text: delta });
      }
      const s = chunk.usage?.extra?.decode_tokens_per_s;
      if (s) setStatus(`${s.toFixed(1)} tok/s · first token after ${((t0 - start) / 1000).toFixed(1)}s`);
    }
    history.push({ role: "assistant", content: partial });
  } catch (err) {
    history.pop(); // drop the user turn that failed
    send({ type: "error", text: err.message });
  }
  partial = null;
  if (recording) await saveSnapshot().catch((err) => setStatus("Snapshot scoring failed: " + err.message));
  send({ type: "done" });
  touch();
}

browser.runtime.onConnect.addListener(async (port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => { ports.delete(port); touch(); });
  port.onMessage.addListener((msg) => {
    if (msg.type === "load") { load().catch(() => {}); send(snapshot()); } // the popup's Download button
    if (msg.type === "send") chat(msg.text.trim());
    if (msg.type === "snapshot") { // toggle: record each reply for the viewer (snapshot.html)
      snapOn = !snapOn;
      setStatus(snapOn ? "Snapshot on: each reply is recorded word by word (slower replies)." : "Snapshot off.");
      send(snapshot());
    }
    if (msg.type === "filters") port.postMessage(ytState());
    if (msg.type === "set-filters") setYoutubeSettings(msg);
    if (msg.type === "clear" && partial === null) {
      history = [];
      engine?.resetChat();
      send(snapshot());
    }
  });
  // Load as soon as the popup opens, but only if the model is already on disk: never start a
  // 2.9 GB download without the user asking (the popup shows Download / Import buttons instead).
  if (!engine && !loading) {
    installed = await hasModelInCache(MODEL_ID).catch(() => false);
    if (installed) load().catch(() => {});
    else setStatus("Model not installed yet.");
  }
  port.postMessage(snapshot());
  port.postMessage(ytState());
});
// YouTube: videos read from the page's own data and downloads before it draws them (youtube/intercept.js); each home
// tile is shown only once the filter below has passed it.
window.youtubeVideos = youtubeVideos;
// What the YouTube filter blocks. Layer 2: each filter has its own gate (the probe score below which the judge isn't
// asked), tuned by hand-labelling 129 home-feed videos (2026-10-30): AI 2.5 (judge runs 30% → 11%, no misses); gaming
// stays 1.5 (its probe is weak on short titles: 2.0 already misses 4 of 42). A new filter gets 1.5. The user's list is
// set in the popup and kept in extension storage ("yt-settings"); these are the first-run defaults.
const YOUTUBE_FILTERS = [{ sentence: "anything about gaming", gate: 1.5 }, { sentence: "anything about AI", gate: 2.5 }];
const NEW_GATE = 1.5;
let yt = { enabled: true, filters: YOUTUBE_FILTERS };

// Layer 4: batches. WebLLM's memory (KV cache) holds one sequence, so the filter makes its own with room for 16, using
// the model's own create_kv_cache, and runs many texts through the model in ONE GPU pass, each in its own sequence (so
// they can't see each other). The chat's memory is never touched. Up to 512 tokens and 16 texts per pass (the size the
// model's buffers were planned for). Needs the fast reader (wide).
const FILTER_SEQS = 16;
let filterKV = null, filterKVFor = null;
function filterMemory(p) {
  if (filterKVFor !== p) {
    p.tvm.beginScope();
    const create = p.vm.getFunction(p.artifact?.program.exports.create_kv_cache ?? "create_tir_paged_kv_cache");
    filterKV = p.tvm.detachFromCurrentScope(create(p.tvm.makeShapeTuple([FILTER_SEQS]), p.tvm.makeShapeTuple([2048]), p.tvm.makeShapeTuple([512]), p.tvm.makeShapeTuple([16]), p.tvm.makeShapeTuple([0])));
    p.tvm.endScope();
    filterKVFor = p;
  }
  return filterKV;
}
// group token sequences into passes of ≤512 tokens and ≤16 sequences
function packPasses(seqs) {
  const out = [];
  let cur = [], n = 0;
  seqs.forEach((s, k) => {
    if (cur.length && (n + s.length > 512 || cur.length === FILTER_SEQS)) { out.push(cur); cur = []; n = 0; }
    cur.push(k); n += s.length;
  });
  if (cur.length) out.push(cur);
  return out;
}
// one GPU pass: each sequence into its own slot (0, 1, …) of the filter's memory, cleared first
function multiPrefill(p, kv, seqs) {
  p.fclearKVCaches(kv);
  seqs.forEach((_, k) => p.fKVCacheAddSequence(kv, p.tvm.scalar(k, "int64")));
  const all = seqs.flat(), size = p.prefillChunkSize;
  p.prefillChunkSize = 512;
  p.tvm.beginScope();
  try {
    const emb = p.getArtifactTextEmbeddings(all), view = emb.view([1, all.length, emb.shape[1]]);
    const ids = [all, new Array(all.length).fill(0)].map((x) => p.tvm.empty([1, all.length], "int32", p.device).copyFrom(x));
    p.fKVCacheBeginForward(kv, p.tvm.makeShapeTuple(seqs.map((_, k) => k)), p.tvm.makeShapeTuple(seqs.map((x) => x.length)));
    try { p.prefill(view, ...ids, kv, p.params); } finally { p.fKVCacheEndForward(kv); }
  } finally {
    p.tvm.endScope();
    p.prefillChunkSize = size;
  }
}
// run fn(p, kv) with the model to ourselves
async function withFilterModel(fn) {
  if (partial !== null || probing) throw new Error("The model is busy.");
  probing = true;
  try {
    const e = await load(), p = e.loadedModelIdToPipeline.get(MODEL_ID);
    if (!wide) throw new Error("the fast reader isn't built");
    return await fn(p, filterMemory(p));
  } finally {
    probing = false;
  }
}
// each text's probe-layer states (after the chat-reply prefix, like layerStates), many texts per pass
async function batchStates(texts) {
  return withFilterModel(async (p, kv) => {
    const [pre] = (await bench()).templates.content.reply.split("{text}"), tok = p.tokenizer;
    const head = [p.bosTokenId, ...tok.encode(pre)], seqs = texts.map((t) => [...head, ...tok.encode(t)]), out = [];
    for (const group of packPasses(seqs)) {
      const g = group.map((k) => seqs[k]);
      let recs = [];
      globalThis.gpuSnapshot.start({ only: TAP, run: PROBE.layer + 1, maxSteps: 1, bytes: g.flat().length * 1536 * 4 });
      try {
        multiPrefill(p, kv, g);
        await p.device.sync();
        globalThis.gpuSnapshot.tick();
      } finally {
        recs = (await globalThis.gpuSnapshot.stop()).flat();
      }
      if (recs.length !== 1) throw new Error(`Expected layer ${PROBE.layer + 1}'s output once, got ${recs.length}.`);
      let at = 0;
      for (const k of group) {
        out[k] = [];
        for (let t = at + head.length; t < at + seqs[k].length; t++) out[k].push(Float32Array.from(recs[0].values.subarray(t * 1536, (t + 1) * 1536)));
        at += seqs[k].length;
      }
    }
    return out;
  });
}
// the judge for many (filter, text) pairs: every prompt but its last token in one pass, then one single-token step per
// prompt (each in its own slot) for its Yes/No scores. Same prompt and scores as judge(), just batched.
async function batchJudge(pairs) {
  return withFilterModel(async (p, kv) => {
    const tok = p.tokenizer, [YES, NO] = YES_NO(tok), out = [];
    const prompts = pairs.map(({ filter, text }) => [p.bosTokenId, ...tok.encode(`<|turn>user\nYou are a content filter. Filter: "${filter}"\nText: "${text}"\nDoes the text contain anything the filter describes? Answer only Yes or No.<turn|>\n<|turn>model\n`)]);
    for (const group of packPasses(prompts)) {
      const g = group.map((k) => prompts[k]);
      multiPrefill(p, kv, g.map((x) => x.slice(0, -1)));
      // every prompt's last step queued with a copy of its scores to the CPU, then one wait for all of them
      const cpu = [];
      for (const [slot, k] of group.entries()) {
        p.tvm.beginScope();
        try {
          const input = p.tvm.empty([1, 1], "int32", p.device).copyFrom([prompts[k].at(-1)]);
          p.fKVCacheBeginForward(kv, p.tvm.makeShapeTuple([slot]), p.tvm.makeShapeTuple([1]));
          try {
            const logits = p.decoding(input, kv, p.params).get(0);
            cpu.push([k, p.tvm.detachFromCurrentScope(p.tvm.empty(logits.shape, logits.dtype, p.tvm.cpu()).copyFrom(logits))]);
          } finally { p.fKVCacheEndForward(kv); }
        } finally {
          p.tvm.endScope();
        }
      }
      await p.device.sync();
      for (const [k, arr] of cpu) {
        const a = arr.toArray();
        out[k] = a[YES] - a[NO];
        arr.dispose();
      }
    }
    return out;
  });
}

// A batch of YouTube videos through the filters: title with the channel attached ("… — channel: IGN"; thumbnails need
// the vision path, still research). Probe per filter on the title's words: below the filter's gate → clear; top-3
// average ≥ certain → blocked; otherwise unsure. Layer 3: one judge call per video for all its unsure filters at once
// (Filter: "anything about gaming" or "anything about AI"), and each unsure filter blocks if its probe peak + w × that
// margin > t (CASCADE_TITLES). The verdict is per video, so a shared judge answer is enough.
let youtubeBatch = true; // false or the reason, if batches failed and videos are read one by one
async function judgeYoutube(videos, fls) {
  const texts = videos.map((v) => (v.channel ? `${v.title} — channel: ${v.channel}` : v.title));
  const [pre] = (await bench()).templates.content.reply.split("{text}");
  const batched = async (fast, slow) => {
    if (youtubeBatch === true) {
      try { return await fast(); } catch (err) { if (/busy/i.test(err.message)) throw err; youtubeBatch = err.message; console.warn("batches failed, one at a time:", err); }
    }
    return slow();
  };
  const states = await batched(() => batchStates(texts), async () => { const r = []; for (const t of texts) r.push((await layerStates([pre, t, ""], PROBE.layer)).pieces[1]); return r; });
  const rows = videos.map((_, i) => {
    const verdicts = {}, unsure = [];
    for (const fl of fls) {
      const z = smooth(states[i].map((x) => score(fl.probe, x))), peak = Math.max(...z), best3 = Math.max(...top3(z)), rule = { ...CASCADE_TITLES, gate: fl.gate };
      if (peak <= rule.gate) verdicts[fl.sentence] = { blocked: false, verdict: "clear", peak };
      else if (best3 >= rule.certain) verdicts[fl.sentence] = { blocked: true, verdict: "blocked", peak };
      else unsure.push({ fl, peak, rule });
    }
    return { verdicts, unsure };
  });
  // layer 3: one judge question per video for all its unsure filters; all videos' questions in one batch
  const asks = rows.map((r, i) => (r.unsure.length ? { i, filter: r.unsure.map((u) => u.fl.sentence).join('" or "'), text: texts[i] } : null)).filter(Boolean);
  const margins = asks.length ? await batched(() => batchJudge(asks), async () => { const m = []; for (const a of asks) m.push(await judge(a.filter, a.text)); return m; }) : [];
  asks.forEach((a, n) => {
    for (const { fl, peak, rule } of rows[a.i].unsure) {
      const ensemble = peak + rule.w * margins[n], blocked = ensemble > rule.t;
      rows[a.i].verdicts[fl.sentence] = { blocked, verdict: blocked ? "judge: blocked" : "judge: cleared", peak, margin: margins[n], ensemble };
    }
  });
  return rows.map((r) => ({ blocked: Object.values(r.verdicts).some((x) => x.blocked), verdicts: r.verdicts, batched: youtubeBatch === true }));
}
const builtFilters = new Map(); // sentence → its probe, built once
async function filtersFor(sentences) {
  const out = [];
  for (const s of sentences) {
    if (!builtFilters.has(s)) builtFilters.set(s, { ...(await makeFilter(s)), gate: yt.filters.find((f) => f.sentence === s)?.gate ?? NEW_GATE });
    out.push(builtFilters.get(s));
  }
  return out;
}
const youtubeFilters = () => filtersFor(yt.filters.map((f) => f.sentence));
setYoutubeJudge(async (videos, sentences) => judgeYoutube(videos, await filtersFor(sentences)), JSON.stringify({ rule: CASCADE_TITLES, v: 2 }));
const ytState = () => ({ type: "filters", enabled: yt.enabled, filters: yt.filters.map((f) => f.sentence), stats: youtubeStats() });
function applyYoutube(reset) {
  setYoutubeFilters(yt.filters.map((f) => f.sentence));
  setYoutubeEnabled(yt.enabled && yt.filters.length > 0);
  if (reset) browser.tabs.query({ url: "https://www.youtube.com/*" }).then((ts) => ts.forEach((t) => browser.tabs.sendMessage(t.id, { type: "yt-reset" }).catch(() => {})));
  send(ytState());
}
// from the popup: the new list of filter sentences (any number), or filtering on/off
function setYoutubeSettings(msg) {
  if (msg.filters) {
    const seen = new Set(), list = [];
    for (const raw of msg.filters) {
      const s = String(raw).replace(/\s+/g, " ").trim().slice(0, 200);
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); list.push({ sentence: s, gate: yt.filters.find((f) => f.sentence === s)?.gate ?? YOUTUBE_FILTERS.find((f) => f.sentence === s)?.gate ?? NEW_GATE }); }
    }
    yt = { ...yt, filters: list };
  }
  if ("enabled" in msg) yt = { ...yt, enabled: !!msg.enabled };
  browser.storage.local.set({ "yt-settings": yt }).catch(() => {});
  applyYoutube(true);
}
applyYoutube(false);
browser.storage.local.get("yt-settings").then((r) => { if (r["yt-settings"]) { yt = r["yt-settings"]; applyYoutube(true); } }).catch(() => {});
// Report only: every video read so far through the given filters, in feed order.
window.filterYoutube = async (filterSentences) => {
  const fls = [];
  for (const s2 of filterSentences) fls.push({ ...(await makeFilter(s2)), gate: CASCADE_TITLES.gate });
  const vids = [...youtubeVideos.values()].filter((x) => x.title).sort((a, b) => a.order - b.order), out = [];
  for (let k = 0; k < vids.length; k += 12) {
    const r = await judgeYoutube(vids.slice(k, k + 12), fls);
    vids.slice(k, k + 12).forEach((v, n) => out.push({ id: v.id, title: v.title, channel: v.channel, short: !!v.short, ...r[n] }));
  }
  return out;
};

// Load at Firefox startup so the popup is ready the moment it opens (only if already installed;
// the 10-minute idle unload still frees the VRAM if it isn't used).
hasModelInCache(MODEL_ID).catch(() => false).then((ok) => {
  installed = ok;
  if (ok) load().catch(() => {});
  else setStatus("Model not installed yet.");
});
touch();
