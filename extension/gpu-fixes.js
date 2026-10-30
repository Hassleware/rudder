// WebGPU fixes for WebLLM (see NOTES.md). Import this BEFORE WebLLM creates its engine.
// Mostly Firefox-only; the bind group / write / compute pass reuse also speeds up Chrome.

// Firefox build-time fix: WebLLM's chunk_lse_kernel (sampling) is 413 KB of unrolled code that Firefox takes
// ~6 s to compile. This loop version does the same math in the same order (verified bit-for-bit identical in
// Firefox) and compiles in ~40 ms.
// Firefox zero-fills shared GPU memory value by value and its compiler slows down roughly with the square of
// that count. Big vec4<f16> shared arrays are stored packed two-f16-per-u32 instead (exact: f16 -> f32 -> f16
// round-trips), halving the count. Only arrays read/written as whole elements are touched.
function packWorkgroupF16(code) {
  let packed = false;
  for (const [decl, name, n] of [...code.matchAll(/var<workgroup> (\w+) : array<vec4<f16>, (\d+)>;/g)]) {
    if (+n < 128) continue;
    const re = new RegExp(String.raw`\b${name}\[`, "g");
    const hits = [];
    let m;
    while ((m = re.exec(code))) {
      let depth = 1, j = re.lastIndex;
      for (; depth; j++) { if (code[j] === "[") depth++; else if (code[j] === "]") depth--; }
      hits.push([m.index, j]);
      re.lastIndex = j;
    }
    // whole-element access only: next char after X[...] must not be "[" or "."
    if (!hits.length || hits.some(([, end]) => code[end] === "[" || code[end] === ".")) continue;
    let out = "", last = 0;
    for (const [start, end] of hits) {
      const access = code.slice(start, end);
      const lineStart = code.lastIndexOf("\n", start) + 1;
      const isWrite = /^\s*$/.test(code.slice(lineStart, start)) && code.startsWith(" = ", end);
      if (isWrite) {
        const semi = code.indexOf(";\n", end);
        out += code.slice(last, start) + `${access} = _pk4h(${code.slice(end + 3, semi)})`;
        last = semi;
      } else {
        out += code.slice(last, start) + `_uk4h(${access})`;
        last = end;
      }
    }
    code = (out + code.slice(last)).replace(decl, `var<workgroup> ${name} : array<vec2<u32>, ${n}>;`);
    packed = true;
  }
  // f16 -> f32 -> f16 is exact, so packing through f32 keeps every value
  if (packed) code += `
fn _pk4h(v : vec4<f16>) -> vec2<u32> { return vec2<u32>(pack2x16float(vec2<f32>(v.xy)), pack2x16float(vec2<f32>(v.zw))); }
fn _uk4h(p : vec2<u32>) -> vec4<f16> { return vec4<f16>(vec4<f32>(unpack2x16float(p.x), unpack2x16float(p.y))); }
`;
  return code;
}

