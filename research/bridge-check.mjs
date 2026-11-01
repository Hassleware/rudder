// extension/api.js ↔ bridge/bridge.py ↔ gRPC apps, end to end: a layer registers, reads the filters and judges videos;
// SetFilters reaches the extension; panels reach it and their clicks come back; GetTimings and Test answer; a layer
// leaving removes it.
// Usage: node research/bridge-check.mjs (needs: pip install -r bridge/requirements.txt)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startApi } from "../extension/api.js";
import { record, timings } from "../extension/timing.js";

const cwd = fileURLToPath(new URL("../bridge/", import.meta.url));
const py = (...args) => spawn("python", args, { cwd });
// a few lines of Python against the generated stubs
const grpcPy = (code) => py("-c", `import grpc, rudder_pb2 as pb, rudder_pb2_grpc as rpc\nr = rpc.RudderStub(grpc.insecure_channel('127.0.0.1:7833'))\n${code}`);
const line = (p, re) => new Promise((resolve) => { let out = ""; p.stdout.on("data", (d) => { out += d; if (re.test(out)) resolve(out); }); });
const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(ok()); };

const bridge = py("bridge.py");
await line(bridge, /apps on grpc/);
let filters = ["news"];
const layers = [], panels = [];
record("keywords (a video)", 2);
const api = startApi({
  state: () => ({ type: "state", enabled: true, filters, layer: layers.at(-1), stats: { checked: 3, hidden: 1, by: { news: 1 } }, recent: [] }),
  setFilters: (f) => { filters = f; api.changed(); },
  setLayer: (n) => layers.push(n),
  setPanel: (p) => panels.push(p),
  timings,
  test: async (vs) => vs.map((v) => ({ id: v.id || "test:0", hidden: /minecraft/i.test(v.title), why: "keyword", verdicts: { games: { blocked: true, verdict: "keyword: minecraft" } } })),
});

// a layer
const layer = py("example_layer.py");
assert.match(await line(layer, /filters:/), /\['news'\]/);
await until(() => layers.at(-1) === "app: example");
const rs = await api.judge([{ id: "a", title: "Minecraft speedrun", image: new Uint8Array([1, 2, 3]) }, { id: "b", title: "Baking bread" }]);
assert.deepEqual(rs.map((r) => r.blocked), [true, false]);
assert.equal(rs[0].why, "title has minecraft");

// filters
assert.match(await line(grpcPy("print('state:', list(r.SetFilters(pb.Filters(filters=['video games', 'AI'])).filters))"), /state:/), /\['video games', 'AI'\]/);
assert.deepEqual(filters, ["video games", "AI"]);

// a panel, and a click on its button coming back
const clicks = grpcPy("r.SetPanel(pb.Panel(id='p', title='Mine', blocks=[pb.Block(text='hi'), pb.Block(stats=pb.StatGrid(stats=[pb.Stat(label='n', value='3')])), pb.Block(button='Go')]))\nprint('set', flush=True)\nfor e in r.PanelEvents(pb.Empty()):\n    print('click:', e.panel, e.button, flush=True)\n    break");
await line(clicks, /set/);
await until(() => panels.at(-1)?.id === "p");
assert.deepEqual(panels.at(-1).blocks, [{ text: "hi" }, { stats: { stats: [{ label: "n", value: "3" }] } }, { button: "Go" }]);
await new Promise((r) => setTimeout(r, 300)); // PanelEvents subscribed
api.event("p", "Go");
assert.match(await line(clicks, /click:/), /click: p Go/);

// timings and tests
assert.match(await line(grpcPy("print('t:', [(t.name, t.count, t.p50_ms) for t in r.GetTimings(pb.TimingsRequest()).timings])"), /t:/), /\('keywords \(a video\)', 1, 2\.0\)/);
assert.match(await line(grpcPy("x = r.Test(pb.TestRequest(videos=[pb.Video(title='Minecraft hardcore')])).results[0]\nprint('r:', x.hidden, x.filters['games'].verdict)"), /r:/), /r: True keyword: minecraft/);

// leaving
layer.kill();
await until(() => layers.at(-1) === null);
bridge.kill();
await until(() => panels.at(-1) === null); // Firefox drops apps' panels when the bridge goes
await assert.rejects(api.judge([{ id: "c", title: "x" }]), /disconnected/);
console.log("CHECK OK");
process.exit(0);
