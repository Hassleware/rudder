# A panel in Rudder's popup, drawn by this app: Rudder's numbers, how long each stage takes, and a button.
# Start bridge.py first, then open Rudder's popup. Panel blocks: text, stats, bars, table, button (rudder.proto).
import asyncio
import grpc
import rudder_pb2 as pb, rudder_pb2_grpc as rpc


def panel(state, timings, clicks):
    slow = sorted(timings, key=lambda t: -t.p50_ms)[:6]
    return pb.Panel(id="example", title="My app", blocks=[
        pb.Block(text=f"Layers: {', '.join(state.layers) or 'none'}"),
        pb.Block(stats=pb.StatGrid(stats=[
            pb.Stat(label="checked", value=str(state.stats.checked)),
            pb.Stat(label="hidden", value=str(state.stats.hidden)),
            pb.Stat(label="clicks", value=str(clicks)),
        ])),
        pb.Block(bars=pb.BarList(bars=[pb.Bar(label=f"{t.name} ms", value=t.p50_ms) for t in slow])),
        pb.Block(table=pb.Table(columns=["hidden", "why"], rows=[pb.Row(cells=[h.title, h.why]) for h in state.recent[:3]])),
        pb.Block(button="Reset timings"),
    ])


async def main():
    async with grpc.aio.insecure_channel("127.0.0.1:7833") as channel:
        rudder = rpc.RudderStub(channel)
        clicks = 0

        async def listen():
            nonlocal clicks
            async for e in rudder.PanelEvents(pb.Empty()):
                clicks += 1
                if e.button == "Reset timings":
                    await rudder.GetTimings(pb.TimingsRequest(reset=True))

        asyncio.create_task(listen())
        while True:  # redraw every 2 s
            try:
                state = await rudder.GetState(pb.Empty())
                timings = (await rudder.GetTimings(pb.TimingsRequest())).timings
                await rudder.SetPanel(panel(state, timings, clicks))
            except grpc.aio.AioRpcError as err:
                print("waiting for Firefox:", err.details(), flush=True)
            await asyncio.sleep(2)


asyncio.run(main())
