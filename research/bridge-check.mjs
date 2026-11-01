// extension/api.js ↔ bridge/bridge.py ↔ bridge/example_layer.py, end to end: the layer registers, reads the filters,
// judges videos; SetFilters reaches the extension; the layer leaving removes it.
// Usage: node research/bridge-check.mjs (needs: pip install -r bridge/requirements.txt)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startApi } from "../extension/api.js";

const cwd = fileURLToPath(new URL("../bridge/", import.meta.url));
const py = (...args) => spawn("python", args, { cwd });
const line = (p, re) => new Promise((resolve) => { let out = ""; p.stdout.on("data", (d) => { out += d; if (re.test(out)) resolve(out); }); });
const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(ok()); };

const bridge = py("bridge.py");
await line(bridge, /apps on grpc/);
let filters = ["news"];
const layers = [];
const api = startApi({
  state: () => ({ type: "state", enabled: true, filters, layer: layers.at(-1), stats: { checked: 3, hidden: 1, by: { news: 1 } }, recent: [] }),
  setFilters: (f) => { filters = f; api.changed(); },
  setLayer: (n) => layers.push(n),
});

const layer = py("example_layer.py");
assert.match(await line(layer, /filters:/), /\['news'\]/);
await until(() => layers.at(-1) === "app: example");

const rs = await api.judge([{ id: "a", title: "Minecraft speedrun", image: new Uint8Array([1, 2, 3]) }, { id: "b", title: "Baking bread" }]);
assert.deepEqual(rs.map((r) => r.blocked), [true, false]);
assert.equal(rs[0].why, "title has minecraft");

const set = py("-c", "import rudder_pb2 as pb, rudder_pb2_grpc as rpc, grpc; s = rpc.RudderStub(grpc.insecure_channel('127.0.0.1:47801')).SetFilters(pb.Filters(filters=['video games', 'AI'])); print('state:', list(s.filters))");
assert.match(await line(set, /state:/), /\['video games', 'AI'\]/);
assert.deepEqual(filters, ["video games", "AI"]);

layer.kill();
await until(() => layers.at(-1) === null);
bridge.kill();
await assert.rejects(new Promise((r) => setTimeout(r, 300)).then(() => api.judge([{ id: "c", title: "x" }])), /disconnected/);
console.log("CHECK OK");
process.exit(0);
