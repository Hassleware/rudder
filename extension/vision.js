// Gemma 4's eyes for Rudder: its own vision encoder (the ONNX build's vision_encoder_q4, 112 MB, downloaded once from
// Hugging Face and kept in the extension's cache) turns a thumbnail into 66 "image tokens" (rows of 1536 numbers) that
// go into our WebLLM Gemma next to the title, so the probe and the judge read thumbnail and title together. It runs
// on the GPU (onnxruntime-web's WebGPU backend), on its own GPU device. gpu-fixes.js must not mistake that device for
// WebLLM's (rudderVisionStarting): when it did, the layer readings after an encode all came back as zeros.
// Recipe = transformers.js Gemma4ImageProcessor at a 70-token budget (as in research/thumbs/encode.mjs):
// aspect-preserving resize to multiples of 48 px, /255, 16×16 patches in HWC order with [col, row] positions; the
// encoder pools 3×3 patches into one token.
import * as ort from "./vendor/ort.webgpu.bundle.min.mjs";

const BASE = "https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/";
const FILES = ["vision_encoder_q4.onnx", "vision_encoder_q4.onnx_data"];
const MAXP = 70 * 9, PS = 16, DIM = PS * PS * 3;
export const IMAGE_TOKENS = { BOI: 255999, IMG: 258880, EOI: 258882 };

ort.env.wasm.wasmPaths = { wasm: browser.runtime.getURL("vendor/ort-wasm-simd-threaded.asyncify.wasm") }; // the bundle has its own JS glue
ort.env.wasm.numThreads = 1; // no SharedArrayBuffer in an extension page; the work is on the GPU anyway
ort.env.wasm.proxy = false;

let session = null;
async function ownDevice() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }), L = adapter.limits;
  const limits = ["maxBufferSize", "maxStorageBufferBindingSize", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage"];
  return adapter.requestDevice({ label: "rudder-vision", requiredFeatures: ["shader-f16", "subgroups"].filter((f) => adapter.features.has(f)), requiredLimits: Object.fromEntries(limits.map((k) => [k, L[k]])) });
}
async function file(name) {
  const cache = await caches.open("rudder-vision"), url = BASE + name;
  let r = await cache.match(url);
  if (!r) { // first use only
    const got = await fetch(url);
    if (!got.ok) throw new Error(`vision encoder download failed (${got.status})`);
    await cache.put(url, got);
    r = await cache.match(url);
  }
  return new Uint8Array(await r.arrayBuffer());
}
async function encoder() {
  if (!session) {
    const [graph, data] = await Promise.all(FILES.map(file));
    globalThis.rudderVisionStarting = true;
    try {
      ort.env.webgpu.device = await ownDevice();
      session = await ort.InferenceSession.create(graph, { executionProviders: ["webgpu"], externalData: [{ path: FILES[1], data }], graphOptimizationLevel: "all" });
    } finally {
      globalThis.rudderVisionStarting = false;
    }
  }
  return session;
}

// thumbnail bytes → the encoder's input: 16×16 patches (HWC, /255) and their [col, row] positions, padded to 630
async function patchesOf(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const f = Math.sqrt((MAXP * PS * PS) / (bmp.height * bmp.width));
  const H = Math.floor((f * bmp.height) / 48) * 48, W = Math.floor((f * bmp.width) / 48) * 48;
  const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const px = ctx.getImageData(0, 0, W, H).data; // RGBA
  const nh = H / PS, nw = W / PS, patches = new Float32Array(MAXP * DIM), pos = new BigInt64Array(MAXP * 2).fill(-1n);
  let o = 0, q = 0;
  for (let ph = 0; ph < nh; ph++) for (let pw = 0; pw < nw; pw++) {
    for (let dy = 0; dy < PS; dy++) for (let dx = 0; dx < PS; dx++) {
      const i = ((ph * PS + dy) * W + pw * PS + dx) * 4;
      patches[o++] = px[i] / 255; patches[o++] = px[i + 1] / 255; patches[o++] = px[i + 2] / 255;
    }
    pos[q++] = BigInt(pw); pos[q++] = BigInt(ph);
  }
  return { patches, pos, n: Math.floor((nh * nw) / 9) };
}
const halves = (data, from, count) => (data instanceof Float32Array
  ? new Uint16Array(Float16Array.from(data.subarray(from, from + count)).buffer)
  : new Uint16Array(data.buffer, data.byteOffset + from * 2, count).slice());
// Several thumbnails → each one's f16 rows [n × 1536] (Uint16Array of raw halves), n = 66 for 16:9. One encoder call
// for the whole batch when the encoder takes a batch, else one call each.
let batches = null; // does the encoder take more than one image per call?
const BATCH = 8;
export const encoderBatches = () => batches;
export async function encodeThumbnails(list) {
  const s = await encoder(), inputs = await Promise.all(list.map(patchesOf));
  const run = async (group) => {
    const B = group.length, pv = new Float32Array(B * MAXP * DIM), pp = new BigInt64Array(B * MAXP * 2);
    group.forEach((x, b) => { pv.set(x.patches, b * MAXP * DIM); pp.set(x.pos, b * MAXP * 2); });
    const out = await s.run({ pixel_values: new ort.Tensor("float32", pv, [B, MAXP, DIM]), pixel_position_ids: new ort.Tensor("int64", pp, [B, MAXP, 2]) });
    const data = out.image_features.data, rows = data.length / 1536, T = rows / B, total = group.reduce((a, x) => a + x.n, 0);
    for (const t of Object.values(out)) t.dispose?.();
    if (Number.isInteger(T) && group.every((x) => x.n <= T)) return group.map((x, b) => ({ n: x.n, rows: halves(data, b * T * 1536, x.n * 1536) })); // [B × T] with padding
    if (rows === total) { let at = 0; return group.map((x) => { const r = { n: x.n, rows: halves(data, at * 1536, x.n * 1536) }; at += x.n; return r; }); } // padding dropped
    throw new Error(`unexpected encoder output: ${rows} rows for ${B} images`);
  };
  const out = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const group = inputs.slice(i, i + BATCH);
    if (batches !== false && group.length > 1) {
      try { out.push(...(await run(group))); batches = true; continue; } catch (err) { if (batches === null) batches = false; console.warn("rudder: encoder batch failed, one at a time:", err.message); }
    }
    for (const x of group) out.push((await run([x]))[0]);
  }
  return out;
}