const CHUNK_LSE_SMALL = `@group(0) @binding(0) var<storage, read> A_ptr : array<f32>;
@group(0) @binding(1) var<storage, read_write> chunked_max_ptr : array<f32>;
@group(0) @binding(2) var<storage, read_write> chunked_sum_ptr : array<f32>;
@group(0) @binding(3) var<storage, read> temperature_ptr : array<f32>;

struct PODArgs {
  batch_size: i32,
  num_chunks: i32,
  vocab_size: i32,
  packGridDimX: u32
}
@group(0) @binding(4) var<uniform> podArgs : PODArgs;

var<workgroup> red_buf0 : array<f32, 64>;
var<workgroup> _shared : array<f32, 1>;
var<workgroup> red_buf0_1 : array<f32, 64>;
var<workgroup> _shared_1 : array<f32, 1>;

// Same as WebLLM's chunk_lse_kernel, with its 64 unrolled copies folded back into loops.
@compute @workgroup_size(64, 1, 1)
fn chunk_lse_kernel(
  @builtin(workgroup_id) blockIdx : vec3<u32>,
  @builtin(num_workgroups) gridDim : vec3<u32>,
  @builtin(local_invocation_id) threadIdx : vec3<u32>
) {
  if (blockIdx.z * gridDim.x + blockIdx.x >= podArgs.packGridDimX) { return; }
  let v__1 : i32 = i32(blockIdx.z * gridDim.x + blockIdx.x);
  let nc : i32 = podArgs.num_chunks;
  let rmod : i32 = (v__1 % nc);
  let rdiv : i32 = (v__1 / nc);
  let floor_ok : bool = (((nc >= 0i) && (rmod >= 0i)) || ((nc < 0i) && (rmod <= 0i)));
  let chunk : i32 = select((rmod + nc), rmod, floor_ok);   // floormod(v__1, num_chunks)
  let batch : i32 = select((rdiv - 1i), rdiv, floor_ok);   // floordiv(v__1, num_chunks)
  let valid : bool = (chunk < 64i);
  let temp : f32 = temperature_ptr[batch];
  let base : i32 = (((chunk * 4096i) + (batch * podArgs.vocab_size)) + i32(threadIdx.x));
  let tx : i32 = i32(threadIdx.x);

  var m : f32 = -3.402823e+38f;
  for (var k : i32 = 0i; k < 64i; k++) {
    var x : f32 = -3.402823e+38f;
    if (valid) {
      if ((1.000000e-05f < temp)) { x = (A_ptr[(base + (k * 64i))] / temp); } else { x = A_ptr[(base + (k * 64i))]; }
    }
    m = max(m, x);
  }
  workgroupBarrier();
  red_buf0[tx] = m;
  workgroupBarrier();
  for (var s : i32 = 32i; s >= 1i; s = (s >> 1u)) {
    if (tx < s) { red_buf0[tx] = max(red_buf0[tx], red_buf0[(tx + s)]); }
    workgroupBarrier();
  }
  if (tx == 0i) { _shared[0i] = red_buf0[0i]; }
  var acc : f32 = 0.000000e+00f;
  workgroupBarrier();
  let mx : f32 = _shared[0i];
  for (var k : i32 = 0i; k < 64i; k++) {
    var y : f32 = 0.000000e+00f;
    if (valid) {
      if ((1.000000e-05f < temp)) {
        y = exp(((A_ptr[(base + (k * 64i))] / temp) - mx));
      } else {
        y = f32((A_ptr[(base + (k * 64i))] == mx));
      }
    }
    acc = (acc + y);
  }
  workgroupBarrier();
  red_buf0_1[tx] = acc;
  workgroupBarrier();
  for (var s : i32 = 32i; s >= 1i; s = (s >> 1u)) {
    if (tx < s) { red_buf0_1[tx] = (red_buf0_1[tx] + red_buf0_1[(tx + s)]); }
    workgroupBarrier();
  }
  if (tx == 0i) { _shared_1[0i] = red_buf0_1[0i]; }
  workgroupBarrier();
  if (tx < 1i) {
    if ((1.000000e-05f < temp)) { chunked_sum_ptr[v__1] = log(_shared_1[0i]); } else { chunked_sum_ptr[v__1] = _shared_1[0i]; }
    chunked_max_ptr[v__1] = _shared[0i];
  }
}
`;
if (navigator.gpu && /firefox/i.test(navigator.userAgent)) {
  const realModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (d) {
    if (d.code.length > 100000 && d.code.includes("fn chunk_lse_kernel(")) d = { ...d, code: CHUNK_LSE_SMALL };
    else if (d.code.includes("var<workgroup>") && d.code.includes("vec4<f16>")) d = { ...d, code: packWorkgroupF16(d.code) };
    return realModule.call(this, d);
  };
}

