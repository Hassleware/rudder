# Gemma in the browser: how to do it next time

Two ways to run it, sharing one file of GPU fixes (`extension/gpu-fixes.js`):
- `index.html`: a web page. Open it straight from disk; no server needed.
- `extension/`: the same chat as a Firefox toolbar popup (see below).

## Get it working (any browser)

1. **Use WebLLM, not transformers.js.** Model: `gemma-4-E2B-it-q4f16_1-MLC`. Its GPU programs come pre-built for the browser, and its answers were better than the 2-bit transformers.js version.
2. **One file, no server.** The Download button fetches every model file and saves them together as one `.bin`. The Run button reads that `.bin` back, and the page answers WebLLM's file requests from it by replacing the browser's built-in file cache (`caches`) with its own. That's why it works opened straight from disk.
3. **Free the GPU when the tab closes:** call `engine.unload()` on `pagehide`. Otherwise Firefox can keep gigabytes of VRAM after the tab is gone.

## Make Firefox fast (no Firefox settings changed)

4. **Fix the 100 ms wait per token.** Firefox only checks for finished GPU work every 100 ms, but any `queue.submit([])` makes it check immediately. So while the model waits on the GPU, the page sends empty submits about every 0.5 ms. This took Firefox from 6 to 20 tok/s.
5. **Fix the 50-second first reply.** One GPU program, the one that reads your whole message at once, takes Firefox ~40 s to build. Setting `prefillChunkSize = 1` makes it read one token at a time with programs that build quickly. The first word now comes in under a second.
6. **Shorten the warm-up.** Shrink two kinds of slow-to-build programs: a huge copy-pasted one (rewritten as a loop), and ones with big shared-memory arrays (packed half as large). Then run one tiny warm-up reply right after loading.
7. **Cut per-token overhead** (helps Chrome too):
   - reuse identical bind groups instead of recreating them every token
   - skip parameter writes when the bytes haven't changed
   - put all GPU jobs in one compute pass instead of one per job

   This took Firefox from 20 to 68 tok/s and Chrome from 55 to 78.

## Results (RTX 5080)

| | Firefox | Chrome |
|---|---|---|
| Start | 6 tok/s, 50 s to first word | 55 tok/s |
| End | ~68 tok/s, first word in 0.1–0.2 s | ~78 tok/s |

Loading is ~10 s plus a ~6 s warm-up.

## Firefox extension (in `extension/`)

The same chat as a toolbar popup, with all the speed fixes.

