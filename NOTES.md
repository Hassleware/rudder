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
  - **Benchmark** (`bench/`, "benchmark" link in the viewer, ~3 min GPU with the judge): 10 filters, each with 6 on-topic passages that name the topic, 6 that don't ("the forager danced…"), 6 look-alikes ("spelling bee", "all at sea") and 1 mixed passage, plus 20 ordinary passages per set. `filters.json` = dev (5 filters, the method was chosen on these), `filters-test.json` = held out. Every filter also has 4 rephrasings, including "I don't want any information on …".
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
  - **vs Gemma as a Yes/No judge** (same model, same passages, canonical sentences; it reads each passage whole and fires when it prefers "Yes"): judge AUROC 0.996 dev / 0.995 held-out vs probe 0.983 / 0.987; judge look-alikes 3% / 17% vs probe 27% / 37%, but judge recall is lower (held-out direct 90% vs 97%, keyword-free 70% vs 83%) and in long text it caught only **6/20 passing mentions** (vs 17/20) in ~110-word chunks, though with 0 false alarms. Cost: 125 ms and a full 35-layer pass over ~59 tokens per short-passage decision (needs the 512-token prefill kernel), vs one dot product per word. Neither wins outright: the judge is better at meaning, the probe at catching a mention anywhere, immediately.
  - **Cascade + ensemble (shipped; `CASCADE` and `cascade()` in `probe.js`, `judge()` / `cascadeRun()` in `background.js`):** per sentence, from the probe's word scores: peak ≤ 1.5 → clear, no judge; top-3 average ≥ 8 → blocked, no judge; otherwise Gemma judges that sentence alone (margin = logit Yes − logit No for its first answer word) and the ensemble **probe peak + 2 × margin** blocks above −8. The judge keeps its fixed prompt start (with the filter sentence) in memory and rolls back after each call (TVM `kv_state_popn`; same answer as a fresh read), reading one token at a time: ~0.38 s per call. Chosen with `research/cascade-sweep.mjs` on per-sentence scores saved from the extension (dev filters, look-alike fires counted 3× against hits; a sweep that counted them 1× picked a lenient threshold that got *worse* on held-out). Browser, each filter's main sentence:

    | | probe alone (dev / held-out) | cascade (dev / held-out) |
    |---|---|---|
    | AUROC | 0.983 / 0.987 | **0.994 / 0.996** |
    | direct hits | 77% / 97% | **100% / 97%** |
    | keyword-free hits | 53% / 83% | 57% / 80% |
    | look-alikes | 27% / 37% | **3% / 27%** |
    | other topics, ordinary passages | 0–2% | **0%** |
    | long text: mentions, on-topic, look-alikes | 17/20, 9/10, 1/10 | 17/20, **10/10**, 2/10 |
    | long text: false alarms on the pages | cooking 4, gambling 2 | **0** |
    | judge calls | none | ~5 per 1,000 ordinary words |

    In chats (filter "I don't want any information on bees"): trains reply clear (one unsure sentence, judge −28.9); honeybee reply blocked from the first sentence; a single passing bee in a paragraph blocked only at that sentence; "my niece won the school spelling bee" clear without needing the judge. The judge clears the chat's memory like the probe capture does, so the next message re-reads the history. Still a recorded-reply check in the viewer: stopping a reply live would need the probe in the generation pass and the judge on a second memory sequence.
  - **Snapshot fix:** a word's own layer output is in the *next* step (when it's fed back in); the viewer used to show each word's score on the following word.
  - **Limits:** look-alikes are still the weak spot (ocean: "all at sea", a lake, a pool). Raising the threshold trades them off against recall (held-out: 2% ordinary fire → 41% look-alikes / 81% indirect; 1% → 29% / 62%). Tested only on short English passages and 10 topics.
- **Shared fixes:** `gpu-fixes.js` holds all the GPU fixes, shared with `index.html`'s approach. `vendor/web-llm.js` is copied from npm by `npm install`.

Commands:
- `npm start`: opens a separate Firefox with the extension loaded, reloading when you save a file. It uses `.dev-profile/` (kept between runs, so the model stays installed) and works with your normal Firefox open.
- `npm run lint`: checks our code the way addons.mozilla.org will. WebLLM's file is skipped because it's too big for the linter.
- `npm run build`: packs it into `dist/gemma_local-<version>.zip`.
- First time in a new folder: run `npm install`.
- Why manifest v2: it's the only way to get a background page that stays alive in Firefox, which the model needs.

## Thumbnails (Gemma 4's eyes, research only so far)