// Firefox speed-up: Firefox only checks for finished GPU work on a 100 ms timer (POLL_TIME_MS in
// WebGPUParent.cpp), and the model waits on the GPU at least once per token. But every queue.submit(),
// even an empty one, also makes Firefox check right away (wgpu-core Queue::submit -> device.maintain(Poll)).
// So while the model waits, keep sending empty submits until its result arrives. Allocates nothing.
if (navigator.gpu) {
  const firefox = /firefox/i.test(navigator.userAgent);
  let queue = null; // the model's GPU queue, captured when WebLLM creates its device
  const realRequestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await realRequestDevice.apply(this, a);
    queue = d.queue;
    return d;
  };
  // yield to the event loop without setTimeout's 4 ms minimum (one shared channel)
  const chan = new MessageChannel(), wakers = [];
  chan.port1.onmessage = () => wakers.shift()?.();
  const nextTask = () => new Promise((r) => { wakers.push(r); chan.port2.postMessage(0); });
  const poke = (q, p) => {
    if (!firefox || !q) return p;
    let done = false;
    p.then(() => (done = true), () => (done = true));
    const until = performance.now() + 2000; // the 100 ms timer still runs, this is only a safety stop
    (async () => {
      let last = -1;
      while (!done && performance.now() < until) {
        const t = performance.now();
        if (t - last >= 0.5) { // at most one poke per 0.5 ms so Firefox's GPU process isn't flooded
          try { q.submit([]); } catch { return; }
          last = t;
        }
        await nextTask();
      }
    })();
    return p;
  };
  const m = GPUBuffer.prototype.mapAsync, s = GPUQueue.prototype.onSubmittedWorkDone;
  GPUBuffer.prototype.mapAsync = function (...a) { return poke(queue, m.apply(this, a)); };
  GPUQueue.prototype.onSubmittedWorkDone = function (...a) { return poke(this, s.apply(this, a)); };

  // One compute pass per command encoder instead of one per kernel launch. WebLLM begins and ends a pass around
  // every dispatch (hundreds per token), and each pass costs extra work in the GPU process. WebGPU makes every
  // dispatch see the results of earlier dispatches in the same pass, so sharing one pass is exact. The shared
  // pass is ended before any other encoder command (copies etc.) and before finish().
  {
    const open = new WeakMap(); // encoder -> real pass still open
    const realBegin = GPUCommandEncoder.prototype.beginComputePass;
    const closePass = (enc) => { const p = open.get(enc); if (p) { open.delete(enc); p.end(); } };
    for (const name of Object.getOwnPropertyNames(GPUCommandEncoder.prototype)) {
      const f = Object.getOwnPropertyDescriptor(GPUCommandEncoder.prototype, name).value;
      if (typeof f !== "function" || name === "constructor" || name === "beginComputePass") continue;
      GPUCommandEncoder.prototype[name] = function (...a) { closePass(this); return f.apply(this, a); };
    }
    GPUCommandEncoder.prototype.beginComputePass = function (desc) {
      if (desc?.timestampWrites) { closePass(this); return realBegin.call(this, desc); } // keep timed passes separate
      let p = open.get(this);
      if (!p) { p = realBegin.call(this, desc); open.set(this, p); }
      return {
        setPipeline: (x) => p.setPipeline(x),
        setBindGroup: (...x) => p.setBindGroup(...x),
        dispatchWorkgroups: (...x) => p.dispatchWorkgroups(...x),
        dispatchWorkgroupsIndirect: (...x) => p.dispatchWorkgroupsIndirect(...x),
        pushDebugGroup: (x) => p.pushDebugGroup(x), popDebugGroup: () => p.popDebugGroup(), insertDebugMarker: (x) => p.insertDebugMarker(x),
        end: () => {}, // the real pass ends with the encoder's next non-pass command or finish()
      };
    };
  }

  // Per-token overhead: every createBindGroup and queue.writeBuffer is a round trip to the browser's GPU process
  // (very costly in Firefox), and WebLLM does one of each per kernel launch (hundreds per token). Its buffers are
  // pooled by launch order, so each token repeats the same bind groups and mostly the same parameter bytes. Reuse
  // identical bind groups and skip writes of bytes the buffer already holds. Exact: the GPU sees the same data.
  // Measured in Chrome too: 55 -> 72 tok/s, identical replies.
  {
    const ids = new WeakMap(); let nextId = 1;
    const id = (o) => ids.get(o) ?? (ids.set(o, nextId), nextId++);
    const groups = new Map(), keysByBuffer = new Map(); // key -> bind group; buffer id -> keys using it
    const realBindGroup = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (d) {
      let key = id(this) + ":" + id(d.layout);
      for (const e of d.entries) {
        const r = e.resource;
        if (!(r?.buffer instanceof GPUBuffer)) return realBindGroup.call(this, d); // only cache plain buffer groups
        key += `|${e.binding}:${id(r.buffer)}:${r.offset ?? 0}:${r.size ?? -1}`;
      }
      let g = groups.get(key);
      if (!g) {
        if (groups.size > 20000) { groups.clear(); keysByBuffer.clear(); } // ponytail: crude cap, never hit in chat
        g = realBindGroup.call(this, d);
        groups.set(key, g);
        for (const e of d.entries) {
          const b = id(e.resource.buffer);
          (keysByBuffer.get(b) ?? keysByBuffer.set(b, []).get(b)).push(key);
        }
      }
      return g;
    };
    const lastWrite = new WeakMap(); // buffer -> bytes we last wrote at offset 0
    const realDestroy = GPUBuffer.prototype.destroy;
    GPUBuffer.prototype.destroy = function () {
      for (const k of keysByBuffer.get(id(this)) ?? []) groups.delete(k); // never hand out groups using a dead buffer
      keysByBuffer.delete(id(this));
      lastWrite.delete(this);
      return realDestroy.call(this);
    };
    const realWrite = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buf, off, data, dataOff, size) {
      // only small whole writes at offset 0 (WebLLM's per-launch parameters); big weight uploads go straight through
      if (off === 0 && dataOff === undefined && size === undefined && data.byteLength <= 256 && (buf.usage & GPUBufferUsage.UNIFORM)) {
        const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength);
        const prev = lastWrite.get(buf);
        if (prev && prev.length === bytes.length && prev.every((v, i) => v === bytes[i])) return;
        lastWrite.set(buf, bytes.slice());
      }
      return realWrite.call(this, buf, off, data, dataOff, size);
    };
  }
}
