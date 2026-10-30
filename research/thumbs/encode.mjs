// Thumbnail benchmark, step 1 (CPU): render the text-only thumbnails, then run Gemma 4's vision encoder (ONNX q4,
// onnxruntime-node) on every thumbnail with the Gemma4ImageProcessor recipe at a 70-token budget. Writes
// <bench dir>/feat/<key>.bin (f16 [n x 1536]) and all.json. Needs onnxruntime-node 1.30 and sharp.
// Usage: node encode.mjs <bench dir> <vision_encoder_q4.onnx (with its .onnx_data next to it)>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import sharp from "sharp";
import ort from "onnxruntime-node";

const DIR = process.argv[2].replaceAll("\\", "/").replace(/\/?$/, "/"), MODEL = process.argv[3];
mkdirSync(DIR + "feat", { recursive: true });
const items = JSON.parse(readFileSync(DIR + "real.json"));

// text-only thumbnails: the topic only as words on a plain background (and neutral words as negatives)
const SYN = {
  bees: ["BEEKEEPING FOR BEGINNERS", "MY FIRST HONEY HARVEST"], guns: ["BEST HUNTING RIFLE?", "PISTOL RANGE DAY"],
  crypto: ["BITCOIN TO $200K?", "MY CRYPTO PORTFOLIO"], cooking: ["EASY LASAGNA RECIPE", "5 MINUTE PASTA"],
  football: ["PREMIER LEAGUE PREDICTIONS", "TOP 10 GOALS OF THE SEASON"], dogs: ["PUPPY TRAINING TIPS", "MY DOG REACTS"],
  ocean: ["DEEP SEA CREATURES", "OCEAN DOCUMENTARY"], gambling: ["I LOST $10K AT THE CASINO", "POKER STRATEGY"],
  illness: ["FLU SYMPTOMS EXPLAINED", "DOCTOR REACTS TO SURGERY"], space: ["BLACK HOLES EXPLAINED", "MARS MISSION UPDATE"],
};
const NEUTRAL = ["MY MORNING ROUTINE", "EXCEL TIPS", "ROOM MAKEOVER", "STUDY WITH ME", "CAR REVIEW",
  "PIANO LESSON 1", "BUDGET TRAVEL", "LEARN SPANISH", "DESK SETUP", "WEEKLY VLOG"];
const COLOURS = ["#c0392b", "#2c3e50", "#8e44ad", "#16a085", "#d35400", "#27ae60", "#2980b9", "#7f8c8d"];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\$/g, "&#36;");
async function render(key, text, i) {
  const words = text.split(" "), half = Math.ceil(words.length / 2), lines = words.length > 2 ? [words.slice(0, half).join(" "), words.slice(half).join(" ")] : [text];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${COLOURS[i % COLOURS.length]}"/>` +
    lines.map((l, k) => `<text x="160" y="${lines.length === 1 ? 105 : 80 + k * 45}" font-family="Arial Black, Arial" font-weight="900" font-size="${l.length > 14 ? 24 : 32}" fill="white" stroke="black" stroke-width="1.5" text-anchor="middle">${esc(l)}</text>`).join("") + "</svg>";
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(DIR + "img/" + key + ".jpg");
}
let n = 0;
for (const [topic, texts] of Object.entries(SYN)) for (const text of texts) { const key = `syn-${topic}-${n}`; await render(key, text, n++); items.push({ key, kind: "text", topic, title: text }); }
for (const [i, text] of NEUTRAL.entries()) { const key = `syn-neutral-${i}`; await render(key, text, n++); items.push({ key, kind: "text-neutral", topic: null, title: text, split: i < 5 ? "calib" : "test" }); }

// Gemma4ImageProcessor with max_soft_tokens 70: aspect-preserving size (multiple of 48), /255, 16x16 HWC patches, [col,row]
const MAXP = 70 * 9, PS = 16;
const session = await ort.InferenceSession.create(MODEL, { intraOpNumThreads: 32 });
const t0 = performance.now();
for (const it of items) {
  const meta = await sharp(DIR + "img/" + it.key + ".jpg").metadata(), f = Math.sqrt((MAXP * PS * PS) / (meta.height * meta.width));
  const H = Math.floor((f * meta.height) / 48) * 48, W = Math.floor((f * meta.width) / 48) * 48;
  const px = await sharp(DIR + "img/" + it.key + ".jpg").resize(W, H, { kernel: "cubic", fit: "fill" }).removeAlpha().raw().toBuffer();
  const nh = H / PS, nw = W / PS, dim = PS * PS * 3, patches = new Float32Array(MAXP * dim), pos = new BigInt64Array(MAXP * 2).fill(-1n);
  let o = 0, q = 0;
  for (let ph = 0; ph < nh; ph++) for (let pw = 0; pw < nw; pw++) {
    for (let dy = 0; dy < PS; dy++) for (let dx = 0; dx < PS; dx++) for (let c = 0; c < 3; c++) patches[o++] = px[((ph * PS + dy) * W + pw * PS + dx) * 3 + c] / 255;
    pos[q++] = BigInt(pw); pos[q++] = BigInt(ph);
  }
  const out = await session.run({ pixel_values: new ort.Tensor("float32", patches, [1, MAXP, dim]), pixel_position_ids: new ort.Tensor("int64", pos, [1, MAXP, 2]) });
  it.n = Math.floor((nh * nw) / 9);
  writeFileSync(DIR + "feat/" + it.key + ".bin", Buffer.from(Float16Array.from(out.image_features.data.subarray(0, it.n * 1536)).buffer));
}
writeFileSync(DIR + "all.json", JSON.stringify(items, null, 1));
console.log(`${items.length} thumbnails encoded in ${((performance.now() - t0) / 1000).toFixed(1)} s (${((performance.now() - t0) / items.length).toFixed(0)} ms each)`);
