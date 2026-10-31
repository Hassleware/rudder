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

// Firefox build-time fix for the prompt reader (batch_prefill_*_kernel, ~18 s to build): its two big f16 shared arrays
// (q and k tiles, 4096 values each) are also stored packed, two f16 per u32. Each thread writes four values at once:
// q's four sit together (at a multiple of 4); k's are 8 apart, so k's slots are reordered (a fixed permutation of where
// values live) to put them together. Only storage changes; every value read is the one written.
function packPrefillF16(code) {
  // [array, slot of value i, its place in the slot]
  const plans = [["v_8", (i) => `((${i}) >> 2u)`, (i) => `((${i}) & 3i)`], ["v_9", (i) => `((((${i}) >> 5u) << 3u) + ((${i}) & 7i))`, (i) => `(((${i}) >> 3u) & 3i)`]];
  for (const [name, slot, comp] of plans) {
    const decl = `var<workgroup> ${name} : array<f16, 4096>;`;
    if (!code.includes(decl)) return null;
    // the writes: four lines "X[i0] = E[0]; … X[i3] = E[3];" become one packed store at i0's slot
    let writes = 0;
    code = code.replace(new RegExp(String.raw`${name}\[([^\n]+?)(?: \+ 0|\[0\])\] = ([^\n]+?)\[0\];\n\s*${name}\[[^\n]+\] = \2\[1\];\n\s*${name}\[[^\n]+\] = \2\[2\];\n\s*${name}\[[^\n]+\] = \2\[3\];`, "g"), (_, i, e) => {
      writes++;
      const at = /^v__\d+$/.test(i) && code.includes(`let ${i} : vec4<i32>`) ? `${i}[0]` : i;
      return `${name}@W[${slot(at)}] = _pq4h(${e});`; // marked so the reads below skip it
    });
    if (writes !== 2) return null; // not the shape this was written for
    // the reads: X[i] -> the value's place in its unpacked slot
    const re = new RegExp(String.raw`\b${name}\[`, "g");
    let out = "", last = 0, m;
    while ((m = re.exec(code))) {
      let depth = 1, j = re.lastIndex;
      for (; depth; j++) { if (code[j] === "[") depth++; else if (code[j] === "]") depth--; }
      const i = code.slice(re.lastIndex, j - 1);
      out += code.slice(last, m.index) + `_uq4h(${name}[${slot(i)}])[${comp(i)}]`;
      last = re.lastIndex = j;
    }
    code = (out + code.slice(last)).replace(decl, `var<workgroup> ${name} : array<vec2<u32>, 1024>;`).replaceAll(`${name}@W[`, `${name}[`);
  }
  return code + `
fn _pq4h(v : vec4<f16>) -> vec2<u32> { return vec2<u32>(pack2x16float(vec2<f32>(v.xy)), pack2x16float(vec2<f32>(v.zw))); }
fn _uq4h(p : vec2<u32>) -> vec4<f16> { return vec4<f16>(vec4<f32>(unpack2x16float(p.x), unpack2x16float(p.y))); }
`;
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
    else if (d.code.includes("var<workgroup>") && d.code.includes("vec4<f16>")) {
      const code = d.code.includes("fn batch_prefill_") ? (packPrefillF16(d.code) ?? d.code) : d.code;
      d = { ...d, code: packWorkgroupF16(code) };
    }
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
    // Rudder's vision encoder (onnxruntime) makes its own device while it starts: not WebLLM's, so not tracked here
    // (tracking it moved the snapshot to the wrong device and every reading came back as zeros)
    if (a[0]?.label === "rudder-vision" || globalThis.rudderVisionStarting) return d;
    queue = d.queue;
    snap.device = d;
    return d;
  };

  // Snapshot: see the activations layer by layer, for every word of a reply. gpuSnapshot.start() copies the output
  // of every GPU job; WebLLM's GPU->CPU read of each picked word closes one step (that word's whole forward pass
  // plus sampling). gpuSnapshot.stop() resolves to one array per word of [{kernel, run, name, type, bytes, values}]
  // in launch order. run = how many times this kernel ran in the step (the layer number for per-layer kernels).
  // stepStart (a kernel-name regex for the first job of a forward pass) drops prompt-reading passes that didn't
  // pick a word. Costs nothing when off.
  // Cheap when on: right after each job, inside the same compute pass, a tiny copy kernel copies its outputs side by
  // side into one collection buffer (splitting the pass or adding a copy command per output halved the speed).
  // Each copy's offsets live in a slot of a uniform table, rewritten only when they change (they repeat every
  // word). Per word: one copy to a reusable staging buffer and one mapAsync, while the model carries on; the rows
  // are views into that one block.
  const STAGE = 12 << 20; // ponytail: 12 MB per word fits ~1300 outputs x 8 KB; outputs past it are skipped
  const SLOTS = 2048; // max outputs per word (word 1, the last prompt-reading pass, has ~1262)
  const snap = { on: false, cur: null, runs: {}, reads: [], pool: [], trash: [], stepStart: null, only: null, run: null, maxSteps: 0, bytes: 0, device: null };
  const outsOf = new WeakMap(), kernelOf = new WeakMap(), entriesOf = new WeakMap(), ours = new WeakSet();
  {
    // a kernel's outputs are its read_write storage bindings
    const csm = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (d) {
      const mod = csm.call(this, d);
      outsOf.set(mod, [...d.code.matchAll(/@binding\((\d+)\)\s*var<storage,\s*read_write>\s*(\w+)\s*:\s*array<(?:vec\d<)?(\w+)/g)]
        .map(([, binding, name, type]) => ({ binding: +binding, name, type })));
      return mod;
    };
    const info = (d, pipe) => { kernelOf.set(pipe, { name: d.compute.entryPoint, outs: outsOf.get(d.compute.module) ?? [] }); return pipe; };
    const ccp = GPUDevice.prototype.createComputePipeline, ccpa = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipeline = function (d) { return info(d, ccp.call(this, d)); };
    GPUDevice.prototype.createComputePipelineAsync = function (d) { return ccpa.call(this, d).then((p) => info(d, p)); };
  }
  let cp = null; // the copy kernel and its buffers, made on first use
  const copyKernel = (device) => {
    const S = GPUShaderStage.COMPUTE, U = GPUBufferUsage;
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: S, buffer: { type: "storage" } },
      { binding: 2, visibility: S, buffer: { type: "uniform", hasDynamicOffset: true } },
    ] });
    const module = device.createShaderModule({ code: `
      struct P { src: u32, dst: u32, count: u32, pad: u32 }
      @group(0) @binding(0) var<storage, read> src: array<u32>;
      @group(0) @binding(1) var<storage, read_write> dst: array<u32>;
      @group(0) @binding(2) var<uniform> p: P;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
        if (g.x < p.count) { dst[p.dst + g.x] = src[p.src + g.x]; }
      }` });
    return {
      pipe: device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: "main" } }),
      layout,
      collect: device.createBuffer({ size: STAGE, usage: U.STORAGE | U.COPY_SRC }),
      params: device.createBuffer({ size: SLOTS * 256, usage: U.UNIFORM | U.COPY_DST }),
      table: new Uint32Array(SLOTS * 4), // what each slot holds, so unchanged slots aren't rewritten
      groups: new WeakMap(), // source buffer -> bind group (WebLLM's buffers repeat every word)
    };
  };
  // after each dispatch while recording: copy its outputs before anything reuses those buffers
  const snapCopy = (pass, pipe, group) => {
    const k = kernelOf.get(pipe), entries = entriesOf.get(group);
    if (!k || !entries || (snap.only && !snap.only.test(k.name))) return;
    const c = (cp ??= copyKernel(snap.device)), st = (snap.cur ??= { off: 0, recs: [] });
    if (snap.stepStart?.test(k.name) && st.recs.length) { st.recs = []; st.off = 0; snap.runs = {}; } // a prompt-reading pass that picked no word: overwrite it
    const run = (snap.runs[k.name] = (snap.runs[k.name] ?? 0) + 1);
    if (snap.run && run !== snap.run) return; // only that run (e.g. layer 7's output)
    for (const o of k.outs) {
      const r = entries.find((e) => e.binding === o.binding)?.resource;
      if (!r?.buffer) continue;
      const off = r.offset ?? 0, bytes = r.size ?? r.buffer.size - off, n = Math.min(bytes, snap.bytes) & ~3, slot = st.recs.length;
      if (!n || st.off + n > STAGE || slot >= SLOTS) continue;
      const t = c.table, j = slot * 4, src = off / 4, dst = st.off / 4, count = n / 4;
      if (t[j] !== src || t[j + 1] !== dst || t[j + 2] !== count) {
        t[j] = src; t[j + 1] = dst; t[j + 2] = count;
        snap.device.queue.writeBuffer(c.params, slot * 256, t, j, 4);
      }
      let g = c.groups.get(r.buffer);
      if (!g) {
        g = snap.device.createBindGroup({ layout: c.layout, entries: [
          { binding: 0, resource: { buffer: r.buffer } },
          { binding: 1, resource: { buffer: c.collect } },
          { binding: 2, resource: { buffer: c.params, size: 16 } },
        ] });
        c.groups.set(r.buffer, g);
      }
      pass.setPipeline(c.pipe);
      pass.setBindGroup(0, g, [slot * 256]);
      pass.dispatchWorkgroups(Math.ceil(count / 256));
      st.recs.push({ kernel: k.name, run, name: o.name, type: o.type, bytes, at: st.off, n });
      st.off += n;
    }
  };
  const TYPES = { f16: Float16Array, f32: Float32Array, i32: Int32Array };
  const snapRead = async (st, buf) => {
    await buf.mapAsync(GPUMapMode.READ, 0, st.off);
    const raw = buf.getMappedRange(0, st.off).slice(0); // one copy per word
    buf.unmap();
    (snap.on ? snap.pool : snap.trash).push(buf);
    for (const r of st.recs) {
      const T = TYPES[r.type] ?? Uint32Array;
      r.values = new T(raw, r.at, r.n / T.BYTES_PER_ELEMENT);
    }
    return st.recs;
  };
  // WebLLM reads each picked word back to the CPU: that closes the current step. WebLLM submits its queued GPU work
  // just before this read, so one more submit copies the step's outputs out before the next word overwrites them.
  const snapTick = () => {
    const st = snap.cur;
    if (!snap.on || !st?.recs.length) return;
    const buf = snap.pool.pop() ?? snap.device.createBuffer({ size: STAGE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    ours.add(buf);
    const enc = snap.device.createCommandEncoder();
    enc.copyBufferToBuffer(cp.collect, 0, buf, 0, st.off);
    snap.device.queue.submit([enc.finish()]);
    snap.reads.push(snapRead(st, buf));
    snap.cur = null; snap.runs = {};
    if (snap.reads.length >= snap.maxSteps) snap.on = false;
  };
  globalThis.gpuSnapshot = {
    // bytes: copy only the first N bytes of each output (8 KB holds a word's 1536-number hidden state)
    // only: copy only kernels whose name matches (the filter probe takes just the 35 layer outputs)
    // run: copy only the n-th time a matching kernel runs in a step (one layer's output)
    start({ stepStart = null, only = null, run = null, maxSteps = 100, bytes = 8192 } = {}) {
      Object.assign(snap, { on: true, cur: null, runs: {}, reads: [], stepStart, only, run, maxSteps, bytes });
    },
    tick: () => snapTick(), // close the current step yourself (after the GPU work is submitted, e.g. device.sync())
    async stop() {
      snap.on = false;
      snap.cur = null; // an unfinished step
      const steps = await Promise.all(snap.reads);
      snap.trash.push(...snap.pool); // free the staging buffers
      snap.pool = [];
      return steps;
    },
  };
  // Staging buffers may still be used by work queued in WebLLM's command encoder; destroy them only after a real submit.
  const realSubmit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (cbs) {
    const r = realSubmit.call(this, cbs);
    if (snap.trash.length && cbs.length) { for (const b of snap.trash) b.destroy(); snap.trash = []; }
    return r;
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
  GPUBuffer.prototype.mapAsync = function (...a) {
    if (!ours.has(this)) snapTick();
    return poke(queue, m.apply(this, a));
  };
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
      let pipe, group; // for the snapshot
      return {
        setPipeline: (x) => { pipe = x; p.setPipeline(x); },
        setBindGroup: (...x) => { if (x[0] === 0) group = x[1]; p.setBindGroup(...x); },
        dispatchWorkgroups: (...x) => { p.dispatchWorkgroups(...x); if (snap.on) snapCopy(p, pipe, group); },
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
  // remember each bind group's buffers (cached groups keep theirs) so the snapshot can find a kernel's outputs
  const cbg = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function (d) { const g = cbg.call(this, d); entriesOf.set(g, d.entries); return g; };
}
