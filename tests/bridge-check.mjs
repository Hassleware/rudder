// extension/api.js ↔ bridge/bridge.py ↔ gRPC apps, end to end: an app stage puts itself into the pipeline and judges
// videos; a wrong pipeline is refused; video records (with thumbnails) reach GetVideos, shown videos WatchShown, caption lines WatchCaptions; SetFilters, SetEnabled, panels and their
// clicks, GetTimings and Test go through; an app leaving is noticed, and so is the bridge going.
// Usage: node tests/bridge-check.mjs (needs: pip install -r bridge/requirements.txt)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startApi } from "../extension/api.js";
import { record, timings } from "../extension/timing.js";

const cwd = fileURLToPath(new URL("../bridge/", import.meta.url));
const py = (...args) => spawn("python", args, { cwd });
// a few lines of Python against the generated stubs
const grpcPy = (code) => py("-c", `import grpc, rudder_pb2 as pb, rudder_pb2_grpc as rpc\nr = rpc.RudderStub(grpc.insecure_channel('127.0.0.1:7833'))\n${code}`);
const line = (p, re) => new Promise((resolve) => { let out = ""; const on = (d) => { out += d; if (re.test(out)) resolve(out); }; p.stdout.on("data", on); p.stderr.on("data", on); });
const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(ok()); };

const bridge = py("bridge.py");
await line(bridge, /apps on grpc/);
let filters = ["news"], enabled = true, stages = [{ id: "your-clicks", kind: "your-clicks", config: {} }, { id: "keywords", kind: "keywords", config: {} }, { id: "learned", kind: "learned", config: {} }];
const KINDS = ["your-clicks", "keywords", "learned", "thumbnail-text", "app"], panels = [];
let appsChanges = 0;
record("keywords (a video)", 2);
const api = startApi({
  state: () => ({ type: "state", enabled, filters, stages: stages.map((s) => s.id), stats: { checked: 3, hidden: 1, by: { news: 1 }, byStage: { keywords: 1 } }, recent: [] }),
  setFilters: (f) => { filters = f; api.changed(); },
  setEnabled: (on) => { enabled = on; api.changed(); },
  getPipeline: () => ({ stages, kinds: KINDS }),
  setPipeline: (list) => {
    for (const s of list) if (!KINDS.includes(s.kind)) throw new Error(`unknown stage kind "${s.kind}"`);
    stages = list.map((s) => ({ id: s.id || s.kind, kind: s.kind, config: s.config ?? {} }));
    return { stages, kinds: KINDS };
  },
  appsChanged: () => appsChanges++,
  setPanel: (p) => panels.push(p),
  timings,
  test: async (vs) => vs.map((v, i) => ({ id: v.id || `test:${i}`, hidden: /minecraft/i.test(v.title), decided_by: "keywords", why: "video games (keyword: minecraft)", fields: { thumbnail_text: "" }, trace: [{ stage: "your-clicks", decision: "pass", why: "" }, { stage: "keywords", decision: "hide", why: "video games (keyword: minecraft)" }] })),
});

// a minimal stage client, only for this check: it puts itself after "keywords", then hides titles with "minecraft"
const app = grpcPy(`import queue
from google.protobuf.json_format import MessageToDict
p = r.GetPipeline(pb.Empty())
stages = list(p.stages)
mine = pb.Stage(id='example', kind='app'); mine.config.update({'name': 'example'})
stages.insert([s.id for s in stages].index('keywords') + 1, mine)
print('pipeline:', [s.id for s in r.SetPipeline(pb.Pipeline(stages=stages)).stages], flush=True)
out = queue.Queue(); out.put(pb.StageMessage(hello=pb.StageHello(name='example')))
for req in r.Stage(iter(out.get, None)):
    res = [pb.StageResult(decision=pb.HIDE if 'minecraft' in v.title.lower() else pb.PASS, why='title has minecraft' if 'minecraft' in v.title.lower() else '', fields={'title_words': str(len(v.title.split()))}) for v in req.videos]
    out.put(pb.StageMessage(reply=pb.StageReply(id=req.id, results=res)))`);
