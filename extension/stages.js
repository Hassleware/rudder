// Groups one word's GPU outputs (from the snapshot) into the model's stages and explains each row, for WebLLM's
// Gemma 4 E2B build. Matching ignores the compiler's numbers (multiply15_sum3 and multiply35_sum9 are the same
// operation in the word-by-word and prompt-reading programs) and uses each row's position in its stage instead.
// ponytail: name-based, so another model would need its own rules.
const PHASES = {
  embed: ["Word → numbers (embedding lookup)", "#8e7cc3"],
  ple: ["Per-layer extra inputs (one slice per layer)", "#b4a7d6"],
  qkv: ["Normalize + make query/key/value + position", "#6fa8dc"],
  mem: ["Save this word to memory (K/V cache)", "#45818e"],
  attn: ["Attention: look back over the chat", "#3d85c6"],
  attnout: ["Attention result added to the stream", "#9fc5e8"],
  mlp: ["MLP: stored knowledge", "#e69138"],
  mix: ["Mix in this layer's extra input", "#c27ba0"],
  out: ["Layer output: the word's numbers after this layer", "#6aa84f"],
  score: ["Final normalize + score all 262k words", "#cc4125"],
  pick: ["Pick the word (softmax, sort, sample)", "#d4a017"],
};
const PICK = /chunk_lse|softmax|argsort|take_sorted|^full_kernel|cumsum|renorm|get_index/;

// -> per record {phase, layer, group, role}; layer 0 = before/after the layers
function classify(recs) {
  let layer = 0, phase = "embed", afterAdd = false, matmuls = 0;
  const out = recs.map(({ kernel }, i) => {
    const s = kernel.replace(/\d+/g, ""), before = phase;
    if (layer === 0) {
      if (phase === "embed" && /_split_kernel/.test(s)) phase = "ple";
      else if (phase === "ple" && /^cast_kernel$|^fused_multiply_sum_kernel$/.test(s)) { layer = 1; phase = "qkv"; }
    } else {
      if (phase === "out") { layer++; phase = "qkv"; }
      if (/kv_cache_transpose_append/.test(s)) phase = "mem";
      else if (/paged_kv/.test(s)) phase = "attn";
      else if (phase === "attn") phase = "attnout";
      else if (phase === "attnout" && afterAdd) phase = "mlp";
      else if (phase === "mlp" && /squeeze/.test(s)) phase = "mix";
      if (/_add_multiply(_cast)?_kernel$/.test(s)) phase = "out";
      afterAdd = /_add_kernel$/.test(s); // the residual add that ends the attention part
    }
    if (phase !== before) matmuls = 0;
    const mm = /NT_matmul/.test(s) && !/squeeze|tanh/.test(s) ? ++matmuls : 0;
    return { phase, layer, role: roleOf(s, phase, i, mm, matmuls) };
  });
  // after the last layer output: final norm + scoring, then sampling
  const last = out.findLastIndex((o) => o.phase === "out");
  let picking = false;
  for (let i = last + 1; i < out.length; i++) {
    const s = recs[i].kernel.replace(/\d+/g, "");
    picking ||= PICK.test(s);
    out[i] = { phase: picking ? "pick" : "score", layer: 0, role: roleOf(s, picking ? "pick" : "score", i, 0, 0) };
  }
  // name each layer: local or global attention, and whether it writes its own memory
  const info = {};
  out.forEach((o, i) => {
    if (!o.layer) return;
    const x = (info[o.layer] ??= { global: false, mem: false });
    if (/batch_decode_paged_kv_kernel/.test(recs[i].kernel)) x.global = true;
    if (o.phase === "mem") x.mem = true;
  });
  for (const [i, o] of out.entries()) {
    const x = info[o.layer];
    o.group = !o.layer ? (i <= last ? "Setup: turn the word into numbers" : "Choose the next word")
      : `Layer ${o.layer} · ${x.global ? "global attention (sees the whole chat)" : "local attention (recent words only)"}` +
        (x.mem ? "" : " · reuses earlier layers' memory");
  }
  return out;
}

