// YouTube, seen before it's drawn (background page). Nothing is requested by the extension; it reads what the page
// already has or downloads:
//   - the page's own data (ytInitialData, read inside the page by youtube/page.js): the first videos (id, title,
//     channel, thumbnail address). Its HTML can come through YouTube's service worker, so it isn't read off the network.
//   - the page's youtubei/v1 responses (Firefox webRequest.filterResponseData, every byte passed on unchanged): browse
//     (home and channel pages as you scroll), next (a watch page's related list), search (more results as you scroll)
//     reel/reel_watch_sequence (the Shorts viewer's next shorts; the next one with its title) and player (each video's
//     details as the page is about to play it: how the Shorts viewer gets the rest of its titles)
//   - the page's thumbnail downloads from i.ytimg.com (same way): the image bytes, before the page decodes them
// youtube/feed.js keeps each home tile hidden until verdict() says it may be shown: after its title has been read,
// the filter (setJudge) has passed it and its thumbnail has been read. Rejected tiles are removed from the grid.
export const videos = new Map(); // id → { id, title, channel, thumbnail, order, shelf, short, seenAt, image, imageAt, ... }
let order = 0;
const now = () => Date.now();

// copy each chunk for us, pass the original straight on; parse when the response is complete
function tap(details, done) {
  const f = browser.webRequest.filterResponseData(details.requestId), parts = [];
  f.ondata = (e) => { parts.push(new Uint8Array(e.data).slice()); f.write(e.data); };
  f.onstop = () => {
    f.close();
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    try { done(all); } catch (err) { console.warn("youtube intercept:", err); }
  };
  f.onerror = () => {};
}

const text = (t) => t?.content ?? t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? null;
// the first value under `key` anywhere inside obj
function find(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const k in obj) { const r = find(obj[k], key); if (r !== undefined) return r; }
  return undefined;
}
// on a channel's own page the tiles show a view count ("9.2M views") where other tiles show the channel
const notCount = (t) => (t && /^[\d.,]+\s*[KMB]?(\s+views?)?$/i.test(t) ? null : t);
const largest = (list) => (list?.length ? list.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a)).url : null);

// Any video in YouTube's JSON, in document order (= the grid's left → right, top → bottom). Searches by shape rather
// than exact paths, since YouTube changes the nesting: lockupViewModel (current grid tiles), videoRenderer and kin
// (older layouts), shortsLockupViewModel (Shorts shelves). Ads are skipped; shelf items (Shorts, news) are marked.
function collect(node, out, shelf = false) {
  if (Array.isArray(node)) { for (const x of node) collect(x, out, shelf); return; }
  if (!node || typeof node !== "object") return;
  if (node.adSlotRenderer) return;
  if (node.richSectionRenderer) return collect(node.richSectionRenderer, out, true);
  const l = node.lockupViewModel;
  if (l?.contentId && !/CHANNEL/.test(l.contentType ?? "")) {
    // a playlist tile (a Mix) is listed under the playlist's id but links to its first video: use that video's id
    const playlist = /PLAYLIST/.test(l.contentType ?? ""), id = playlist ? find(l, "watchEndpoint")?.videoId : l.contentId;
    const m = l.metadata?.lockupMetadataViewModel;
    if (id) out.push({
      id, title: text(m?.title), shelf, mix: playlist,
      channel: notCount(text(m?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text)),
      thumbnail: largest(find(l.contentImage, "sources")),
    });
    return;
  }
  const v = node.videoRenderer ?? node.gridVideoRenderer ?? node.compactVideoRenderer;
  if (v?.videoId) {
    out.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText ?? v.shortBylineText), thumbnail: largest(v.thumbnail?.thumbnails), shelf });
    return;
  }
  const s = node.shortsLockupViewModel;
  if (s) {
    const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    const thumb = largest(s.thumbnailViewModel?.thumbnailViewModel?.image?.sources) ?? largest(s.onTap?.innertubeCommand?.reelWatchEndpoint?.thumbnail?.thumbnails);
    if (id) out.push({ id, title: text(s.overlayMetadata?.primaryText), channel: null, thumbnail: thumb, shelf: true, short: true });
    return;
  }
  // a video's player data (a player response, or the Shorts viewer's next short): title and channel
  const d = node.videoDetails;
  if (d?.videoId && d.title) {
    out.push({ id: d.videoId, title: d.title, channel: d.author ?? null, thumbnail: largest(d.thumbnail?.thumbnails), shelf: true });
    return;
  }
  for (const k in node) collect(node[k], out, shelf);
}

