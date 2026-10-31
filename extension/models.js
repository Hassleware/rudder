// Rudder's models (background page), on the GPU through transformers.js (vendored by `npm install`). Chosen on the
// Rudder test set (research/testset, NOTES.md): thumbnail text read by Florence-2 plus a zero-shot text classifier
// (DeBERTa-v3 base, MoritzLaurer zeroshot-v2.0) scoring "title — channel — thumbnail text" against every filter caught
// 90% of what should be hidden for 11% of harmless videos wrongly hidden; image-text matching (SigLIP) added nothing.
// Weights download once from Hugging Face (~1.3 GB) into the browser's cache.
import * as T from "./vendor/transformers.min.js";

T.env.allowLocalModels = false;
T.env.useBrowserCache = true;
T.env.backends.onnx.wasm.wasmPaths = { wasm: browser.runtime.getURL("vendor/ort-tjs.wasm") }; // no CDN in an extension
T.env.backends.onnx.wasm.numThreads = 1;
T.env.backends.onnx.wasm.proxy = false;

const OCR_ID = "onnx-community/Florence-2-base-ft", NLI_ID = "MoritzLaurer/deberta-v3-base-zeroshot-v2.0";
const TASK = "<OCR_WITH_REGION>"; // line by line ("<OCR>" glues lines together without spaces)
let ocr = null, nli = null, loading = null, onProgress = () => {};
export const setProgress = (fn) => { onProgress = fn; };
export const loaded = () => !!(ocr && nli);

export function load() {
  loading ??= (async () => {
    const progress = (what) => (p) => { if (p.status === "progress" && p.total) onProgress(`Downloading ${what}: ${Math.round((100 * p.loaded) / p.total)}% of ${p.file.split("/").pop()}`); };
    const [model, processor, tokenizer] = await Promise.all([
      // decoder in fp32: its fp16 export is rejected by onnxruntime ("subgraph output … outer scope value")
      T.Florence2ForConditionalGeneration.from_pretrained(OCR_ID, { device: "webgpu", dtype: { embed_tokens: "fp16", vision_encoder: "fp16", encoder_model: "fp16", decoder_model_merged: "fp32" }, progress_callback: progress("the thumbnail reader") }),
      T.AutoProcessor.from_pretrained(OCR_ID),
      T.AutoTokenizer.from_pretrained(OCR_ID),
    ]);
    ocr = { model, processor, tokenizer, prompt: processor.construct_prompts(TASK) };
    const [cls, tok] = await Promise.all([
      T.AutoModelForSequenceClassification.from_pretrained(NLI_ID, { device: "webgpu", dtype: "fp32", progress_callback: progress("the filter model") }),
      T.AutoTokenizer.from_pretrained(NLI_ID),
    ]);
    const label2id = Object.fromEntries(Object.entries(cls.config.id2label).map(([i, l]) => [l.toLowerCase(), +i]));
    nli = { model: cls, tokenizer: tok, yes: label2id.entailment ?? 0 };
    onProgress("Ready.");
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

// thumbnails (jpeg/webp bytes) → the text on each, several per call
export async function readThumbnails(list, batch = 8) {
  await load();
  const out = [];
  for (let i = 0; i < list.length; i += batch) {
    const group = list.slice(i, i + batch);
    const images = await Promise.all(group.map(async (bytes) => T.RawImage.fromBlob(new Blob([bytes]))));
    const text = ocr.tokenizer(new Array(group.length).fill(ocr.prompt[0] ?? ocr.prompt), { padding: true });
    const ids = await ocr.model.generate({ ...text, ...(await ocr.processor(images)), max_new_tokens: 96 });
    const raw = ocr.tokenizer.batch_decode(ids, { skip_special_tokens: false });
    raw.forEach((r, k) => {
      const res = ocr.processor.post_process_generation(r, TASK, images[k].size)[TASK];
      out.push((res?.labels ?? []).map((l) => l.replace(/<\/?s>|<pad>/g, "")).join(" ").replace(/\s+/g, " ").trim());
    });
  }
  return out;
}

// how strongly each text matches each filter: probability that "This video is <filter>" follows from the text
export const hypothesis = (filter) => `This video is ${filter.replace(/^anything /i, "")}.`;
export async function scoreTexts(texts, filters, batch = 128) {
  await load();
  const pairs = texts.flatMap((t) => filters.map((f) => [t, hypothesis(f)])), probs = [];
  for (let i = 0; i < pairs.length; i += batch) {
    const g = pairs.slice(i, i + batch);
    const inputs = nli.tokenizer(g.map((x) => x[0]), { text_pair: g.map((x) => x[1]), padding: true, truncation: true, max_length: 256 });
    const { logits } = await nli.model(inputs);
    const L = logits.tolist();
    for (const row of L) { const m = Math.max(...row), e = row.map((v) => Math.exp(v - m)); probs.push(e[nli.yes] / e.reduce((a, b) => a + b, 0)); }
  }
  return texts.map((_, k) => Object.fromEntries(filters.map((f, j) => [f, probs[k * filters.length + j]])));
}