// s = kernel name without numbers; mm = which matrix this is in its stage (1st, 2nd…); seen = matrices so far
function roleOf(s, phase, i, mm, seen) {
  if (PICK.test(s)) return s.match(PICK)[0];
  if (/_add_multiply(_cast)?_kernel$/.test(s)) return "layerOut";
  if (/_add_kernel$/.test(s) && /tir_sqrt/.test(s)) return "normAdd";
  if (/replace_modality/.test(s)) return "modality";
  if (/^index_kernel$/.test(s)) return "lastRow";
  if (/kv_cache_transpose_append/.test(s)) return "kvAppend";
  if (/batch_decode_paged_kv_sliding_window/.test(s)) return "attnLocal";
  if (/paged_kv/.test(s)) return "attnGlobal";
  if (/NT_matmul.*tanh/.test(s) && phase === "score") return "logits";
  if (/squeeze.*gelu/.test(s)) return "pleGate";
  if (/split_gelu/.test(s)) return "geglu";
  if (/dequantize_take/.test(s)) return i === 0 ? "embed" : "pleTable";
  if (phase === "embed" || phase === "ple") {
    if (s === "multiply_kernel") return "embedScale";
    if (/NT_matmul_multiply/.test(s)) return "pleProj";
    if (s === "cast_kernel") return "pleCast";
    if (/multiply_sum/.test(s)) return "pleSumSq";
    if (/_split_kernel/.test(s)) return "pleSplit";
  }
  if (mm) return { qkv: mm === 1 ? "query" : "keyvalue", attnout: "oProj", mlp: mm === 1 ? "up" : "down", mix: "pleUp" }[phase] ?? "matmul";
  if (/query_rope.*key_rope|concatenate/.test(s)) return "qkvPack";
  if (/query_rope/.test(s)) return "qrope";
  if (/key_rope/.test(s)) return "krope";
  if (/^fused_rope/.test(s)) return "ropeSplit";
  if (/^fused_split_kernel$/.test(s)) return "attnUnpack";
  if (/^pad_kernel$/.test(s)) return "pack";
  if (s === "cast_kernel") return phase === "qkv" && seen ? "qkvCast" : "cast";
  if (/multiply_sum/.test(s)) return phase === "qkv" && seen ? "qkvSumSq" : "sumSq";
  if (/tir_sqrt/.test(s)) return phase === "qkv" && seen ? (/pad/.test(s) ? "vnorm" : "qkvNorm") : "normFinish";
  return "other";
}

