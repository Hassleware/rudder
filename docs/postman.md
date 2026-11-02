# Rudder in Postman

Postman can call every part of Rudder's API ([API.md](../API.md)) by hand: no code, nothing to import.

## Set up once

1. Start the bridge: `cd bridge`, then `python bridge.py`. Open Firefox with Rudder, so the bridge has something to talk to.
2. In Postman: **New → gRPC**.
3. Server URL: `127.0.0.1:7833`. Leave TLS off (the lock icon open).
4. Under **Service definition**, choose **Using server reflection**. Postman lists every call from the bridge itself.
5. Pick a method, paste a message from below into **Message**, and press **Invoke**.

Save each request into a collection called "Rudder" and you have a reusable set. If reflection isn't available, import `bridge/rudder.proto` under **Service definition → Import .proto file** instead.

Messages are JSON with the field names from `rudder.proto`. Leave a field out to use its default.

## State

**GetState**: the filters, pipeline stages, connected apps, statistics and newest hidden videos.

```json
{}
```

**SetFilters**: replaces the popup's filter list. The reply is the new state.

```json
{
  "filters": ["video games", "news, war, death", "AI"]
}
```

## The pipeline

**GetPipeline**: the stages in order, and the kinds a stage can be.

```json
{}
```

**SetPipeline**: replaces the whole pipeline. This one keeps the default stages and adds an app stage named `postman` after `keywords`:

```json
{
  "stages": [
    { "id": "your-clicks", "kind": "your-clicks" },
    { "id": "keywords", "kind": "keywords" },
    { "id": "postman", "kind": "app", "config": { "name": "postman", "when_missing": "pass" } },
    { "id": "learned", "kind": "learned" },
    { "id": "thumbnail-text", "kind": "thumbnail-text" }
  ]
}
```

A pipeline of only your own stage replaces Rudder's filtering entirely; a stage can also have its own filter list:

```json
{
  "stages": [
    { "id": "games-only", "kind": "keywords", "config": { "filters": ["video games"] } },
    { "id": "mine", "kind": "app", "config": { "name": "postman" } }
  ]
}
```

Send no stages to restore the default:

```json
{}
```

## Video data

**GetVideos**: the newest videos the bridge has seen, each with its record and outcome. Set `thumbnails` to `true` to include the images (base64).

```json
{
  "limit": 5,
  "thumbnails": false
}
```

**Test**: what would the pipeline do with these videos? Each result has the outcome, the fields the stages added, and a trace of what every stage said. Nothing is shown, counted or remembered.

```json
{
  "videos": [
    { "title": "Minecraft hardcore: 100 days" },
    { "title": "Easy sourdough bread at home", "channel": "Baking with Jo" },
    { "id": "dQw4w9WgXcQ", "title": "Breaking news: election results" }
  ]
}
```

Only `title` is needed. A real video `id` also applies your own like or dislike of it. A thumbnail goes in `"thumbnail"` as base64, with `"thumbnail_type": "image/jpeg"`, to run the OCR stage.

## Panels and timing

**SetPanel**: shows a panel in Rudder's popup. Open the popup to see it.

```json
{
  "id": "postman",
  "title": "From Postman",
  "blocks": [
    { "text": "Hello from Postman" },
    { "stats": { "stats": [{ "label": "requests", "value": "1" }, { "label": "errors", "value": "0" }] } },
    { "bars": { "bars": [{ "label": "fast", "value": 2 }, { "label": "slow", "value": 9 }] } },
    { "table": { "columns": ["name", "ms"], "rows": [{ "cells": ["keywords", "0.1"] }, { "cells": ["ocr", "60"] }] } },
    { "button": "Click me" }
  ]
}
```

To remove it, send the same `id` with no blocks:

```json
{
  "id": "postman"
}
```

**GetTimings**: how long every stage takes, in ms. Set `reset` to `true` to start counting again after this read.

```json
{
  "reset": false
}
```

## Streams

**WatchState**: send `{}` and leave it open. A new state arrives every time something changes, for example when you edit the filters in the popup.

**WatchVideos**: send `{}` and leave it open, then browse YouTube. Every video arrives with its record and outcome as Rudder decides it.

**WatchShown**: send `{}` and leave it open. Each time Rudder puts videos on screen you get their ids: `{ "ids": ["dQw4w9WgXcQ"], "at_ms": "1793000000000" }`.

**PanelEvents**: send `{}` and leave it open, then click a button on your panel in the popup. Each click arrives as:

```json
{ "panel": "postman", "button": "Click me" }
```

**Stage**: run an app stage by hand. Postman keeps this stream open, and you send messages one at a time.

1. Add a stage for it with the first **SetPipeline** example above (it uses `"when_missing": "pass"`, so videos still show while you aren't connected).
2. Open **Stage**, press **Invoke**, then send the hello:

   ```json
   { "hello": { "name": "postman" } }
   ```

3. Browse YouTube. Each batch arrives as a `StageRequest` with an `id`, the stage's `config` and a list of `videos`.
4. Answer with the same `id` and exactly one result per video, in order (this example is for a batch of two):

   ```json
   {
     "reply": {
       "id": "1",
       "results": [
         { "decision": "HIDE", "why": "hidden from Postman" },
         { "decision": "PASS", "fields": { "checked_by": "postman" } }
       ]
     }
   }
   ```

You have 25 seconds per batch; slower answers leave those videos hidden, as Rudder is strict. This is mostly useful for watching what a stage receives; a real stage is an app. Restore the default pipeline when you're done.

## Errors

| Status | Means |
|---|---|
| `UNAVAILABLE` | Firefox isn't connected to the bridge: open Firefox with Rudder, wait up to 5 seconds, and try again |
| `INVALID_ARGUMENT` | A wrong pipeline (the message says what), a panel without an `id`, or a stage stream without a hello or with a name already in use |
| Can't connect at all | The bridge isn't running: `python bridge.py` |
