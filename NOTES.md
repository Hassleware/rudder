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
