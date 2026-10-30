// Runs the model. The background page lives as long as Firefox, so the popup can close and reopen instantly.
// The model downloads once (~2.9 GB) into the extension's own storage; after that it loads from disk.
import "./gpu-fixes.js";
import { CreateMLCEngine, hasModelInCache } from "./vendor/web-llm.js";
import { TAP, PROBE, mean, makeProbe, score, smooth, top3, sentences, cascade, CASCADE } from "./probe.js";

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
// each call reads only the text and the question, then rolls the memory back (TVM's kv_state_popn). Reads one token at a
// time like the rest of the Firefox build (no slow prompt-kernel build). Clears the chat's memory like layerStates.
let judgeKept = null; // { sentence, n }: the prompt start currently in memory
async function judge(filterSentence, text) {
  if (partial !== null || probing) throw new Error("The model is busy.");
  probing = true;
  try {
    const e = await load(), p = e.loadedModelIdToPipeline.get(MODEL_ID), tok = p.tokenizer;
    const feed = (ids) => { for (const id of ids) { p.tvm.beginScope(); p.artifactPrefillAndForward(p.getArtifactTextEmbeddings([id]), [id], [0]); p.tvm.endScope(); } };
    if (judgeKept?.sentence !== filterSentence || p.filledKVCacheLength !== judgeKept.n) {
      await e.resetChat();
      feed([p.bosTokenId, ...tok.encode(`<|turn>user\nYou are a content filter. Filter: "${filterSentence}"\nText: "`)]);
      judgeKept = { sentence: filterSentence, n: p.filledKVCacheLength };
    }
    const ids = Array.from(tok.encode(`${text}"\nDoes the text contain anything the filter describes? Answer only Yes or No.<turn|>\n<|turn>model\n`));
    feed(ids.slice(0, -1));
    p.tvm.beginScope();
    p.updateLogitsOnCPU(p.artifactPrefillAndForward(p.getArtifactTextEmbeddings(ids.slice(-1)), ids.slice(-1), [0]));
    p.tvm.endScope();
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
async function cascadeRun(fl, sents, states) {
  const z = smooth(states.flat().map((x) => score(fl.probe, x))), best3 = top3(z), out = [];
  let i = 0;
  for (const [k, ss] of states.entries()) {
    const a = i, b = (i += ss.length);
    if (a === b) { out.push({ a, b, verdict: "clear", score: -99 }); continue; }
    const peak = Math.max(...z.slice(a, b)), b3 = Math.max(...best3.slice(a, b));
    out.push({ a, b, peak, top3: b3, ...(await cascade(peak, b3, () => judge(fl.sentence, sents[k].trim()))) });
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
});
// Load at Firefox startup so the popup is ready the moment it opens (only if already installed;
// the 10-minute idle unload still frees the VRAM if it isn't used).
hasModelInCache(MODEL_ID).catch(() => false).then((ok) => {
  installed = ok;
  if (ok) load().catch(() => {});
  else setStatus("Model not installed yet.");
});
touch();