function learn(json, source, tabId) {
  const found = [], owner = json?.metadata?.channelMetadataRenderer?.title; // a channel page: its videos are the owner's
  collect(json, found);
  if (owner) for (const v of found) v.channel ??= owner;
  for (const v of found) {
    const old = videos.get(v.id);
    if (!old) videos.set(v.id, { ...v, order: ++order, source, seenAt: now() });
    else if (!old.title && v.title) Object.assign(old, { ...v, source, seenAt: old.seenAt ?? now() }, { image: old.image, imageType: old.imageType, imageAt: old.imageAt }); // its thumbnail came first
    else continue;
    enqueue(videos.get(v.id)); // judge ahead
  }
  if (found.length) poke(tabId);
}

// tell the tab something arrived, so it asks again for verdicts on its waiting tiles
const poke = (tabId) => { if (tabId >= 0) browser.tabs.sendMessage(tabId, { type: "yt-ready" }).catch(() => {}); };

browser.webRequest.onBeforeRequest.addListener((d) => tap(d, (bytes) => {
  learn(JSON.parse(new TextDecoder().decode(bytes)), new URL(d.url).pathname.split("/").pop(), d.tabId);
}), { urls: ["browse*", "next*", "search*", "reel/reel_watch_sequence*", "player*"].map((p) => "https://www.youtube.com/youtubei/v1/" + p) }, ["blocking"]); // any type: YouTube's service worker may make them

browser.webRequest.onBeforeRequest.addListener((d) => {
  const id = d.url.match(/\/vi(?:_webp)?\/([\w-]{11})\//)?.[1];
  if (!id) return;
  tap(d, (bytes) => {
    if (!bytes.length) return;
    const v = videos.get(id) ?? { id, order: ++order, source: "image only", seenAt: null };
    videos.set(id, v);
    if (!v.image || bytes.length > v.image.length) { // keep the largest version the page loaded
      v.image = bytes;
      v.imageType = bytes[8] === 0x57 && bytes[9] === 0x45 ? "image/webp" : "image/jpeg"; // "WEBP" at byte 8
      v.imageAt ??= now();
    }
    poke(d.tabId);
  });
}, { urls: ["https://i.ytimg.com/vi/*", "https://i.ytimg.com/vi_webp/*"], types: ["image"] }, ["blocking"]);

// The filter (background.js hands it in with setJudge) takes a batch of videos and the filter sentences to check them
// against, nearest to the screen first. The sentences are the user's (setFilters, from the popup).
// Layer 0, memory: every verdict is kept per video AND per filter sentence (in extension storage), so a video seen
// before is decided instantly, removing a filter needs no new checks, and adding one checks only that one.
// Layer 1, judging ahead: every video is queued as soon as YouTube's data arrives, before its tile exists or is near
// the screen; tiles' distance from the screen only sets the order. If the model is busy (a chat), the batch waits.
let judge = null, working = false, memKey = null, saveTimer = null, filters = [], enabled = true;
const queue = [], tabs = new Set(), memory = new Map(); // memory: id → { sentence: { blocked, verdict } }
const BATCH = 12;
const missing = (v) => filters.filter((s) => !(s in (v.verdicts ?? {})));
const decided = (v) => !missing(v).length;
const blocked = (v) => filters.some((s) => v.verdicts?.[s]?.blocked);
export async function setJudge(fn, signature) {
  judge = fn;
  if (signature && memKey !== "yt-verdicts:" + signature) {
    memKey = "yt-verdicts:" + signature;
    memory.clear();
    const all = await browser.storage.local.get(null).catch(() => ({}));
    for (const [id, f] of Object.entries(all[memKey] ?? {})) memory.set(id, f);
    browser.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("yt-verdicts:") && k !== memKey)).catch(() => {}); // older formats
    for (const v of videos.values()) v.verdicts = { ...memory.get(v.id), ...v.verdicts };
  }
  for (const v of videos.values()) enqueue(v);
  work();
}
export function setFilters(list) {
  filters = [...list];
  for (const v of videos.values()) enqueue(v);
}
export function setEnabled(on) {
  enabled = on;
  for (const v of videos.values()) enqueue(v);
}
// this session's videos: how many were checked against every filter, how many are hidden, and by which filter
export function stats() {
  const done = [...videos.values()].filter((v) => v.title && decided(v));
  return { checked: done.length, hidden: done.filter(blocked).length, by: Object.fromEntries(filters.map((s) => [s, done.filter((v) => v.verdicts[s]?.blocked).length])) };
}
function remember(v) {
  const keep = Object.fromEntries(Object.entries(v.verdicts).filter(([, x]) => !x.error).map(([s, x]) => [s, { blocked: x.blocked, verdict: x.verdict }]));
  memory.delete(v.id);
  memory.set(v.id, keep);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { // keep the newest 5000 videos
    const all = [...memory].slice(-5000);
    browser.storage.local.set({ [memKey]: Object.fromEntries(all) }).catch(() => {});
  }, 2000);
}
function enqueue(v) {
  if (!judge || !enabled || !v.title || v.queued) return;
  v.verdicts = { ...memory.get(v.id), ...v.verdicts };
  if (decided(v)) return;
  v.queued = true;
  queue.push(v);
  work();
}
// the waiting video closest to the screen (dist = screens below the bottom of the window; ≤ 0 = on screen; unknown =
// not built yet, after the rest), then YouTube's order
function next() {
  let best = 0;
  const d = (v) => v.dist ?? 9;
  for (let i = 1; i < queue.length; i++) if (d(queue[i]) < d(queue[best]) || (d(queue[i]) === d(queue[best]) && queue[i].order < queue[best].order)) best = i;
  return queue.splice(best, 1)[0];
}
async function work() {
  if (working || !judge) return;
  working = true;
  try {
    while (queue.length) {
      if (!judge || !enabled) break; // switched off meanwhile: the queue waits
      const batch = [];
      while (queue.length && batch.length < BATCH) batch.push(next());
      // videos missing the same filters are checked together
      const groups = new Map();
      for (const v of batch) {
        const m = missing(v);
        if (!m.length) { v.queued = false; continue; }
        const key = m.join("\n");
        groups.set(key, [...(groups.get(key) ?? []), v]);
      }
      for (const [key, vs] of groups) {
        const sentences = key.split("\n");
        let results;
        try {
          results = await judge(vs, sentences);
        } catch (err) {
          if (/busy/i.test(err.message)) { queue.push(...vs); await new Promise((r) => setTimeout(r, 1000)); continue; }
          // ponytail: a failed check shows the video (not remembered, so it's checked again next session); fail closed if that matters
          results = vs.map(() => ({ verdicts: Object.fromEntries(sentences.map((s) => [s, { blocked: false, error: err.message }])) }));
        }
        vs.forEach((v, k) => {
          v.queued = false;
          Object.assign(v.verdicts, results[k].verdicts);
          v.filteredAt = now();
          remember(v);
          enqueue(v); // filters added meanwhile
        });
      }
      for (const t of tabs) poke(t);
    }
  } finally {
    working = false;
  }
}

