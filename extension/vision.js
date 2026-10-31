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

// thumbnail bytes (jpeg / webp) → f16 rows [n × 1536] as a Uint16Array (raw half floats), n = 66 for 16:9
export async function encodeThumbnail(bytes) {
  const s = await encoder();
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
  const out = await s.run({ pixel_values: new ort.Tensor("float32", patches, [1, MAXP, DIM]), pixel_position_ids: new ort.Tensor("int64", pos, [1, MAXP, 2]) });
  const n = Math.floor((nh * nw) / 9), feats = out.image_features, data = feats.data;
  // f32 → convert; f16 (Uint16Array or Float16Array) → copy the raw halves
  const rows = data instanceof Float32Array ? new Uint16Array(Float16Array.from(data.subarray(0, n * 1536)).buffer) : new Uint16Array(data.buffer, data.byteOffset, n * 1536).slice();
  for (const t of Object.values(out)) t.dispose?.();
  return { n, rows };
}