assert.match(await line(app, /pipeline:/), /\['your-clicks', 'keywords', 'example', 'learned'\]/);
assert.deepEqual(stages[2], { id: "example", kind: "app", config: { name: "example" } });
await until(() => api.has("example"));
const rec = (id, title) => ({ id, title, channel: "", description: "", published: "", duration_seconds: 0, seen_at_ms: 1, thumbnail: new Uint8Array([1, 2, 3]), thumbnail_type: "image/jpeg", thumbnail_url: "", source: "browse", short: false, fields: { thumbnail_text: "x" } });
const rs = await api.stage("example", { name: "example" }, [rec("a", "Minecraft speedrun"), rec("b", "Baking bread")]);
assert.deepEqual(rs.map((r) => r.decision), ["hide", "pass"]);
assert.equal(rs[0].why, "title has minecraft");
assert.equal(rs[1].fields.title_words, "2");
await assert.rejects(api.stage("nobody", { name: "nobody" }, [rec("c", "x")]), /isn't connected/);

// a wrong pipeline is refused, and nothing changes
assert.match(await line(grpcPy("try:\n    r.SetPipeline(pb.Pipeline(stages=[pb.Stage(kind='nope')]))\nexcept grpc.RpcError as e:\n    print('refused:', e.code().name, e.details())"), /refused:/), /INVALID_ARGUMENT unknown stage kind "nope"/);
assert.equal(stages.length, 4);

// video records, with thumbnails, reach GetVideos
api.video(rec("dQw4w9WgXcQ", "Bread at home"), { hidden: false, decided_by: "", why: "" });
api.video(rec("zzzzzzzzzzz", "Minecraft"), { hidden: true, decided_by: "example", why: "title has minecraft" });
await new Promise((r) => setTimeout(r, 300));
assert.match(await line(grpcPy("e = r.GetVideos(pb.VideosRequest(limit=2, thumbnails=True)).events\nprint('v:', [(x.video.id, x.outcome.hidden, x.outcome.decided_by, len(x.video.thumbnail), x.video.fields['thumbnail_text']) for x in e])"), /v:/),
  /\[\('zzzzzzzzzzz', True, 'example', 3, 'x'\), \('dQw4w9WgXcQ', False, '', 3, 'x'\)\]/);

// videos put on screen reach WatchShown
const shownApp = grpcPy("print('watching', flush=True)\nfor e in r.WatchShown(pb.Empty()):\n    print('shown:', list(e.ids), e.at_ms, flush=True)\n    break");
await line(shownApp, /watching/);
await new Promise((r) => setTimeout(r, 300)); // WatchShown subscribed
api.shown(["dQw4w9WgXcQ"], 1700000000000);
assert.match(await line(shownApp, /shown:/), /shown: \['dQw4w9WgXcQ'\] 1700000000000/);

// caption lines reach WatchCaptions
const capApp = grpcPy("print('watching', flush=True)\nfor c in r.WatchCaptions(pb.Empty()):\n    print('caption:', c.video_id, c.start_ms, c.text, c.auto, flush=True)\n    break");
await line(capApp, /watching/);
await new Promise((r) => setTimeout(r, 300));
api.captions([{ video_id: "dQw4w9WgXcQ", start_ms: 1500, end_ms: 3000, text: "never gonna give you up", language: "en", auto: true }]);
assert.match(await line(capApp, /caption:/), /caption: dQw4w9WgXcQ 1500 never gonna give you up True/);

// filters
assert.match(await line(grpcPy("print('state:', list(r.SetFilters(pb.Filters(filters=['video games', 'AI'])).filters))"), /state:/), /\['video games', 'AI'\]/);
assert.deepEqual(filters, ["video games", "AI"]);
assert.match(await line(grpcPy("print('enabled:', r.SetEnabled(pb.Enabled(enabled=False)).enabled)"), /enabled:/), /enabled: False/);
assert.equal(enabled, false);

// a panel, and a click on its button coming back
const clicks = grpcPy("r.SetPanel(pb.Panel(id='p', title='Mine', blocks=[pb.Block(text='hi'), pb.Block(button='Go')]))\nprint('set', flush=True)\nfor e in r.PanelEvents(pb.Empty()):\n    print('click:', e.panel, e.button, flush=True)\n    break");
await line(clicks, /set/);
await until(() => panels.at(-1)?.id === "p");
await new Promise((r) => setTimeout(r, 300)); // PanelEvents subscribed
api.event("p", "Go");
assert.match(await line(clicks, /click:/), /click: p Go/);

// timings and tests
assert.match(await line(grpcPy("print('t:', [(t.name, t.count, t.p50_ms) for t in r.GetTimings(pb.TimingsRequest()).timings])"), /t:/), /\('keywords \(a video\)', 1, 2\.0\)/);
assert.match(await line(grpcPy("x = r.Test(pb.TestRequest(videos=[pb.Video(title='Minecraft hardcore')])).results[0]\nprint('r:', x.outcome.hidden, x.outcome.decided_by, [t.stage + ':' + t.decision for t in x.trace])"), /r:/), /r: True keywords \['your-clicks:pass', 'keywords:hide'\]/);

// leaving
app.kill();
await until(() => !api.has("example"));
bridge.kill();
await until(() => panels.at(-1) === null); // Firefox drops apps' panels when the bridge goes
await assert.rejects(api.stage("example", {}, [rec("d", "x")]), /disconnected/);
console.log("CHECK OK");
process.exit(0);
