# Rudder gRPC API

For how Rudder works as a whole, see [docs/how-it-works.md](docs/how-it-works.md).

Rudder's filtering runs as a **pipeline** that apps on your computer can read, change or replace completely. Apps can also run their own stages (a local LLM, anything), receive every video Rudder sees in one fixed format, show their own panels in Rudder's popup, test videos, and time every stage.

```
your apps  ──gRPC 127.0.0.1:7833──▶  bridge/bridge.py  ◀──WebSocket 127.0.0.1:7834──  Rudder in Firefox
```

**Rudder's port is 7833** ("RUDD" on a phone keypad). Apps always connect to `127.0.0.1:7833`. The next port, 7834, is the bridge's link to Firefox; you never connect to it.

Firefox extensions can't serve gRPC, so a small local bridge sits in between. Rudder connects to it on its own, and retries every 5 seconds while it isn't running.

## Run it

```
cd bridge
pip install -r requirements.txt
python bridge.py
```

Then open Firefox with Rudder; it connects to the bridge within 5 seconds. Apps are separate projects that connect to `127.0.0.1:7833`.

To try every call by hand first, see [docs/postman.md](docs/postman.md): Postman finds the calls on its own (server reflection) and the guide has a ready message for each.

## The pipeline

A video goes through the stages in order. Each stage says **hide**, **show** or **pass** (no opinion), and can add fields to the video's record for the stages after it. The first hide or show decides, and later stages don't run. A video every stage passes is shown. A stage that fails hides the video for this session (Rudder is strict).

The default pipeline:

| Stage | Kind | Does |
|---|---|---|
| `your-clicks` | `your-clicks` | Your own like or dislike on this exact video: show or hide |
| `keywords` | `keywords` | The filters' words in the title or channel: hide |
| `learned` | `learned` | Your like/dislike model, and channels you disliked: hide. Adds `dislike_chance` |
| `thumbnail-text` | `thumbnail-text` | The filters' words in the thumbnail's text (OCR): hide. Adds `thumbnail_text` |

Stage settings (`config`):

| Kind | Config |
|---|---|
| `keywords`, `thumbnail-text` | `filters`: their own list instead of the popup's |
| `thumbnail-text` | `min_letters`: shortest word that counts (default 4; OCR makes short words out of noise) |
| `learned` | `can_show`: also show videos like ones you liked (a show skips every stage after it) |
| `app` | `name`: the app that runs it. `when_missing`: `hide` (default) or `pass` while that app isn't running. `remember`: `false` to be asked again each time YouTube sends the video. Anything else is passed to your app |

`SetPipeline` replaces the whole list, so it can add, remove, reorder or reconfigure stages. A pipeline of just your own app stage replaces Rudder's filtering entirely. Sending no stages restores the default. A wrong pipeline (an unknown kind, a repeated id, an app stage without a name) is refused and nothing changes. The pipeline is kept across restarts, and the popup shows it with how many videos each stage hid.

**If your app's stage is in the pipeline and the app isn't running, its videos are hidden** (unless `when_missing` is `pass`). With a pipeline that is only your app, YouTube stays empty until the app runs.

### Your own stage

1. Open the `Stage` stream and send `hello` with your app's name.
2. Put a stage of kind `app` with `config.name` set to that name into the pipeline (`GetPipeline`, insert, `SetPipeline`).
3. Each `StageRequest` brings a batch of videos and the stage's config. Answer with a `reply` of the same `id`: one `StageResult` per video, in order, each with a `decision` (`PASS`, `HIDE` or `SHOW`), a `why` and any `fields` you want later stages to see.

You have 25 seconds per batch. A late, missing or wrong-sized answer hides those videos. Rudder remembers each video's answer per stage config, so each video is sent once; change the config to have everything judged again. With `"remember": false` Rudder instead asks again each time YouTube sends the video (a new page, a refresh, after a restart), for answers that change, such as "seen before". One app can run several stages with different configs: the config comes with each request.

## The video record

Every video in the API (stage requests, `WatchVideos`, `GetVideos`, `Test`) has the same shape:

| Field | Is |
|---|---|
| `id` | YouTube's video id |
| `title` | |
| `channel` | Empty for most Shorts |
| `description` | Empty until YouTube sends one: search results have a snippet, a played video the full text |
| `published` | As YouTube shows it ("3 days ago"), or a date ("2026-10-29") once the video is played; or empty |
| `duration_seconds` | 0 if unknown (Shorts, live streams) |
| `seen_at_ms` | When Rudder first saw it (Unix ms) |
| `thumbnail`, `thumbnail_type`, `thumbnail_url` | The image Firefox downloaded for the page, its type and address |
| `source` | Where it came from: `browse` (home, channels), `next` (watch page), `search`, `reel_watch_sequence` (Shorts), `player`, `page`, `tile` |
| `short` | A Short |
| `fields` | Added by earlier stages: `thumbnail_text`, `dislike_chance`, and your apps' fields |

