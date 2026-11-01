# Rudder desktop API

Apps on your computer can read and change Rudder's filters, and add their own filtering layer (for example a local LLM).

Your app runs a WebSocket server on `ws://127.0.0.1:47800`. Rudder connects to it, and retries every 5 seconds while nothing is listening. Messages are JSON. A working example is in `examples/rudder-app.py`.

## Rudder → app

| Message | When |
|---|---|
| `{"type": "state", "enabled", "filters": [...], "layer", "stats", "recent"}` | On connect, whenever the filters change, and in reply to `get` |
| `{"type": "judge", "id": 7, "videos": [{"id", "title", "channel", "image", "imageType"}]}` | Videos for your layer to judge. `image` is the thumbnail as base64 (or `null`) |
| `{"type": "error", "error": "..."}` | Rudder didn't understand a message |

## App → Rudder

| Message | Does |
|---|---|
| `{"type": "get"}` | Asks for `state` |
| `{"type": "set-filters", "filters": ["video games", "news, war, death"]}` | Replaces the filter list, the same as editing it in the popup |
| `{"type": "layer", "name": "my-llm"}` | Adds your layer. Every video is then also sent to you to judge. `"name": null` removes it |
| `{"type": "verdicts", "id": 7, "results": [{"blocked": true, "why": "about elections"}, ...]}` | Your answer to `judge`: one result per video, in the same order |

## How a layer behaves

- It works like one more filter, named `app: <name>`. A video hidden by it shows that name and your `why` in the popup's recently hidden list.
- Verdicts are remembered per video, so each video is sent to you once. To have every video judged again, change the layer's name.
- Strict, like the rest of Rudder: if you don't answer within 30 seconds, answer with the wrong number of results, or disconnect mid-request, those videos stay hidden for this session.
- When your app disconnects, the layer is removed and the feed goes back to Rudder's own filters.
- One app at a time. To run several layers, have one app combine them.

Anything on your computer listening on that port sees the videos Rudder checks. Nothing leaves your computer.
