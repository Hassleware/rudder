// Runs the model. The background page lives as long as Firefox, so the popup can close and reopen instantly.
// The model downloads once (~2.9 GB) into the extension's own storage; after that it loads from disk.
import "./gpu-fixes.js";
import { CreateMLCEngine, hasModelInCache } from "./vendor/web-llm.js";

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
const snapshot = () => ({ type: "init", history, partial, status, setup: installed === false && !engine && !loading });

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

async function chat(text) {
  if (partial !== null || !text) return;
  touch();
  history.push({ role: "user", content: text });
  partial = "";
  send({ type: "user", text });
  const start = performance.now();
  let t0 = 0, n = 0;
  try {
    const e = await load();
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
  send({ type: "done" });
  touch();
}

browser.runtime.onConnect.addListener(async (port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => { ports.delete(port); touch(); });
  port.onMessage.addListener((msg) => {
    if (msg.type === "load") { load().catch(() => {}); send(snapshot()); } // the popup's Download button
    if (msg.type === "send") chat(msg.text.trim());
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