- **How it's split:** `background.js` runs the model in a background page that lives as long as Firefox. `popup.js` is only the chat window, so closing and reopening the popup is instant and keeps the chat.
- **First time:** the popup offers **Download (2.9 GB, ~9 min)** or **Import model file** (your `.bin` from `index.html`, ~8 s). The model is then stored inside the extension.
- **Loads at Firefox startup** (if installed), so the popup is ready when you open it.
- **VRAM:** freed automatically after 10 minutes without use.
- **Snapshot toggle:** while on, every reply is recorded word by word: the output of every GPU job (~1165 per word: embedding, each layer's norms/attention/MLP, sampling), and `snapshot.html` opens or refreshes. ←/→ step through the words (input word → picked word), ↑/↓ through the rows. The copies are added on the same command encoder right after each job, because WebLLM reuses buffers within a word. Each word closes at WebLLM's GPU→CPU read of the picked word; prompt-reading passes that pick no word are dropped, so word 1 is the last prompt pass (1262 rows, a different compiled program). Only the first 8 KB of each output is copied (~7.5 MB per word, max 100 words per reply), and pooled buffers can be bigger than the tensor, so values past its end are leftovers. Replies are identical with it on.
  - **Cheap recording (61 vs 67 tok/s):** a tiny WGSL copy kernel runs right after each job *inside the same compute pass* and copies its outputs into one collection buffer; offsets come from a uniform table slot (dynamic offset), rewritten only when they change. Per word: one copy to a pooled staging buffer, one mapAsync, rows are views into one ArrayBuffer. Measured: a buffer + mapAsync per output gave 5 tok/s; splitting the pass per output cost 68→37 and a copy command per output 37→29; read-back itself is ~free.
  - **Exact context:** background.js mirrors the KV cache by wrapping `artifactPrefillAndForward` / `artifactDecodeAndForward` (Gemma 4 is an "artifact" model; `embedAndForward` isn't used) and trimming to `filledKVCacheLength`. The title shows the exact tokens in memory. Note: the previous reply's `<turn|>` is not in the cache (stop tokens aren't fed back).
  - **KV cache:** max 4096 tokens since New chat; 15 of 35 layers store K/V (`num_kv_shared_layers` 20), ~8.4 MB each ≈ 126 MB; local layers attend to the last 512 tokens, global layers (every 5th) to all. `stages.js` groups the rows into setup → 35 layers (each split into norm/QKV, memory write, attention, attention add, MLP, per-layer input mix, layer output) → scoring → sampling, by matching Gemma 4 E2B's kernel names; another model would need new markers.
- **One-sentence filter (in the snapshot viewer):** type any sentence ("anything about bees", "I don't want any information on gambling") and **Set filter** (0.1 s after the first one). No examples, no training, one dot product per token.
  - **Method** (`probe.js`): the model reads the sentence as if it had written it as a chat reply; its **layer-7** output at the sentence's last token, minus the average of the same for 25 generic topic sentences ("anything about the weather", …; a Rocchio negative centroid, read once and cached), is the filter direction. Each token: dot product with its layer-7 output (1536 multiply-adds), in units of ordinary text's spread (z), smoothed (EMA ½), then averaged with the next two words' scores so context can settle the meaning ("spelling bee" vs "honeybee"; a word's verdict comes 2 words later). Fires above **z = 3.44** for every filter (1% of ordinary dev passages go over it).
  - **Capture:** `background.js` `layerStates` feeds text one token at a time and copies only the 35 layer-output kernels with the snapshot's in-pass copy kernel (~70 tokens/s); while chatting, the snapshot already holds them.
  - **Benchmark** (`bench/`, "benchmark" link in the viewer, ~45 s GPU): 10 filters, each with 6 on-topic passages that name the topic, 6 that don't ("the forager danced…"), 6 look-alikes ("spelling bee", "all at sea") and 1 mixed passage, plus 20 ordinary passages per set. `filters.json` = dev (5 filters, the method was chosen on these), `filters-test.json` = held out. Every filter also has 4 rephrasings, including "I don't want any information on …".
  - **Research** (`research/probe-research.mjs`, `node research/probe-research.mjs <dump dir> <round>`): dump every passage's layer outputs once (`dumpBench(url)` in the background page, ~1 min GPU, ~470 MB f16), then try probe variants on the CPU. ~1,700 setups over 5 rounds, chosen on dev with all 5 phrasings, checked on held-out:

    | | cost/token | AUROC dev | AUROC held-out | "I don't want…" phrasing |
    |---|---|---|---|---|
    | first version (12 layers, cosine, neutral sentence) | 36,864 | 0.830 | 0.822 | 0.53 |
    | **now (layer 7, dot product, topic bank)** | **1,536** | **0.984** | **0.983** | **0.98** |

    Held-out at the shipped threshold: 94% of direct and 81% of indirect passages fire, 41% of look-alikes, 3% of other topics, 0% of ordinary text; mixed passages never fire early and fire 2–11 tokens after the topic starts. (In the browser run: AUROC 0.982 dev / 0.984 held-out.)
  - **What mattered:** reading the sentence the way content is read (as a chat reply) and taking its last token; the topic-bank reference instead of one neutral sentence (0.970 → 0.985; even 3 topics help); layers 6–8 (the topic is clearest there; early layers miss paraphrases, deep layers miss topics). No gain from: more layers, cosine instead of dot, per-dimension whitening, two layers that must agree (fewer look-alikes but lower recall; a stricter 1-layer threshold does as well).
  - **Confidence** (`confidence` in `probe.js`, free): over the last 16 words, how many are over the threshold (1 = low, 2 = medium, 3+ = high) and the average of the top 3 scores. Look-alikes make one word spike; real topic text keeps several high (research round 6: top-3 average separates look-alikes better than the single highest word, 0.864 vs 0.823 held-out). The viewer underlines firing words yellow/orange/red by tier.
  - **Long text** (`bench/haystack.json`, "Run long-text test", ~3 min GPU): 14 pages of ordinary prose (1,713 tokens) and 40 needles hidden in it (2 passing mentions, 1 on-topic sentence, 1 look-alike per filter, each with ~300 words before it). Result (with the 2-word look-ahead): passing mentions flagged 17/20 (all medium or high), on-topic sentences 9/10, look-alikes 1/10 ("a gamble"). Pages alone: 8 of 10 filters never fired once in 1,713 tokens; cooking 4 times, gambling 2. Misses: all 3 football needles (scores 2–3: the "anything about football (soccer)" filter is the weakest) and one cooking mention.
  - **Look-alikes (research rounds 7–8):** tried four fixes that keep one dot product per word. (a) The model writes its own keyword-free sentences and look-alikes per filter, and the direction moves towards / away from them: no gain on held-out filters, because E2B's "look-alikes" are mostly on-topic ("A bee sting", "Worker bee"); it would need a stronger writer. (b) Removing the bare key word's direction: lower recall, no gain. (d) A deeper layer (9–15) that must agree: fewer look-alikes only by losing much more recall. (c) **Waiting two words for context: the winner**: at every strictness it gets more recall for the same look-alike rate. Held-out, all 5 phrasings: look-alikes 29% → 27% with direct hits 81% → 87% and keyword-free hits 62% → 74% (vs the old probe at the same strictness); shipped at z 3.44 it fires on a third fewer look-alikes than before (41% → 27%) for ~7 points less recall. Browser, each filter's main sentence: held-out look-alikes 47% → 37% (direct 100% → 97%, keyword-free 87% → 83%); long text: look-alike needles 2/10 → 1/10, false alarms over the pages cooking 7 → 4 and gambling 3 → 2, passing mentions still 17/20.
  - **Limits:** look-alikes are still the weak spot (ocean: "all at sea", a lake, a pool). Raising the threshold trades them off against recall (held-out: 2% ordinary fire → 41% look-alikes / 81% indirect; 1% → 29% / 62%). Tested only on short English passages and 10 topics.
- **Shared fixes:** `gpu-fixes.js` holds all the GPU fixes, shared with `index.html`'s approach. `vendor/web-llm.js` is copied from npm by `npm install`.

Commands:
- `npm start`: opens a separate Firefox with the extension loaded, reloading when you save a file. It uses `.dev-profile/` (kept between runs, so the model stays installed) and works with your normal Firefox open.
- `npm run lint`: checks our code the way addons.mozilla.org will. WebLLM's file is skipped because it's too big for the linter.
- `npm run build`: packs it into `dist/gemma_local-<version>.zip`.
- First time in a new folder: run `npm install`.
- Why manifest v2: it's the only way to get a background page that stays alive in Firefox, which the model needs.

## Rules of thumb

- **Measure before you fix.** Count GPU calls and time each program build. Every big win here came from a measurement, not a guess.
- **Check fixes are exact.** Compare the replies word for word with the original, and test in Chrome with the Firefox-only code forced on.
- **Never test GPU stuff while gaming.**