// May this tile be shown? "wait" until we've read its title, the filter has judged it and we've read its thumbnail;
// "block" if the filter rejected it. A tile whose data never came through (e.g. added while scrolling) is judged on the
// title and channel the page shows in the tile itself. If the page drew the thumbnail from its own memory (no download
// for us to read), it's allowed after 2 s, and marked so.
export function verdict({ id, imageLoaded, title, channel, dist, viewer }) {
  let v = videos.get(id);
  if (!v && title) videos.set(id, (v = { id, title, channel, order: ++order, source: "tile", seenAt: now() }));
  if (v && !v.title && title) Object.assign(v, { title, channel: v.channel ?? channel, source: "tile", seenAt: v.seenAt ?? now() });
  if (!enabled) return "show"; // filtering switched off in the popup
  if (!v?.title) return "wait";
  v.dist = dist;
  if (!decided(v)) { enqueue(v); return "wait"; }
  if (blocked(v)) return "block";
  if (!v.image && !viewer && !v.shownAt) { // the Shorts viewer plays the video itself, and a tile shown before already had its thumbnail
    if (!imageLoaded) return "wait";
    v.imageLoadedAt ??= now();
    if (now() - v.imageLoadedAt < 2000) return "wait";
    v.imageNotSeen = true;
  }
  return "show";
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "yt-data") { try { learn(JSON.parse(msg.json), msg.source, sender.tab?.id ?? -1); } catch (err) { console.warn("youtube data:", err); } }
  if (msg?.type === "yt-tiles") {
    if (sender.tab?.id >= 0) tabs.add(sender.tab.id);
    return Promise.resolve(Object.fromEntries(msg.tiles.map((t) => [t.id, verdict(t)])));
  }
  if (msg?.type === "yt-shown") for (const id of msg.ids) { const v = videos.get(id); if (v) v.shownAt ??= msg.at; }
});
