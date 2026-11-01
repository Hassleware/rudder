// extension/api.js against examples/rudder-app.py: the app registers a layer, judges videos, and leaving drops the layer.
// Usage: node research/api-check.mjs (needs python with websockets)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { startApi } from "../extension/api.js";

const app = spawn("python", [new URL("../examples/rudder-app.py", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
await new Promise((r) => app.stdout.once("data", r)); // "waiting for Rudder"

const layers = [];
const api = startApi({ state: () => ({ type: "state", filters: ["news"], layer: layers.at(-1), stats: { hidden: 0 } }), setFilters: () => {}, setLayer: (n) => layers.push(n) });
for (let i = 0; i < 50 && layers.at(-1) !== "app: example"; i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(layers.at(-1), "app: example");

const rs = await api.judge([{ id: "a", title: "Minecraft speedrun", image: new Uint8Array([1, 2, 3]) }, { id: "b", title: "Baking bread" }]);
assert.deepEqual(rs.map((r) => r.blocked), [true, false]);

app.kill();
for (let i = 0; i < 50 && layers.at(-1) !== null; i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(layers.at(-1), null);
await assert.rejects(api.judge([{ id: "c", title: "x" }]), /disconnected/);
console.log("CHECK OK");
process.exit(0);
