// Rudder's link to apps on this computer. Firefox can't serve gRPC, so Rudder connects as a client to bridge/bridge.py
// on ws://127.0.0.1:7834 (retrying every 5 s), and the bridge serves the gRPC API (bridge/rudder.proto) to apps.
// JSON messages, Rudder → bridge: state, video (each video's record and outcome), shown (videos put on screen), stage (videos for an app's stage),
// panel-event, and answers (pipeline, timings, test-result). Bridge → Rudder: apps (the connected stage apps), get,
// set-filters, set-enabled, get-pipeline, set-pipeline, stage-result, panel, timings, test. See API.md.
const ADDRESS = "ws://127.0.0.1:7834", TIMEOUT = 30000;

export function startApi({ state, setFilters, setEnabled, getPipeline, setPipeline, appsChanged, setPanel, timings, test }) {
  let ws = null, n = 0, apps = new Set();
  const waiting = new Map(); // stage request id → { resolve, reject, timer }
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
  const setApps = (names) => {
    const next = new Set(names);
    if (next.size === apps.size && [...next].every((x) => apps.has(x))) return;
    apps = next;
    appsChanged();
  };
  const answer = (m, fn) => { try { send({ ...fn(), id: m.id }); } catch (err) { send({ type: m.type, id: m.id, error: err.message }); } };

  function connect() {
    ws = new WebSocket(ADDRESS);
    ws.onopen = () => send(state());
    ws.onclose = () => {
      ws = null;
      setApps([]);
      setPanel(null);
      for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error("bridge disconnected")); }
      waiting.clear();
      setTimeout(connect, 5000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return send({ type: "error", error: "not JSON" }); }
      if (m.type === "get") send(state());
      else if (m.type === "apps" && Array.isArray(m.names)) setApps(m.names.map(String));
      else if (m.type === "set-filters" && Array.isArray(m.filters)) setFilters(m.filters);
      else if (m.type === "set-enabled") setEnabled(!!m.enabled);
      else if (m.type === "get-pipeline") answer(m, () => ({ type: "pipeline", ...getPipeline() }));
      else if (m.type === "set-pipeline") answer(m, () => ({ type: "pipeline", ...setPipeline(Array.isArray(m.stages) ? m.stages : []) }));
      else if (m.type === "stage-result" && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        clearTimeout(w.timer);
        Array.isArray(m.results) ? w.resolve(m.results) : w.reject(new Error(m.error || "no results"));
      } else if (m.type === "panel" && m.panel?.id) setPanel(m.panel);
      else if (m.type === "timings") send({ type: "timings", id: m.id, timings: timings(!!m.reset) });
      else if (m.type === "test" && Array.isArray(m.videos)) {
        test(m.videos.map((v) => ({ ...v, image: v.thumbnail ? unb64(v.thumbnail) : null, imageType: v.thumbnail_type || null })))
          .then((results) => send({ type: "test-result", id: m.id, results }), (err) => send({ type: "test-result", id: m.id, error: err.message }));
      } else send({ type: "error", error: `unknown message: ${m.type}` });
    };
  }
  connect();

  const wire = (r) => ({ ...r, thumbnail: r.thumbnail ? b64(r.thumbnail) : null });
  return {
    has: (name) => apps.has(name),
    // filters or stats changed: tell the bridge
    changed: () => send(state()),
    // a video's record and outcome, the first time it's decided (bridge: WatchVideos)
    video: (record, outcome) => send({ type: "video", video: wire(record), outcome }),
    // videos put on screen (bridge: WatchShown)
    shown: (ids, at) => send({ type: "shown", ids, at }),
    // a button on an app's panel was clicked
    event: (panel, button) => send({ type: "panel-event", panel, button }),
    // an app stage: its app's answer for each record, in order; no answer in time = an error (the pipeline hides them)
    stage(name, config, records) {
      if (ws?.readyState !== 1) return Promise.reject(new Error("bridge disconnected"));
      const id = ++n;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("no answer in time")); }, TIMEOUT);
        waiting.set(id, { resolve, reject, timer });
        send({ type: "stage", id, name, config, videos: records.map(wire) });
      });
    },
  };
}

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
