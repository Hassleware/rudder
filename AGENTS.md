# Rudder: guide for agents

Rudder is a Firefox extension (Manifest V2) that filters YouTube recommendations **before they're shown**, on the user's own computer, plus a local gRPC API that lets other programs control the filtering. Read `docs/how-it-works.md` for the full design; this page is the short version.

## Map

| Path | What |
|---|---|
| `extension/background.js` | Entry point of the background page: built-in stage kinds, default pipeline, settings, API wiring |
| `extension/pipeline.js` | The filtering engine: ordered stages, each saying hide / show / pass; first hide or show decides |
| `extension/youtube/intercept.js` | Reads YouTube's data and thumbnails into video records; `verdict()` answers the page |
| `extension/youtube/feed.js`, `hide.css`, `page.js` | Content script, CSS and page script: hide until decided, reveal in order, fill the feed, Shorts, menus |
| `extension/youtube/captions.js` | Captions of watched videos: reads the player's English caption download, sends lines as you watch them |
| `extension/youtube/keywords.js` | Filter phrase → words, related words, safe phrases |
| `extension/youtube/personal.js` | Your 👍 / 👎: rated videos and twice-disliked channels (learning from them is an app's job: WatchFeedback) |
| `extension/ocr.js` | Tesseract OCR (WASM, CPU) |
| `extension/api.js` | WebSocket client to the bridge (127.0.0.1:7834) |
| `extension/popup.*`, `panel.js`, `timing.js` | Stats-only popup; apps' panels; stage timings |
| `bridge/bridge.py`, `bridge/rudder.proto` | Local gRPC server on **127.0.0.1:7833** and its contract; `rudder_pb2*` are generated |
| `tests/` | Browser-free checks |
| `API.md`, `docs/postman.md` | API reference; trying it in Postman |
| `docs/history.md` | Development log (much of it describes the removed Gemma design) |

## Commands

```
npm install            # also copies transformers.js and Tesseract into extension/vendor/
npm start              # a separate Firefox with the extension, reloading on save (profile: .dev-profile/)
npm test               # keywords, filter renames, your ratings, pipeline + YouTube parsing, captions
npm run test:bridge    # the API end to end (needs: pip install -r bridge/requirements.txt)
npm run lint           # web-ext lint, as addons.mozilla.org does
npm run build          # dist/*.zip
cd bridge && python bridge.py                          # run the API
python -m grpc_tools.protoc -I . --python_out=. --pyi_out=. --grpc_python_out=. rudder.proto   # after editing the proto
```

Run `npm test` after any change to the extension, and `npm run test:bridge` after any change to the API.

## Rules

- **Strict: fail closed.** Unknown, failed, timed-out or undecided means hidden. Never add a path that shows a video before it's decided, even for a frame. Over-blocking is acceptable; leaks are not.
- **No requests to YouTube from Rudder.** Read only what the page already receives (page data, `webRequest.filterResponseData`, thumbnail downloads). There are two exceptions, both YouTube's own requests: `fill()` in `feed.js` briefly puts YouTube's "load more" spot on screen so YouTube fetches its next page; and on a watch page `page.js` asks the player for English captions, so the player downloads them (`youtube/captions.js` reads them). No scrolling the user's page, no screenshots.
- **Processor only.** No GPU or WebGPU work; the models run on WASM (CPU).
- **No Firefox settings changes.** Everything must work in a stock Firefox.
- **The API is the boundary.** This repo is the extension and its API only: no example, demo or mock apps. Programs that use the API live in their own projects.
- **Keep the contract stable.** The video record and stage protocol in `bridge/rudder.proto` are what apps build on; change them deliberately, regenerate the stubs, and update `API.md` and `docs/postman.md`.
- **README.md is the author's own text.** Don't edit it.
- **Wording:** say "content script", "page script" or "add to the menu"; never "inject".
- **Comments:** short and plain, saying why, the way the existing code does.
