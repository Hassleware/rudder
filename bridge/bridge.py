# Rudder's local gRPC server. Firefox (extension/api.js) connects here over a WebSocket on 127.0.0.1:7834; your apps
# connect over gRPC on 127.0.0.1:7833 (rudder.proto). Several layers can connect at once: the bridge asks each one
# and a video is hidden if any of them hides it.
# Usage: pip install -r requirements.txt, then python bridge.py
import asyncio, base64, itertools, json, time
import grpc, websockets
from google.protobuf.json_format import MessageToDict
import rudder_pb2 as pb, rudder_pb2_grpc as rpc

WS_PORT, GRPC_PORT, TIMEOUT = 7834, 7833, 25  # under the extension's own 30 s


class Bridge(rpc.RudderServicer):
    def __init__(self):
        self.ext = None  # the extension's WebSocket
        self.state = pb.State()
        self.watchers = set()  # one queue per WatchState call
        self.changed = asyncio.Event()
        self.layers = {}  # name → queue of JudgeRequests
        self.pending = {}  # (layer name, request id) → future of its verdicts
        self.panels = {}  # id → panel (as JSON), sent again when Firefox reconnects
        self.clicks = set()  # one queue per PanelEvents call
        self.asks = {}  # request id → future of Firefox's answer (timings, test)
        self.ids = itertools.count(1)

    # ---- Firefox side ----
    async def extension(self, ws):
        self.ext = ws  # a newer connection replaces an older one
        await self.sync_layers()
        for p in self.panels.values():
            await ws.send(json.dumps({"type": "panel", "panel": p}))
        try:
            async for raw in ws:
                m = json.loads(raw)
                if m["type"] == "state":
                    self.set_state(m)
                elif m["type"] == "judge":
                    asyncio.create_task(self.judge(m))
                elif m["type"] == "panel-event":
                    for q in self.clicks:
                        q.put_nowait(pb.PanelEvent(panel=m["panel"], button=m["button"]))
                elif m["type"] in ("timings", "test-result") and m.get("id") in self.asks:
                    f = self.asks.pop(m["id"])
                    if not f.done():
                        f.set_result(m)
                elif m["type"] == "error":
                    print("rudder:", m["error"], flush=True)
        finally:
            if self.ext is ws:
                self.ext = None
                for f in self.asks.values():
                    if not f.done():
                        f.set_exception(ConnectionError("Firefox disconnected"))
                self.asks.clear()
                self.state.connected = False
                self.publish()

    async def sync_layers(self):
        if self.ext:  # the extension sees all layers as one, named after them all
            await self.ext.send(json.dumps({"type": "layer", "name": "+".join(sorted(self.layers)) or None}))

    def set_state(self, m):
        s, learn = m.get("stats", {}), m.get("stats", {}).get("learning", {})
        self.state = pb.State(
            connected=True, enabled=bool(m.get("enabled")), filters=m.get("filters", []), layers=sorted(self.layers),
            stats=pb.Stats(checked=s.get("checked", 0), hidden=s.get("hidden", 0), hidden_by_filter=s.get("by", {}),
                           likes=learn.get("likes", 0), dislikes=learn.get("dislikes", 0), learning=bool(learn.get("learning"))),
            recent=[pb.Hidden(id=h["id"], title=h["title"], channel=h["channel"], why=h["why"]) for h in m.get("recent", [])])
        self.publish()

    def publish(self):
        self.state.layers[:] = sorted(self.layers)
        for q in self.watchers:
            q.put_nowait(self.state)
        self.changed.set()
        self.changed = asyncio.Event()

    async def judge(self, m):
        videos = [pb.Video(id=v["id"], title=v["title"] or "", channel=v["channel"] or "",
                           image=base64.b64decode(v["image"]) if v.get("image") else b"", image_type=v.get("imageType") or "")
                  for v in m["videos"]]
        n = len(videos)
        results = [{"blocked": not self.layers, "why": "no layer connected" if not self.layers else ""} for _ in videos]

        async def ask(name, q):
            f = asyncio.get_running_loop().create_future()
            self.pending[(name, m["id"])] = f
            q.put_nowait(pb.JudgeRequest(id=m["id"], videos=videos))
            try:
                rs = await asyncio.wait_for(f, TIMEOUT)
                if len(rs) != n:
                    raise ValueError(f"{len(rs)} verdicts for {n} videos")
                return name, [(r.blocked, r.why) for r in rs]
            except Exception as err:  # strict: a layer that fails hides the whole batch
                return name, [(True, f"failed: {err or 'no answer'}")] * n
            finally:
                self.pending.pop((name, m["id"]), None)

        for name, rs in await asyncio.gather(*(ask(k, q) for k, q in list(self.layers.items()))):
            for r, (blocked, why) in zip(results, rs):
                if blocked and not r["blocked"]:
                    r.update(blocked=True, why=f"{name}: {why}" if len(self.layers) > 1 else why)
        if self.ext:
            await self.ext.send(json.dumps({"type": "verdicts", "id": m["id"], "results": results}))

    async def ask(self, m, context, timeout=60):
        """send Firefox a request and wait for its answer"""
        if not self.ext:
            await context.abort(grpc.StatusCode.UNAVAILABLE, "Firefox isn't connected to the bridge")
        m["id"] = next(self.ids)
        f = self.asks[m["id"]] = asyncio.get_running_loop().create_future()
        await self.ext.send(json.dumps(m))
        try:
            return await asyncio.wait_for(f, timeout)
        except (asyncio.TimeoutError, ConnectionError) as err:
            await context.abort(grpc.StatusCode.UNAVAILABLE, f"no answer from Firefox: {err or 'timed out'}")
        finally:
            self.asks.pop(m["id"], None)

    # ---- gRPC side ----
    async def GetState(self, request, context):
        return self.state

    async def WatchState(self, request, context):
        q = asyncio.Queue()
        self.watchers.add(q)
        try:
            yield self.state
            while True:
                yield await q.get()
        finally:
            self.watchers.discard(q)

    async def SetFilters(self, request, context):
        if not self.ext:
            await context.abort(grpc.StatusCode.UNAVAILABLE, "Firefox isn't connected to the bridge")
        changed = self.changed
        await self.ext.send(json.dumps({"type": "set-filters", "filters": list(request.filters)}))
        await asyncio.wait_for(changed.wait(), 5)
        return self.state

    async def SetPanel(self, request, context):
        if not request.id:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "a panel needs an id")
        p = MessageToDict(request, preserving_proto_field_name=True)
        if request.blocks:
            self.panels[request.id] = p
        else:
            self.panels.pop(request.id, None)
        if self.ext:
            await self.ext.send(json.dumps({"type": "panel", "panel": p}))
        return pb.Empty()

    async def PanelEvents(self, request, context):
        q = asyncio.Queue()
        self.clicks.add(q)
        try:
            while True:
                yield await q.get()
        finally:
            self.clicks.discard(q)

    async def GetTimings(self, request, context):
        m = await self.ask({"type": "timings", "reset": request.reset}, context)
        return pb.Timings(timings=[pb.Timing(name=t["name"], count=t["count"], mean_ms=t["mean"], p50_ms=t["p50"], p95_ms=t["p95"],
                                             max_ms=t["max"], last_ms=t["last"]) for t in m["timings"]])

    async def Test(self, request, context):
        t = time.perf_counter()
        videos = [{"id": v.id, "title": v.title, "channel": v.channel, "image": base64.b64encode(v.image).decode() if v.image else None}
                  for v in request.videos]
        m = await self.ask({"type": "test", "videos": videos}, context, timeout=120)
        if m.get("error"):
            await context.abort(grpc.StatusCode.INTERNAL, m["error"])
        return pb.TestResults(ms=(time.perf_counter() - t) * 1000, results=[
            pb.TestResult(id=r["id"], hidden=r["hidden"], why=r["why"],
                          filters={k: pb.FilterVerdict(blocked=bool(x.get("blocked")), verdict=x.get("verdict", "")) for k, x in r["verdicts"].items()})
            for r in m["results"]])

    async def Layer(self, requests, context):
        first = await anext(requests, None)
        name = first.hello.name.strip() if first and first.HasField("hello") else ""
        if not name or "+" in name or name in self.layers:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "send a hello with a new name (no '+') first")
        q = asyncio.Queue()
        self.layers[name] = q
        await self.sync_layers()
        self.publish()

        async def read():
            async for msg in requests:
                if msg.HasField("verdicts"):
                    f = self.pending.get((name, msg.verdicts.id))
                    if f and not f.done():
                        f.set_result(list(msg.verdicts.results))

        reader = asyncio.create_task(read())
        try:
            while True:
                get = asyncio.create_task(q.get())
                await asyncio.wait({get, reader}, return_when=asyncio.FIRST_COMPLETED)
                if not get.done():  # the app closed its side
                    get.cancel()
                    break
                yield get.result()
        finally:
            reader.cancel()
            del self.layers[name]
            for (layer, _), f in list(self.pending.items()):
                if layer == name and not f.done():
                    f.set_exception(ConnectionError("layer left"))
            asyncio.create_task(self.sync_layers())
            self.publish()


async def main():
    bridge = Bridge()
    server = grpc.aio.server()
    rpc.add_RudderServicer_to_server(bridge, server)
    server.add_insecure_port(f"127.0.0.1:{GRPC_PORT}")  # this computer only
    await server.start()
    async with websockets.serve(bridge.extension, "127.0.0.1", WS_PORT, max_size=None):  # thumbnails make judge messages large
        print(f"bridge: Firefox on ws://127.0.0.1:{WS_PORT}, apps on grpc 127.0.0.1:{GRPC_PORT}", flush=True)
        await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(main())
