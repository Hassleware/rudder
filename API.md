# Rudder gRPC API

Apps on your computer can read and change Rudder's filters, watch its statistics, and add their own filtering layers (for example a local LLM).

```
your apps  ──gRPC 127.0.0.1:47801──▶  bridge/bridge.py  ◀──WebSocket 127.0.0.1:47800──  Rudder in Firefox
```

Firefox extensions can't serve gRPC, so a small local bridge sits in between. Rudder connects to it on its own, and retries every 5 seconds while it isn't running.

## Run it

```
cd bridge
pip install -r requirements.txt
python bridge.py
python example_layer.py      # in another terminal: hides titles containing "minecraft"
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

`example_layer.py` shows a complete layer in about 30 lines. Replace its `judge()` function with your own logic.

## How layers behave

- Each video Rudder checks is sent with its title, channel and thumbnail. The thumbnail is the image Firefox already downloaded, so your app never contacts YouTube.
- Several layers can connect at once. A video is hidden if any layer hides it, and your `why` appears in the popup's recently hidden list.
- Rudder remembers verdicts per video, so each video is judged once. Connecting or disconnecting a layer changes the combined layer name, so videos are judged again.
- Strict, like the rest of Rudder: if a layer doesn't answer within 25 seconds, answers with the wrong number of verdicts, or disconnects mid-request, those videos stay hidden for this session.
- When the last layer disconnects, the feed goes back to Rudder's own filters.

Both ports listen on this computer only. Any program on it can connect and see the videos Rudder checks. Nothing leaves your computer.
