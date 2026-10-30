// Copies the one-file model bundle from index.html into the storage WebLLM reads from, so nothing downloads.
// Bundle format: 12-char header length, JSON index {key: [offset, size]}, then the files back to back.
// Keys are paths in the Hugging Face repo, or a full URL for the compiled model library (.wasm).
const BASE = "https://huggingface.co/mlc-ai/gemma-4-E2B-it-q4f16_1-MLC/resolve/main/";
const status = (t) => (document.getElementById("status").textContent = t);

// WebLLM keeps each kind of file in its own cache, keyed by the file's full URL.
const scopeOf = (key) =>
  key.endsWith(".wasm") ? "webllm/wasm"
  : key === "mlc-chat-config.json" || key === "mlc-model-manifest.json" ? "webllm/config"
  : "webllm/model";

async function importBundle(file) {
  const len = +(await file.slice(0, 12).text());
  const index = JSON.parse(await file.slice(12, 12 + len).text());
  if (!index["mlc-chat-config.json"]) throw new Error("That isn't the gemma-4-e2b-webllm.bin file.");
  const body = file.slice(12 + len);
  const keys = Object.keys(index);
  const caches_ = {};
  for (const [i, key] of keys.entries()) {
    const [off, size] = index[key];
    const url = key.startsWith("http") ? key : BASE + key;
    const scope = scopeOf(key);
    const cache = (caches_[scope] ??= await caches.open(scope));
    await cache.put(url, new Response(body.slice(off, off + size), { headers: { "content-length": String(size) } }));
    status(`Importing ${i + 1}/${keys.length}…`);
  }
  status("Done. Open the Gemma popup to chat.");
}

document.getElementById("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importBundle(file).catch((err) => status("Import failed: " + err.message));
});