Rudder makes no requests to YouTube itself, so fields YouTube didn't send are empty rather than fetched. The thumbnail is the one the page loaded; a video whose thumbnail came from the browser's cache has none. Reload the page for complete records.

`WatchVideos` streams each video with its outcome (hidden or not, which stage decided, why) the first time it's decided. `WatchShown` streams the ids Rudder actually puts on screen, each time it does; a video decided as shown that the user never got to isn't in it. `GetVideos` returns the newest 500 the bridge has seen, newest first; set `thumbnails` to include the images.

## Build your own client

The service is defined in `bridge/rudder.proto`. Python stubs are already generated (`rudder_pb2.py`, `rudder_pb2_grpc.py`, `rudder_pb2.pyi`). After changing the proto, regenerate them with:

```
python -m grpc_tools.protoc -I . --python_out=. --pyi_out=. --grpc_python_out=. rudder.proto
```

For other languages, generate stubs from the same file with that language's gRPC tools.

| Call | Does |
|---|---|
| `GetState(Empty) → State` | Filters, pipeline stages, connected apps, statistics and the newest hidden videos |
| `WatchState(Empty) → stream State` | The state now, then again on every change |
| `SetFilters(Filters) → State` | Replaces the popup's filter list |
| `GetPipeline(Empty) → Pipeline` | The stages in order, and the kinds a stage can be |
| `SetPipeline(Pipeline) → Pipeline` | Replaces the pipeline. No stages restores the default |
| `Stage(stream StageMessage) → stream StageRequest` | Runs your app's stages |
| `WatchVideos(Empty) → stream VideoEvent` | Every video Rudder decides, with its record and outcome |
| `WatchShown(Empty) → stream Shown` | The videos Rudder puts on screen, as it does |
| `GetVideos(VideosRequest) → VideoEvents` | The newest videos the bridge has seen |
| `Test(TestRequest) → TestResults` | Runs videos through the pipeline without showing, counting or remembering them |
| `SetPanel(Panel) → Empty` | Shows your panel in the popup. The same `id` replaces it; no blocks removes it |
| `PanelEvents(Empty) → stream PanelEvent` | Clicks on your panels' buttons |
| `GetTimings(TimingsRequest) → Timings` | How long every stage takes, in ms. `reset` starts counting again |

## Panels: your app's UI in the popup

A panel is an `id`, a `title` and a list of blocks, drawn in Rudder's paper-and-ink style above the pipeline. There are five block types:

| Block | Shows |
|---|---|
| `text` | A line of text |
| `stats` | Big numbers with labels, three to a row, like Rudder's own statistics |
| `bars` | Labelled bars, scaled to the largest value |
| `table` | Columns and rows |
| `button` | A button. Clicks arrive on `PanelEvents` with the panel's id and the button's label |

Send the whole panel again whenever something changes; the popup redraws it while open. Panels are text only (never HTML) and last until the bridge or Firefox restarts.

To add a block type, add a field to `Block` in `rudder.proto`, regenerate the stubs, and add a renderer to `KINDS` in `extension/panel.js`.

## Timings

Every stage is timed: count and mean since the last reset, and p50, p95, max and last over the newest 500 runs.

| Stage | Is |
|---|---|
| `<stage id> (a batch)` | One batch of a slow stage: `learned`, `thumbnail-text`, your app stages |
| `keywords (a video)` | Keyword check on one title |
| `ocr (a thumbnail)` | Reading one thumbnail's text |
| `fingerprints (a batch)` | MiniLM on a batch of titles |
| `learner train` | Retraining the like/dislike model |
| `feedback (a click)` | A like or dislike, start to finish |
| `video: data to verdict` | From YouTube's data arriving to the pipeline deciding |
| `video: data to shown` | From YouTube's data arriving to the video appearing on screen |
| `test (a batch)` | A `Test` call inside Firefox |

## Writing your own tests

`Test` runs videos through the current pipeline, including your app stages, and returns for each one its outcome, every field the stages added, and a **trace**: what each stage said, in order, up to the one that decided. Nothing is shown, counted or remembered. Only `title` is needed; give a real video `id` to also apply your own like or dislike of it, and a `thumbnail` to run the OCR stage. Pair it with `GetTimings` to test speed as well as decisions.

Both ports listen on this computer only. Any program on it can connect and see the videos Rudder checks. Nothing leaves your computer.
