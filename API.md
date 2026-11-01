# Rudder gRPC API

Apps on your computer can read and change Rudder's filters, watch its statistics, add their own filtering layers (for example a local LLM), show their own panels in Rudder's popup, read how long every stage takes, and test videos against the filters.

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
python example_layer.py      # in another terminal: hides titles containing "minecraft"
python example_panel.py      # shows its own panel in Rudder's popup
python -m unittest example_test
```

## Build your own client

The service is defined in `bridge/rudder.proto`. Python stubs are already generated (`rudder_pb2.py`, `rudder_pb2_grpc.py`, `rudder_pb2.pyi`). After changing the proto, regenerate them with:

```
python -m grpc_tools.protoc -I . --python_out=. --pyi_out=. --grpc_python_out=. rudder.proto
```

For other languages, generate stubs from the same file with that language's gRPC tools.

| Call | Does |
|---|---|
| `GetState(Empty) → State` | Filters, layers, statistics and the newest hidden videos |
| `WatchState(Empty) → stream State` | The state now, then again on every change |
| `SetFilters(Filters) → State` | Replaces the filter list, the same as editing it in the popup. `UNAVAILABLE` if Firefox isn't connected |
| `Layer(stream LayerMessage) → stream JudgeRequest` | A filtering layer: send `hello` with a name, then answer each `JudgeRequest` with `verdicts` of the same `id` |
| `SetPanel(Panel) → Empty` | Shows your panel in the popup. The same `id` replaces it; no blocks removes it |
| `PanelEvents(Empty) → stream PanelEvent` | Clicks on your panels' buttons |
| `GetTimings(TimingsRequest) → Timings` | How long every stage takes, in ms. `reset` starts counting again |
| `Test(TestRequest) → TestResults` | Checks videos against the current filters and layers without showing, counting or remembering them |

`example_layer.py` shows a complete layer in about 30 lines. Replace its `judge()` function with your own logic.

## Panels: your app's UI in the popup

A panel is an `id`, a `title` and a list of blocks, drawn in Rudder's paper-and-ink style above the filters. There are five block types:

| Block | Shows |
|---|---|
| `text` | A line of text |
| `stats` | Big numbers with labels, three to a row, like Rudder's own statistics |
| `bars` | Labelled bars, scaled to the largest value |
| `table` | Columns and rows |
| `button` | A button. Clicks arrive on `PanelEvents` with the panel's id and the button's label |

Send the whole panel again whenever something changes; the popup redraws it while open. `example_panel.py` redraws every 2 seconds. Panels are text only (never HTML) and last until the bridge or Firefox restarts.

To add a block type, add a field to `Block` in `rudder.proto`, regenerate the stubs, and add a renderer to `KINDS` in `extension/panel.js`.

## Timings

Every stage is timed: count and mean since the last reset, and p50, p95, max and last over the newest 500 runs.

| Stage | Is |
|---|---|
| `keywords (a video)` | Keyword check on one title |
| `ocr (a thumbnail)` | Reading one thumbnail's text |
| `fingerprints (a batch)` | MiniLM on a batch of titles |
| `layers (a batch)` | Round trip to your layers |
| `judge (a batch)` | OCR, fingerprints and layers together |
| `learner train` | Retraining the like/dislike model |
| `feedback (a click)` | A like or dislike, start to finish |
| `video: data to verdict` | From YouTube's data arriving to a video being judged |
| `video: data to shown` | From YouTube's data arriving to a video appearing on screen |
| `test (a batch)` | A `Test` call inside Firefox |

## Writing your own tests

`Test` runs videos through the same keywords, thumbnail OCR, like/dislike model and layers as real YouTube videos, and returns for each one whether it would be hidden, why, and every filter's verdict. Nothing is shown, counted or remembered. Give a real video `id` to also apply your own like or dislike of it. `example_test.py` is a starting point with `unittest`, including a speed test on the timings.

## How layers behave

- Each video Rudder checks is sent with its title, channel and thumbnail. The thumbnail is the image Firefox already downloaded, so your app never contacts YouTube.
- Several layers can connect at once. A video is hidden if any layer hides it, and your `why` appears in the popup's recently hidden list.
- Rudder remembers verdicts per video, so each video is judged once. Connecting or disconnecting a layer changes the combined layer name, so videos are judged again.
- Strict, like the rest of Rudder: if a layer doesn't answer within 25 seconds, answers with the wrong number of verdicts, or disconnects mid-request, those videos stay hidden for this session.
- When the last layer disconnects, the feed goes back to Rudder's own filters.

Both ports listen on this computer only. Any program on it can connect and see the videos Rudder checks. Nothing leaves your computer.
