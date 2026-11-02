// Captions of the videos you watch (background page), passed to apps line by line as you watch them.
// On a watch page, youtube/page.js asks YouTube's player for English captions: the player then downloads them from
// /api/timedtext itself. That download is the one request Rudder causes besides feed.js fill(), and it's YouTube's
// own. Rudder reads it like every other response (filterResponseData, passed on unchanged). Whether captions are
// drawn on the video is your choice (CC / the C key, feed.js); Rudder reads them either way.
// feed.js reports where playback is every second; each line you play through goes to apps (bridge: WatchCaptions).
// Seeking skips: lines jumped over weren't watched.

// a caption track's text → [{ start, end, text }] in ms. json3 (what the player asks for), or the XML formats.
export function parseTrack(body) {
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const out = [];
  if (body.trimStart().startsWith("{")) {
    for (const e of JSON.parse(body).events ?? []) {
      const t = clean((e.segs ?? []).map((s) => s.utf8 ?? "").join(""));
      if (t) out.push({ start: e.tStartMs ?? 0, end: (e.tStartMs ?? 0) + (e.dDurationMs ?? 0), text: t });
    }
  } else {
    const xml = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const attr = (a, name) => +(a.match(new RegExp(`\\b${name}="([\\d.]+)"`))?.[1] ?? 0);
    for (const [, tag, a, inner] of body.matchAll(/<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const t = clean(xml(inner)), p = tag === "p"; // srv3: <p t d> in ms; srv1: <text start dur> in seconds
      const start = Math.round(attr(a, p ? "t" : "start") * (p ? 1 : 1000)), length = Math.round(attr(a, p ? "d" : "dur") * (p ? 1 : 1000));
      if (t) out.push({ start, end: start + length, text: t });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// emit(lines): [{ video_id, start_ms, end_ms, text, language, auto }]
export function createCaptions(emit) {
  const tracks = new Map(); // video id → { language, auto, lines }, the newest 30
  const heads = new Map(); // tab → { id, t, from }: playing video, where it is (ms), where the lines not sent yet start

  // a caption download: kept if it's English (or translated to English); a person's captions beat automatic ones
  function track(url, body) {
    const q = new URL(url).searchParams, id = q.get("v"), language = q.get("tlang") || q.get("lang") || "";
    if (!id || !/^en\b/i.test(language)) return;
    const auto = q.get("kind") === "asr" && !q.get("tlang"), old = tracks.get(id);
    if (old && !old.auto && auto) return;
    const lines = parseTrack(body);
    if (!lines.length) return;
    tracks.delete(id);
    tracks.set(id, { language, auto, lines });
    if (tracks.size > 30) tracks.delete(tracks.keys().next().value);
  }

  // where playback is (seconds): lines from the last report up to here were watched; a jump starts over from here
  function playhead(tab, id, seconds) {
    const t = Math.round(seconds * 1000), h = heads.get(tab);
    if (!h || h.id !== id || t < h.t || t - h.t > 5000) { heads.set(tab, { id, t, from: t }); return; }
    h.t = t;
    const tr = tracks.get(id);
    if (!tr) return; // not downloaded yet: sent when it is, from h.from
    const lines = tr.lines.filter((l) => l.start >= h.from && l.start < t);
    if (!lines.length) return;
    h.from = t;
    emit(lines.map((l) => ({ video_id: id, start_ms: l.start, end_ms: l.end, text: l.text, language: tr.language, auto: tr.auto })));
  }

  return { track, playhead, closed: (tab) => heads.delete(tab), has: (id) => tracks.has(id) };
}
