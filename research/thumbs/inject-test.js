
// TEST ONLY: thumbnail benchmark, step 2 (GPU): inject each thumbnail's encoder output into Gemma under a neutral
// title, save the image tokens' layer-7 states, and the 10 filters' probes.
(async () => {
  const log = (m) => fetch("http://127.0.0.1:8765/LOG?" + encodeURIComponent((performance.now() / 1000).toFixed(1) + "s " + m));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = performance.now();
  while (!engine) { await wait(200); if (performance.now() - t > 120000) { log("AUTO TIMEOUT " + status); log("AUTO DONE"); return; } }
  try {
    const SRV = "http://127.0.0.1:8765/vision/tbench/";
    const items = await (await fetch(SRV + "all.json")).json();
    const p = engine.loadedModelIdToPipeline.get(MODEL_ID), tok = p.tokenizer;
    const BOI = 255999, IMG = 258880, EOI = 258882;
    const text = (s) => Array.from(tok.encode(s)).map((id) => ({ id }));
    const image = (rows) => [{ id: BOI }, ...rows.map((emb) => ({ id: IMG, emb })), { id: EOI }];
    async function feed(items2, capture = false) {
      await engine.resetChat(); judgeKept = null;
      const states = [];
      for (let i = 0; i < items2.length; i += 32) {
        const chunk = items2.slice(i, i + 32);
        if (capture) globalThis.gpuSnapshot.start({ only: TAP, maxSteps: 1, bytes: 1536 * 4 });
        try {
          chunk.forEach((it, j) => {
            p.tvm.beginScope();
            let e;
            if (it.emb) { e = p.tvm.empty([1, 1536], "float16", p.device); e.copyFromRawBytes(new Uint8Array(it.emb.buffer, it.emb.byteOffset, 3072)); }
            else e = p.getArtifactTextEmbeddings([it.id]);
            const l = p.artifactPrefillAndForward(e, [it.id], [it.emb ? 1 : 0]);
            if (i + j === items2.length - 1) p.updateLogitsOnCPU(l);
            p.tvm.endScope();
          });
          await p.device.sync();
          if (capture) globalThis.gpuSnapshot.tick();
        } finally {
          if (capture) {
            const recs = (await globalThis.gpuSnapshot.stop()).flat();
            for (let k = 0; k < chunk.length; k++) states.push(recs[k * 35 + PROBE.layer].values.subarray(0, 1536));
          }
        }
      }
      return { logits: p.logitsOnCPU.toArray(), states };
    }
    const argmax = (a) => { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; };
    async function generate(items2, max = 30) {
      let id = argmax((await feed(items2)).logits);
      const out = [];
      for (let k = 0; k < max && id !== 106 && id !== 1; k++) {
        out.push(id);
        p.tvm.beginScope(); p.updateLogitsOnCPU(p.artifactDecodeAndForward(id)); p.tvm.endScope();
        await p.device.sync();
        id = argmax(p.logitsOnCPU.toArray());
      }
      return tok.decode(Int32Array.from(out));
    }
    const rows = async (key, n) => { const f = new Float16Array(await (await fetch(SRV + "feat/" + key + ".bin")).arrayBuffer()); return Array.from({ length: n }, (_, i) => f.subarray(i * 1536, (i + 1) * 1536)); };

    // can it read text in a thumbnail?
    for (const it of items.filter((x) => x.kind.startsWith("text")).filter((_, i) => i % 7 === 0)) {
      const said = await generate([...text("<|turn>user\n"), ...image(await rows(it.key, it.n)), ...text("\nWhat does the text in this image say?<turn|>\n<|turn>model\n")]);
      log(`RESULT read "${it.title}": ${JSON.stringify(said)}`);
    }
    // probes for the 10 filters
    const filters = [...(await bench()).filters, ...(await (await fetch("bench/filters-test.json")).json()).filters], probes = {};
    for (const f of filters) { const fl = await makeFilter(f.sentence); probes[f.id] = { sentence: f.sentence, w: Array.from(fl.probe.w), b: fl.probe.b, sd: fl.probe.sd }; }
    await fetch("http://127.0.0.1:8765/SAVE?thumb-probes.json", { method: "POST", body: JSON.stringify(probes) });
    // every thumbnail under the neutral title: save the image tokens' and title tokens' layer-7 states
    const [pre] = (await bench()).templates.content.reply.split("{text}"), nPre = text(pre).length, t0 = performance.now();
    for (const it of items) {
      const img = await rows(it.key, it.n), { states } = await feed([...text(pre), ...image(img), ...text("\nMy weekend vlog")], true);
      const keep = states.slice(nPre), buf = new Float16Array(keep.length * 1536);
      keep.forEach((x, i) => buf.set(x, i * 1536));
      await fetch("http://127.0.0.1:8765/SAVE?acts-thumb_" + encodeURIComponent(it.key) + ".bin", { method: "POST", body: buf.buffer });
      it.saved = keep.length; // boi + n image tokens + eoi + title tokens
    }
    await fetch("http://127.0.0.1:8765/SAVE?thumb-index.json", { method: "POST", body: JSON.stringify(items) });
    log(`RESULT saved ${items.length} thumbnails in ${((performance.now() - t0) / 1000).toFixed(0)} s (${((performance.now() - t0) / items.length).toFixed(0)} ms each in Gemma)`);
  } catch (err) { log("test error: " + err.message + " " + err.stack?.split("\n").slice(0, 4).join(" | ")); }
  log("AUTO DONE");
})();
