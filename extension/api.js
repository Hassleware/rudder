// Rudder's link to apps on this computer. Firefox can't serve gRPC, so Rudder connects as a client to bridge/bridge.py
// on ws://127.0.0.1:7834 (retrying every 5 s), and the bridge serves the gRPC API (bridge/rudder.proto) to apps.
// JSON messages: Rudder sends state, judge, panel-event and the answers to timings and test; the bridge sends get,
// set-filters, layer, verdicts, panel, timings and test. See API.md.
const ADDRESS = "ws://127.0.0.1:7834", TIMEOUT = 30000;
export const APP = "app: "; // a layer shows up in Rudder's filter list as "app: <name>"

export function startApi({ state, setFilters, setLayer, setPanel, timings, test }) {
  let ws = null, n = 0;
  const waiting = new Map(); // judge request id → { resolve, reject, timer }
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
  const drop = (err) => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(err); } waiting.clear(); };

  function connect() {
    ws = new WebSocket(ADDRESS);
    ws.onopen = () => send(state());
    ws.onclose = () => { ws = null; setLayer(null); setPanel(null); drop(new Error("app disconnected")); setTimeout(connect, 5000); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return send({ type: "error", error: "not JSON" }); }
      if (m.type === "get") send(state());
      else if (m.type === "set-filters" && Array.isArray(m.filters)) setFilters(m.filters);
      else if (m.type === "layer") setLayer(typeof m.name === "string" && m.name.trim() ? APP + m.name.trim().slice(0, 60) : null);
      else if (m.type === "verdicts" && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        clearTimeout(w.timer);
        Array.isArray(m.results) ? w.resolve(m.results) : w.reject(new Error("app sent no results"));
      } else if (m.type === "panel" && m.panel?.id) setPanel(m.panel);
      else if (m.type === "timings") send({ type: "timings", id: m.id, timings: timings(!!m.reset) });
      else if (m.type === "test" && Array.isArray(m.videos)) {
        test(m.videos.map((v) => ({ ...v, image: v.image ? unb64(v.image) : null })))
          .then((results) => send({ type: "test-result", id: m.id, results }), (err) => send({ type: "test-result", id: m.id, error: err.message }));
      } else send({ type: "error", error: `unknown message: ${m.type}` });
    };
  }
  connect();

  return {
    // filters changed: tell the app
    changed: () => send(state()),
    // a button on an app's panel was clicked
    event: (panel, button) => send({ type: "panel-event", panel, button }),
    // the app's verdict on each video, in order: [{ blocked, why }]; no answer in time or a bad answer = hidden (strict)
    judge(videos) {
      if (ws?.readyState !== 1) return Promise.reject(new Error("app disconnected"));
      const id = ++n;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("app took too long")); }, TIMEOUT);
        waiting.set(id, { resolve, reject, timer });
        send({ type: "judge", id, videos: videos.map((v) => ({ id: v.id, title: v.title, channel: v.channel ?? "", image: v.image ? b64(v.image) : null, imageType: v.imageType ?? null })) });
      }).then((rs) => {
        if (rs.length !== videos.length) throw new Error(`app sent ${rs.length} results for ${videos.length} videos`);
        return rs;
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
