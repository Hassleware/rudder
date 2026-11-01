# A tiny Rudder app. Run it (pip install websockets), and Rudder in Firefox connects within 5 s.
# It prints Rudder's filters and adds a layer that hides any title containing a word in BLOCK.
# Swap judge() for your own logic, e.g. a local LLM. Protocol: API.md.
import asyncio, json, websockets

BLOCK = {"minecraft"}


def judge(video):
    hit = next((w for w in BLOCK if w in video["title"].lower()), None)
    return {"blocked": bool(hit), "why": f"title has {hit}" if hit else "clear"}


async def rudder(ws):
    await ws.send(json.dumps({"type": "layer", "name": "example"}))
    async for raw in ws:
        m = json.loads(raw)
        if m["type"] == "state":
            print("filters:", len(m["filters"]), "| layer:", m["layer"], "| hidden:", m["stats"]["hidden"], flush=True)
        elif m["type"] == "judge":
            await ws.send(json.dumps({"type": "verdicts", "id": m["id"], "results": [judge(v) for v in m["videos"]]}))
        elif m["type"] == "error":
            print("rudder:", m["error"], flush=True)


async def main():
    async with websockets.serve(rudder, "127.0.0.1", 47800, max_size=None):  # thumbnails make judge messages large
        print("waiting for Rudder on ws://127.0.0.1:47800", flush=True)
        await asyncio.Future()


asyncio.run(main())
