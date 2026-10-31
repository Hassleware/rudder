// Each video's fingerprint for your own algorithm (youtube/personal.js): MiniLM (all-MiniLM-L6-v2, 23 MB, quantised)
// reads "title — channel" into 384 numbers, on the processor through transformers.js (vendored by `npm install`), a
// few milliseconds a title. Downloaded once from Hugging Face into the browser's cache.
import * as T from "./vendor/transformers.min.js";

T.env.allowLocalModels = false;
T.env.useBrowserCache = true;
T.env.backends.onnx.wasm.wasmPaths = { wasm: browser.runtime.getURL("vendor/ort-tjs.wasm") }; // no CDN in an extension
T.env.backends.onnx.wasm.numThreads = 1;
T.env.backends.onnx.wasm.proxy = false;

let extractor = null;
export async function embed(texts) {
  extractor ??= T.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { device: "wasm", dtype: "q8" }).catch((err) => { extractor = null; throw err; });
  const out = await (await extractor)(texts, { pooling: "mean", normalize: true });
  return out.tolist().map((a) => Float32Array.from(a));
}
