# A Rudder app over gRPC: prints the filters, then runs a layer that hides any title containing a word in BLOCK.
# Swap judge() for your own logic, e.g. a local LLM. Start bridge.py first.
import asyncio
import grpc
import rudder_pb2 as pb, rudder_pb2_grpc as rpc

BLOCK = {"minecraft"}


def judge(video):
    hit = next((w for w in BLOCK if w in video.title.lower()), None)
    return pb.Verdict(blocked=bool(hit), why=f"title has {hit}" if hit else "")


async def main():
    async with grpc.aio.insecure_channel("127.0.0.1:7833") as channel:
        rudder = rpc.RudderStub(channel)
        print("filters:", list((await rudder.GetState(pb.Empty())).filters), flush=True)

        out = asyncio.Queue()
        out.put_nowait(pb.LayerMessage(hello=pb.LayerHello(name="example")))

        async def outgoing():
            while True:
                yield await out.get()

        async for request in rudder.Layer(outgoing()):
            out.put_nowait(pb.LayerMessage(verdicts=pb.Verdicts(id=request.id, results=[judge(v) for v in request.videos])))


asyncio.run(main())