// What each kind of row does and why Gemma has it.
const WHY = {
  embed: "Looks up this word in the main embedding table: its 4-bit weights are unpacked into the word's starting numbers (1536 of them).",
  embedScale: "Multiplies the word's numbers by √1536 ≈ 39.2. Gemma scales embeddings up so they start at the same size as the numbers inside the network.",
  pleProj: "Per-layer inputs, part 1: projects the word's numbers into one small vector for each of the 35 layers, then scales them.",
  pleCast: "Converts that projection to full precision (f32) for the normalizing step.",
  pleSumSq: "Sum of squares of each per-layer slice: the first half of RMS normalization.",
  pleSplit: "Finishes normalizing the per-layer projection and cuts out one layer's slice. There is one of these jobs per layer (35 in all).",
  modality: "Prompt-reading only: swaps any image/audio placeholder ids for ones the text table understands. For plain text it changes nothing.",
  pleTable: "Per-layer inputs, part 2: looks this word up in a separate per-layer table (a small vector per word per layer). Gemma 'E' models keep this big table outside the main layers, which is why 'E2B' runs with about 2B parameters' worth of compute although the file holds more.",
  pleGate: "Per-layer input gate: combines this layer's two per-layer pieces (projection slice + table lookup), then lets the layer choose how much of it to use (small matrix from the word's numbers → GELU → multiply).",
  pleUp: "Projects the gated per-layer input back up to 1536 numbers so it can be added to the word's running numbers.",
  layerOut: "Layer output: normalizes the per-layer contribution, adds it to the word's running numbers (the residual stream), then multiplies by this layer's learned scale. This is the word's state after this layer.",
  cast: "Changes number precision (f16 ↔ f32) before a normalizing step.",
  sumSq: "Sum of squares across the word's 1536 numbers: the first half of RMS normalization (the next job finishes it). Gemma normalizes before and after every sub-block, so this appears about 5 times per layer.",
  normFinish: "Finishes RMS normalization: divides by √(mean square + a tiny epsilon) and multiplies by learned weights. Keeps the numbers in a stable range before the next matrix.",
  normAdd: "Finishes a normalization (divide by √(mean square), multiply by learned weights) and adds the result onto the word's running numbers: the residual add that ends the attention or MLP part.",
  query: "Query projection: 4-bit weights × the word's numbers → what this word is looking for in earlier words. (Global-attention layers use their own differently-sized heads.)",
  keyvalue: "Key/value projection (runs twice: key, then value). Keys are what each word offers to be matched on; values are what it passes along when matched.",
  qkvCast: "Precision change before normalizing the query, key or value.",
  qkvSumSq: "Sum of squares for normalizing the query, key or value. Gemma normalizes each attention head, which keeps attention scores from blowing up.",
  qkvNorm: "Finishes normalizing the query, key or value.",
  vnorm: "Finishes normalizing the value (values get no position encoding) and pads it to the attention head size.",
  qkvPack: "Finishes normalizing query, key and value, applies rotary position encoding (RoPE: rotates query and key so attention can tell how far apart words are), then pads and packs them together.",
  qrope: "Finishes the query and applies rotary position encoding. If this layer has no key/value jobs, it reuses an earlier layer's memory.",
  krope: "Finishes normalizing the key and applies rotary position encoding.",
  pack: "Pads or packs query/key/value into the layout attention expects (no maths).",
  ropeSplit: "Splits the packed query/key/value into the separate buffers WebLLM's attention code expects.",
  kvAppend: "Writes this word's key and value into the paged memory (KV cache) so later words can attend to it without recomputing. Only layers 1–15 do this; later layers reuse their memory, which saves VRAM.",
  attnLocal: "Local attention: compares this word's query with the keys of recent words only (a sliding window), turns the scores into weights and mixes those words' values. 'output' = the mix; 'lse' = log-sum-exp of the scores, used to combine partial results. Local layers are cheap and handle nearby grammar.",
  attnGlobal: "Global attention: like local attention but over the whole chat. Gemma only does this every 5th layer because it's expensive; it's how the model connects things far apart.",
  attnUnpack: "Unpacks the attention result (drops the padding added before attention) ready for the output projection.",
  oProj: "Attention output projection: mixes all the attention heads' results back into the word's 1536 numbers.",
  up: "MLP up-projection: expands the word's numbers into a much wider vector (gate and up halves together). Most of the model's stored knowledge lives in these MLP weights.",
  geglu: "GeGLU: splits into gate and up halves, runs GELU on the gate and multiplies. The gate acts like a soft switch deciding which knowledge features fire.",
  down: "MLP down-projection: compresses the wide vector back to 1536 numbers.",
  lastRow: "Prompt-reading only: keeps just the last position's numbers, since only the last word's scores are needed to pick the next word.",
  logits: "Scores all 262,144 vocabulary words by comparing the final numbers with the embedding table (the same table as row 1). Then soft-caps them (c·tanh(score/c)) so no score gets extreme.",
  chunk_lse: "Softmax in pieces, part 1: the vocabulary is too big for one GPU work group, so each chunk of 4096 words gets its own max and sum of exponentials.",
  softmax: "Softmax, part 2: turns every score into a probability using the chunk totals.",
  argsort: "GPU sort of the probabilities, biggest first. The sort runs as several merge passes (each run is one pass); the 'swap' buffers are its ping-pong space.",
  take_sorted: "Reads the probabilities out in sorted order.",
  full_kernel: "Fills a buffer with a constant (setup for the sampler).",
  cumsum: "Running total of the sorted probabilities, for top-p: keep the smallest set of likely words that covers p of the probability.",
  renorm: "Re-normalizes the probabilities after the unlikely words are cut off.",
  get_index: "Draws the word: finds where a random number lands in the running total and returns that word's id. At temperature 0 the top word always wins.",
};
// pieces of the compiler-made names
const PARTS = [
  [/fused/, "fused = several steps merged into one GPU job, so numbers stay on-chip between them"],
  [/dequantize/, "dequantize = unpack 4-bit weights to f16"],
  [/NT_matmul/, "NT_matmul = matrix × vector (weights × the word's numbers)"],
  [/take/, "take = table lookup by word id"],
  [/multiply\d+_sum|_sum\d/, "multiply+sum = sum of squares (for normalizing)"],
  [/multiply\d+(?!\d|_sum)/, "multiply = multiplication (learned weights or a scale)"],
  [/tir_sqrt/, "tir_sqrt = square root"],
  [/divide/, "divide = division (normalizing or scaling)"],
  [/add\d/, "add = addition (residual add or bias)"],
  [/cast/, "cast = change precision (f16 ↔ f32)"],
  [/gelu/, "gelu_tanh = GELU, a smooth on/off curve"],
  [/rope/, "rope = rotary position encoding"],
  [/split|concatenate|pad|squeeze/, "split/concatenate/pad/squeeze = reshaping, no maths"],
  [/tanh\d/, "tanh = squashes values into a range"],
];

function explain(r) {
  const parts = PARTS.filter(([re]) => re.test(r.kernel)).map(([, t]) => "• " + t);
  const nth = ["th", "st", "nd", "rd"][r.run % 10 < 4 && (r.run % 100 < 11 || r.run % 100 > 13) ? r.run % 10 : 0];
  return (WHY[r.role] ?? "No description for this kernel yet.") +
    (parts.length ? "\n\nName parts:\n" + parts.join("\n") + "\n• numbers like 7, 13 = the compiler's labels for variants" : "") +
    `\n\nOutput: ${r.name} (${r.type}). Run ${r.run} = the ${r.run}${nth} time this job ran for this word.`;
}
