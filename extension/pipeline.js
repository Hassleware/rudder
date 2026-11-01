// Rudder's filtering pipeline: an ordered list of stages, each of a kind. background.js defines the built-in kinds;
// apps run "app" stages over the bridge, and can replace the whole list (bridge: SetPipeline).
// A video goes through the stages in order. Each stage says hide, show or pass, and may add fields to the video's
// record for the stages after it. The first hide or show decides; a video every stage passes is shown. A stage that
// fails hides the video for this session (strict).
// A kind: { check(video, config) → { decision, why, filter?, fields? } now, or null when it must run its batch first;
//           batch?(videos, config) async: the slow part (OCR, a model, an app), after which check can answer;
//           needsImage?: wait for the thumbnail; validate?(config): throw if the config is wrong }
import { timed } from "./timing.js";

const kinds = new Map(), queue = [];
let stages = [], working = false, settled = () => {};
const BATCH = 12;
export const PASS = Object.freeze({ decision: "pass" });

export const defineKind = (name, kind) => { kinds.set(name, kind); };
export const kindNames = () => [...kinds.keys()];
export const getPipeline = () => stages.map(({ id, kind, config }) => ({ id, kind, config: structuredClone(config) }));
export const pending = () => queue.length + (working ? 1 : 0);
// called with each batch's videos once their stage has run (intercept.js: remember them, tell the tabs)
export const onSettled = (fn) => { settled = fn; };

// [{ id?, kind, config? }] → the pipeline. Throws, changing nothing, if a kind is unknown, an id repeats or a config is wrong.
export function setPipeline(list) {
  const out = [], ids = new Set();
  for (const s of list) {
    const kind = String(s?.kind ?? ""), id = String(s?.id || kind), config = s?.config && typeof s.config === "object" ? structuredClone(s.config) : {};
    if (!kinds.has(kind)) throw new Error(`unknown stage kind "${kind}" (kinds: ${kindNames().join(", ")})`);
    if (ids.has(id)) throw new Error(`two stages with the id "${id}"`);
    kinds.get(kind).validate?.(config);
    ids.add(id);
    out.push({ id, kind, config });
  }
  stages = out;
  queue.length = 0; // work for the old pipeline
}

const imageWait = (k, v) => k.needsImage && !v.image && !v.noImage;

// One video through the pipeline → { state: "hide" | "show" | "wait", stage, why, filter }. With wait, a stage that has
// to run first is queued. trace (an array) collects what every stage said, for tests.
export function decide(v, { wait = true, trace } = {}) {
  for (const s of stages) {
    const k = kinds.get(s.kind);
    const r = v.failed?.[s.id] ? { decision: "hide", why: `${s.id} failed: ${v.failed[s.id]}` } : imageWait(k, v) ? null : k.check(v, s.config);
    if (r === null) {
      if (wait && !imageWait(k, v)) want(v, s);
      trace?.push({ stage: s.id, decision: "wait", why: imageWait(k, v) ? "waiting for the thumbnail" : "" });
      return { state: "wait", stage: s.id, why: "" };
    }
    if (r.fields) Object.assign((v.fields ??= {}), r.fields);
    trace?.push({ stage: s.id, decision: r.decision ?? "pass", why: r.why ?? "" });
    if (r.decision === "hide" || r.decision === "show") return { state: r.decision, stage: s.id, why: r.why ?? "", filter: r.filter };
  }
  return { state: "show", stage: null, why: "" };
}

function want(v, s) {
  if ((v.wanted ??= new Set()).has(s)) return;
  v.wanted.add(s);
  queue.push({ v, s });
  work();
}

// a stage's batch; a failure (or a batch that still leaves check without an answer) hides those videos (strict)
async function run(s, vs) {
  const k = kinds.get(s.kind);
  try {
    await timed(`${s.id} (a batch)`, () => k.batch(vs, s.config));
  } catch (err) {
    console.warn(`rudder: stage ${s.id} failed, hiding:`, err);
    for (const v of vs) (v.failed ??= {})[s.id] = err?.message || String(err);
  }
  for (const v of vs) if (!v.failed?.[s.id] && k.check(v, s.config) === null) (v.failed ??= {})[s.id] = "gave no answer";
}

// the waiting video nearest the screen (dist: screens below the window; unknown = not built yet), then YouTube's order
function nearest() {
  const d = (x) => x.v.dist ?? 9;
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (d(queue[i]) < d(queue[best]) || (d(queue[i]) === d(queue[best]) && queue[i].v.order < queue[best].v.order)) best = i;
  return queue.splice(best, 1)[0];
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      // thumbnails arrive one by one; a short wait lets a few gather, since a batch costs far less per video
      if (queue.length < BATCH) await new Promise((r) => setTimeout(r, 150));
      if (!queue.length) break;
      const { v, s } = nearest(), batch = [v];
      for (let i = queue.length - 1; i >= 0 && batch.length < BATCH; i--) if (queue[i].s === s) batch.push(queue.splice(i, 1)[0].v);
      for (const x of batch) x.wanted.delete(s);
      if (!stages.includes(s)) continue; // the pipeline changed meanwhile
      await run(s, batch);
      settled(batch);
    }
  } finally {
    working = false;
  }
}

// one video all the way through, running each stage it waits on right away (tests: nothing is queued or remembered)
export async function settle(v) {
  for (let i = 0; i <= stages.length; i++) {
    const trace = [], d = decide(v, { wait: false, trace });
    if (d.state !== "wait") return { ...d, trace };
    const s = stages.find((x) => x.id === d.stage);
    if (imageWait(kinds.get(s.kind), v)) v.noImage = true;
    else await run(s, [v]);
  }
  throw new Error("pipeline didn't settle");
}

