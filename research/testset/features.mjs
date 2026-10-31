// Rudder test set, step 3 (CPU): every candidate model's raw output on all items, cached per stage in <dir>/feat-*.json
// so scoring and threshold tuning (score.mjs) don't need the models again.
//   ocr-tesseract   thumbnail text, Tesseract (tesseract.js)
//   ocr-florence    thumbnail text, Florence-2 base "<OCR>"
//   siglip, siglip2 image-text match logits: each thumbnail vs a prompt per filter alternative
//   nli-<model>-<text>   zero-shot "This video is about …" entailment per filter, for title only / title + OCR text
// Usage: node features.mjs <testset dir> [stage …]   (run from a folder with @huggingface/transformers and tesseract.js)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(path.join(process.cwd(), "x.js"));
const T = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
const DIR = process.argv[2], ONLY = process.argv.slice(3);
const items = JSON.parse(fs.readFileSync(path.join(DIR, "items.json"), "utf8"));
const FILTERS = JSON.parse(fs.readFileSync(path.join(DIR, "filters.json"), "utf8")).filter((f) => /\s/.test(f)); // name filters are keyword-only
const save = (name, data) => fs.writeFileSync(path.join(DIR, `feat-${name}.json`), JSON.stringify(data));
const have = (name) => fs.existsSync(path.join(DIR, `feat-${name}.json`));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `feat-${name}.json`), "utf8"));
const want = (name) => (!ONLY.length || ONLY.some((o) => name.startsWith(o))) && !have(name);
const timeit = async (label, fn) => { const t0 = performance.now(); const r = await fn(); console.log(`${label}: ${((performance.now() - t0) / items.length).toFixed(0)} ms per item`); return r; };

// a filter's alternatives ("anything about news, war or death" → news | war | death) and its prompts
const about = (f) => /^anything about /i.test(f);
const alts = (f) => f.replace(/^anything (about )?/i, "").split(/\s*(?:,|\bor\b)\s*/).map((s) => s.trim()).filter(Boolean);
const imagePrompt = (f, a) => (about(f) ? `a YouTube video thumbnail about ${a}` : `a ${a} YouTube video thumbnail`);
const hypothesis = (f) => `This video is ${f.replace(/^anything /i, "")}.`;

// ---- OCR: Tesseract ----
if (want("ocr-tesseract")) {
  const { createWorker } = require("tesseract.js");
  const worker = await createWorker("eng");
  const out = await timeit("tesseract", async () => { const o = {}; for (const it of items) o[it.id] = (await worker.recognize(path.join(DIR, it.image))).data.text.replace(/\s+/g, " ").trim(); return o; });
  await worker.terminate();
  save("ocr-tesseract", out);
}

// ---- OCR: Florence-2 ----
if (want("ocr-florence")) {
  const id = "onnx-community/Florence-2-base-ft";
  const model = await T.Florence2ForConditionalGeneration.from_pretrained(id, { dtype: "fp32" });
  const processor = await T.AutoProcessor.from_pretrained(id), tokenizer = await T.AutoTokenizer.from_pretrained(id);
  const TASK = "<OCR_WITH_REGION>"; // line by line: plain "<OCR>" glues lines together without spaces
  const text = tokenizer(processor.construct_prompts(TASK));
  const out = await timeit("florence ocr", async () => {
    const o = {};
    for (const it of items) {
      const image = await T.RawImage.read(path.join(DIR, it.image)), vision = await processor(image);
      const ids = await model.generate({ ...text, ...vision, max_new_tokens: 120 });
      const raw = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
      const r = processor.post_process_generation(raw, TASK, image.size)[TASK];
      o[it.id] = (r?.labels ?? []).map((l) => l.replace(/<\/?s>/g, "")).join(" ").replace(/\s+/g, " ").trim();
    }
    return o;
  });
  save("ocr-florence", out);
}

// ---- SigLIP: image-text logits per (item, prompt) ----
for (const [name, id] of [["siglip", "Xenova/siglip-base-patch16-224"], ["siglip2", "onnx-community/siglip2-base-patch16-224-ONNX"]]) {
  if (!want(name)) continue;
  const prompts = FILTERS.flatMap((f) => alts(f).map((a) => ({ f, a, text: imagePrompt(f, a) })));
  const processor = await T.AutoProcessor.from_pretrained(id), tokenizer = await T.AutoTokenizer.from_pretrained(id);
  const model = await T.AutoModel.from_pretrained(id, { dtype: name === "siglip2" ? "int8" : "q8" });
  const textIn = tokenizer(prompts.map((p) => p.text), { padding: "max_length", max_length: 64, truncation: true });
  const out = await timeit(name, async () => {
    const o = {};
    for (let i = 0; i < items.length; i += 8) {
      const group = items.slice(i, i + 8), images = await Promise.all(group.map((it) => T.RawImage.read(path.join(DIR, it.image))));
      const { logits_per_image } = await model({ ...textIn, ...(await processor(images)) });
      const L = logits_per_image.tolist();
      group.forEach((it, k) => { o[it.id] = L[k]; });
    }
    return o;
  });
  save(name, { prompts, logits: out });
}

// ---- zero-shot text classifier (NLI) ----
const texts = {
  title: (it) => (it.channel ? `${it.title} — ${it.channel}` : it.title),
  "title+tesseract": (it, o) => `${texts.title(it)} — thumbnail text: ${o["ocr-tesseract"]?.[it.id] ?? ""}`,
  "title+florence": (it, o) => `${texts.title(it)} — thumbnail text: ${o["ocr-florence"]?.[it.id] ?? ""}`,
};
for (const [mname, id] of [["xsmall", "Xenova/nli-deberta-v3-xsmall"], ["base", "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"]]) {
  for (const tname of Object.keys(texts)) {
    const name = `nli-${mname}-${tname}`;
    if (!want(name)) continue;
    const ocr = { "ocr-tesseract": have("ocr-tesseract") ? load("ocr-tesseract") : null, "ocr-florence": have("ocr-florence") ? load("ocr-florence") : null };
    if (tname !== "title" && !ocr["ocr-" + tname.split("+")[1]]) { console.log(`skip ${name}: no OCR yet`); continue; }
    const clf = await T.pipeline("zero-shot-classification", id, { dtype: mname === "base" ? "fp32" : "q8" });
    const out = await timeit(name, async () => {
      const o = {};
      for (const it of items) {
        const r = await clf(texts[tname](it, ocr), FILTERS.map(hypothesis), { multi_label: true, hypothesis_template: "{}" });
        const by = Object.fromEntries(r.labels.map((l, k) => [l, r.scores[k]]));
        o[it.id] = FILTERS.map((f) => by[hypothesis(f)]);
      }
      return o;
    });
    save(name, { filters: FILTERS, scores: out });
  }
}
console.log("done");
