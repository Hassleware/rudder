// Rudder's desktop API: apps on this computer can read and change the filters, and add their own filtering layer
// (e.g. a local LLM). Rudder is the client: it connects to ws://127.0.0.1:47800 whenever an app is listening there and
// retries every 5 s otherwise. Messages are JSON; see API.md.
// ponytail: one app at a time; an app that wants several layers runs them behind its own one connection.
const ADDRESS = "ws://127.0.0.1:47800", TIMEOUT = 30000;
export const APP = "app: "; // a layer shows up in Rudder's filter list as "app: <name>"

export function startApi({ state, setFilters, setLayer }) {
  let ws = null, n = 0;
  const waiting = new Map(); // judge request id → { resolve, reject, timer }
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
  const drop = (err) => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(err); } waiting.clear(); };

  function connect() {
    ws = new WebSocket(ADDRESS);
    ws.onopen = () => send(state());
    ws.onclose = () => { ws = null; setLayer(null); drop(new Error("app disconnected")); setTimeout(connect, 5000); };
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
      } else send({ type: "error", error: `unknown message: ${m.type}` });
    };
  }
  connect();

  return {
    // filters changed: tell the app
    changed: () => send(state()),
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

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