- **Our WebLLM build has no vision** (its manifest: text + audio; "vision weights are excluded"). Gemma 4's own vision encoder ships separately in the ONNX build (`onnx-community/gemma-4-E2B-it-ONNX`, `vision_encoder_q4`, 99 MB + 0.2 MB graph). Its output (`image_features` [tokens × 1536]) goes straight into our model through the same entry point WebLLM uses for audio: `artifactPrefillAndForward(embeddings, [258880…], modality 1)` between `<|image>` (255999) and `<image|>` (258882). Preprocessing = transformers.js `Gemma4ImageProcessor`: aspect-preserving resize to a multiple of 48 px, /255, 16×16 patches in HWC order with [col, row] positions, 3×3 pooling → a 320×180 thumbnail at the 70-token budget is 528×288 px → **66 image tokens**.
- **It sees:** "a steam locomotive pulling a train… with a dramatic cloud of smoke", "a man, a fluffy puppy, and a black puppy, with text proclaiming a 'Puppy Guide!'", and reads text-only thumbnails exactly ("I LOST $10K AT THE CASINO"). Small subjects (bees on comb) come out vague at 70 tokens.
- **Text filters fire on images** (`research/thumb-bench.mjs`, thumbnails and scripts in `research/thumbs/`): 130 thumbnails = 40 real on-topic (4 per filter topic, from YouTube search), 20 text-only (topic only as words on a plain background), 30 look-alikes (spelling bee, glue gun, hot dog contest, lake swimming…), 30 ordinary + 10 neutral-text. Each goes into Gemma under the title "My weekend vlog"; the existing text probes score its image tokens. Calibrated per filter on 20 ordinary thumbnails only (mean and spread of the image score), threshold = the highest calibration score:
  - AUROC 0.96 (top-3 image tokens; 0.93 for the mean of all image tokens)
  - on-topic photos 80%, **text-only thumbnails 95%**, look-alikes 20%, other topics 8%, ordinary test thumbnails 3%
  - strong: dogs, crypto, guns, space, gambling, cooking photos (scores 6–21); weak: football match photos (all missed; the football filter is weak in text too), illness (doctor/flu photos), some bee-hive close-ups. Look-alikes that fire look the part (hot glue guns, lake swimming for "ocean").
  - images sit at their own per-filter baseline (e.g. any image ≈ 4.2 under "bees", ≈ 2 under "dogs"), so calibrating on ordinary *thumbnails* matters for the threshold (AUROC doesn't change).
- **Cost:** encoder 4.7 s per thumbnail single-threaded in Firefox (onnxruntime-web, CPU; its WebGPU backend would share the GPU with our patched WebGPU code), 0.2 s on 32 CPU threads in Node; Gemma reading the 66 image tokens ~0.6 s. The judge isn't usable on images yet (it leans "Yes" for any image with an uninformative title).

## YouTube home feed reader (`extension/youtube/`, not linked to the filter yet)

Sees every video's title and thumbnail **before the page shows it**, with no requests of its own, no scrolling and no screenshots; only the browser's own traffic and the page's own data.
- `page.js` is injected into the page by `feed.js` and reads the page's own `ytInitialData` the moment YouTube sets it (and `yt-navigate-finish` data). The home HTML comes through YouTube's service worker, so it isn't read off the network.
- `intercept.js` (background) turns that data into videos (id, title, channel, thumbnail address; Mixes by their first video, Shorts from `thumbnailViewModel.thumbnailViewModel.image.sources`), reads the bytes of every thumbnail the page downloads from `i.ytimg.com` and the page's own `youtubei/v1/browse` responses (Firefox `webRequest.filterResponseData`, bytes passed on unchanged). `verdict()` is where the filter will plug in; for now it waits until title and thumbnail are both read.
- `hide.css` + `feed.js` keep every home tile invisible (it keeps its size, so layout and lazy loading are normal) until its verdict is "show".
- Test (no scrolling, 2048×1019 window): 41 videos read, all with titles and thumbnail addresses; the page downloaded 14 thumbnails and all 14 were read; every tile on screen was shown, each only after its title (~200 ms before) and thumbnail (30–100 ms before) were read. YouTube only downloads thumbnails for tiles near the screen, so the rest arrive as you scroll. Results: `youtube-read-test.html`, `youtube-home-test.html`.
- `npm start` opens YouTube; the test profile is signed in.

## Rules of thumb

- **Measure before you fix.** Count GPU calls and time each program build. Every big win here came from a measurement, not a guess.
- **Check fixes are exact.** Compare the replies word for word with the original, and test in Chrome with the Firefox-only code forced on.
- **Never test GPU stuff while gaming.**
