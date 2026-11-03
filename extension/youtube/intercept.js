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
// the pipeline (pipeline.js) has passed it and its thumbnail has been read. Rejected tiles are removed from the grid.
import { createClicks } from "./personal.js";
import { record, timed } from "../timing.js";
import { decide, settle, onSettled, pending } from "../pipeline.js";
// your 👍 / 👎 (youtube/personal.js)
export const clicks = createClicks();
clicks.load();
export const videos = new Map(); // id → { id, title, channel, thumbnail, order, shelf, short, seenAt, image, imageAt, ... }
let order = 0;
const now = () => Date.now();

// copy each chunk for us, pass the original straight on; parse when the response is complete
export function tap(details, done) {
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
// "12:34" / "1:02:03" → seconds (a live stream's "LIVE" → null)
const seconds = (t) => (/^\d+(:\d\d){1,2}$/.test(t ?? "") ? t.split(":").reduce((a, x) => a * 60 + +x, 0) : null);
// a grid tile's metadata lines ("Channel", "1.2M views", "3 days ago"); the publish time is the one that reads like one
const rowTexts = (m) => (m?.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap((r) => (r.metadataParts ?? []).map((p) => text(p.text)));
const when = (texts) => texts.find((t) => /\bago\b|streamed|premiere|scheduled/i.test(t ?? "")) ?? null;

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
      published: when(rowTexts(m)), duration: seconds(find(l.contentImage, "thumbnailBadgeViewModel")?.text),
    });
    return;
  }
  const v = node.videoRenderer ?? node.gridVideoRenderer ?? node.compactVideoRenderer;
  if (v?.videoId) {
    out.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText ?? v.shortBylineText), thumbnail: largest(v.thumbnail?.thumbnails), shelf,
      published: text(v.publishedTimeText), duration: seconds(text(v.lengthText)),
      description: text(v.descriptionSnippet) ?? text(v.detailedMetadataSnippets?.[0]?.snippetText) });
    return;
  }
  const s = node.shortsLockupViewModel;
  if (s) {
    const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    const thumb = largest(s.thumbnailViewModel?.thumbnailViewModel?.image?.sources) ?? largest(s.onTap?.innertubeCommand?.reelWatchEndpoint?.thumbnail?.thumbnails);
    if (id) out.push({ id, title: text(s.overlayMetadata?.primaryText), channel: null, thumbnail: thumb, shelf: true, short: true });
    return;
  }
  // a video's player data (a player response, or the Shorts viewer's next short): title, channel, the full description,
  // its length and its publish date
  const d = node.videoDetails;
  if (d?.videoId && d.title) {
    out.push({ id: d.videoId, title: d.title, channel: d.author ?? null, thumbnail: largest(d.thumbnail?.thumbnails), shelf: true,
      description: d.shortDescription || null, duration: +d.lengthSeconds || null, published: find(node.microformat, "publishDate") ?? null });
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
    // the kind of page, when the data says (judging ahead, before a tile asks: see verdict)
    const page = source === "search" ? "search" : owner ? "channel" : null;
    if (page) v.fields = { ...v.fields, page };
    if (!old) videos.set(v.id, { ...v, order: ++order, source, seenAt: now() });
    else if (!old.title && v.title) Object.assign(old, { ...v, source, seenAt: old.seenAt ?? now() }, { image: old.image, imageType: old.imageType, imageAt: old.imageAt }); // its thumbnail came first
    else { // seen before: fill in what's new (a watch page brings the description, its length and an exact date)
      for (const k of ["description", "published", "duration", "channel"]) if (v[k] != null && (old[k] == null || (k === "published" && /ago/.test(old[k])))) old[k] = v[k];
      if (page) (old.fields ??= {}).page = page;
      // YouTube sending it again (a new page, a refresh) is a new sighting: app stages with "remember": false are asked
      // again. Within 10 s it's the same page sending it twice.
      if (now() - (old.sightedAt ?? 0) < 10000) continue;
      old.sightedAt = now();
    }
    enqueue(videos.get(v.id)); // judge ahead
  }
  if (found.length) poke(tabId);
}

// tell the tab something arrived, so it asks again for verdicts on its waiting tiles
const poke = (tabId) => { if (tabId >= 0) browser.tabs.sendMessage(tabId, { type: "yt-ready" }).catch(() => {}); };

browser.webRequest.onBeforeRequest.addListener((d) => tap(d, (bytes) => {
  learn(JSON.parse(new TextDecoder().decode(bytes)), new URL(d.url).pathname.split("/").pop(), d.tabId);
}), { urls: ["browse*", "next*", "search*", "reel/reel_watch_sequence*", "player*"].map((p) => "https://www.youtube.com/youtubei/v1/" + p) }, ["blocking"]); // any type: YouTube's service worker may make them

// a thumbnail size YouTube doesn't have (e.g. maxresdefault for an old upload) comes back as an error with a small grey
// placeholder picture: every such video would be judged on the same grey image, so those are skipped
const badImage = new Set();
browser.webRequest.onHeadersReceived.addListener((d) => { if (d.statusCode >= 400) badImage.add(d.requestId); },
  { urls: ["https://i.ytimg.com/vi/*", "https://i.ytimg.com/vi_webp/*"], types: ["image"] });
browser.webRequest.onBeforeRequest.addListener((d) => {
  const id = d.url.match(/\/vi(?:_webp)?\/([\w-]{11})\//)?.[1];
  if (!id) return;
  tap(d, (bytes) => {
    if (badImage.delete(d.requestId) || !bytes.length) return;
    const v = videos.get(id) ?? { id, order: ++order, source: "image only", seenAt: null };
    videos.set(id, v);
    if (!v.image || bytes.length > v.image.length) { // keep the largest version the page loaded
      v.image = bytes;
      v.imageType = bytes[8] === 0x57 && bytes[9] === 0x45 ? "image/webp" : "image/jpeg"; // "WEBP" at byte 8
      v.imageAt ??= now();
      enqueue(v); // title (if known) and thumbnail are both in: judge it
    }
    poke(d.tabId);
  });
}, { urls: ["https://i.ytimg.com/vi/*", "https://i.ytimg.com/vi_webp/*"], types: ["image"] }, ["blocking"]);

// Deciding: every video goes through the pipeline (pipeline.js; its stages are set in background.js and by apps).
// What the slow stages learn about a video (its thumbnail's text, apps' answers) is kept per video in
// extension storage, so a video seen before is decided at once. Every video is decided as soon as YouTube's data
// arrives, before its tile exists; tiles' distance from the screen only sets the order.
const MEM = "rudder-memory-v1";
let enabled = true, saveTimer = null, sink = null, shownSink = null, feedbackSink = null;
const tabs = new Set(), memory = new Map(); // memory: id → { ocr, app }
browser.storage.local.get(null).then((all) => {
  for (const [id, m] of Object.entries(all[MEM] ?? {})) memory.set(id, m);
  for (const v of videos.values()) v.recalled = false;
  browser.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("yt-verdicts:"))).catch(() => {}); // before the pipeline
}).catch(() => {});
function recall(v) {
  v.recalled = true;
  const m = memory.get(v.id);
  if (!m) return;
  if (v.ocr === undefined && m.ocr !== undefined) v.ocr = m.ocr;
  v.app = { ...m.app, ...v.app };
}
function remember(v) {
  memory.delete(v.id);
  memory.set(v.id, { ocr: v.ocr, app: v.app });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => browser.storage.local.set({ [MEM]: Object.fromEntries([...memory].slice(-5000)) }).catch(() => {}), 2000); // the newest 5000
}
onSettled((vs) => {
  for (const v of vs) { remember(v); outcome(v); }
  for (const t of tabs) poke(t);
});
// background.js: each video's record and outcome, the first time it's decided (bridge: WatchVideos)
export const setSink = (fn) => { sink = fn; };
// background.js: videos put on screen (bridge: WatchShown)
export const setShownSink = (fn) => { shownSink = fn; };
// background.js: your 👍 / 👎, with the video's record (bridge: WatchFeedback)
export const setFeedbackSink = (fn) => { feedbackSink = fn; };

// the pipeline's answer for a video (queueing the stage it waits on)
function outcome(v, wait = true) {
  if (!v.recalled) recall(v);
  const d = decide(v, { wait });
  if (d.state !== "wait" && !v.decidedAt) {
    v.decidedAt = now();
    if (v.seenAt) record("video: data to verdict", v.decidedAt - v.seenAt);
    sink?.(v, d);
  }
  return d;
}
const enqueue = (v) => { if (enabled && v.title) outcome(v); };

export function setEnabled(on) {
  enabled = on;
  for (const v of videos.values()) enqueue(v);
}
// the pipeline changed: every video is decided again
export function redecide() {
  for (const v of videos.values()) { v.failed = undefined; enqueue(v); }
}

// Rudder's data contract: what apps get for every video (bridge: rudder.proto's Video). Empty when YouTube didn't say.
export const recordOf = (v) => ({
  id: v.id, title: v.title ?? "", channel: v.channel ?? "", description: v.description ?? "", published: v.published ?? "",
  duration_seconds: v.duration ?? 0, seen_at_ms: v.seenAt ?? 0, thumbnail: v.image ?? null, thumbnail_type: v.imageType ?? "",
  thumbnail_url: v.thumbnail ?? "", source: v.source ?? "", short: !!v.short,
  fields: Object.fromEntries(Object.entries(v.fields ?? {}).map(([k, x]) => [k, String(x)])),
});

// this session's videos: how many are decided, how many hidden, and by which filter and which stage
export function stats() {
  const ds = [...videos.values()].filter((v) => v.title).map((v) => outcome(v, false)).filter((d) => d.state !== "wait");
  const hidden = ds.filter((d) => d.state === "hide");
  const count = (key) => hidden.reduce((o, d) => { if (d[key]) o[d[key]] = (o[d[key]] ?? 0) + 1; return o; }, {});
  return { learning: clicks.stats(), checked: ds.length, waiting: pending(), hidden: hidden.length, by: count("filter"), byStage: count("stage") };
}
// the newest hidden videos and why (popup: "Recently hidden")
export function recentHidden(n = 25) {
  return [...videos.values()].filter((v) => v.title && v.decidedAt).map((v) => [v, outcome(v, false)]).filter(([, d]) => d.state === "hide")
    .sort(([a], [b]) => b.decidedAt - a.decidedAt).slice(0, n).map(([v, d]) => ({ id: v.id, title: v.title, channel: v.channel ?? "", why: d.why, stage: d.stage }));
}

// May this tile be shown? "wait" until we've read its title and the pipeline has decided (and, to be shown, its
// thumbnail has been read); "block" if the pipeline hid it. A tile whose data never came through (e.g. added while
// scrolling) is judged on the title and channel the page shows in the tile itself. If the page drew the thumbnail from
// its own memory (no download for us to read), it's allowed after 2 s, and marked so.
export function verdict({ id, imageLoaded, title, channel, dist, viewer, view, page }) {
  let v = videos.get(id);
  if (!v && title) videos.set(id, (v = { id, title, channel, order: ++order, source: "tile", seenAt: now() }));
  if (v && !v.title && title) Object.assign(v, { title, channel: v.channel ?? channel, source: "tile", seenAt: v.seenAt ?? now() });
  if (!enabled) return "show"; // filtering switched off in the popup
  if (!v?.title) return "wait";
  // a new page view (feed.js): a new sighting, so an answer from an earlier page can't show it here. The record says
  // what kind of page it's on (fields.page: home, search, channel, watch, shorts, other)
  if (view && v.view !== view) {
    if (v.view !== undefined) v.sightedAt = now(); // its first view keeps the answer judged ahead: it hasn't been shown yet
    v.view = view;
    if (page) (v.fields ??= {}).page = page;
  }
  v.dist = dist;
  // no thumbnail download to read: the Shorts viewer (it plays the video itself), or the page drew the thumbnail from
  // its own memory (allowed 2 s after it appeared): judged on the title alone
  // …or its thumbnail never arrives (3 s on or near the screen without one)
  if (!v.image && !v.noImage && dist <= 1) v.waitImageSince ??= now();
  if (!v.image && !v.noImage && (viewer || (imageLoaded && now() - (v.imageLoadedAt ??= now()) >= 2000) || now() - (v.waitImageSince ?? now()) >= 3000)) v.noImage = true;
  const d = outcome(v);
  if (d.state === "hide") return "block";
  if (d.state === "wait") return "wait";
  if (!v.image && !v.noImage && !v.shownAt) return "wait";
  return "show";
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "yt-data") { try { learn(JSON.parse(msg.json), msg.source, sender.tab?.id ?? -1); } catch (err) { console.warn("youtube data:", err); } }
  if (msg?.type === "yt-tiles") {
    if (sender.tab?.id >= 0) tabs.add(sender.tab.id);
    return Promise.resolve(Object.fromEntries(msg.tiles.map((t) => [t.id, verdict(t)])));
  }
  if (msg?.type === "yt-shown") shownSink?.(msg.ids, msg.at);
  if (msg?.type === "yt-shown") for (const id of msg.ids) { const v = videos.get(id); if (v) { if (!v.shownAt && v.seenAt) record("video: data to shown", msg.at - v.seenAt); v.shownAt ??= msg.at; } }
  if (msg?.type === "rudder-feedback") return feedback(msg);
});

// A 👍 / 👎 from a video's ⋮ menu or YouTube's like buttons: kept, passed to apps (Hull learns from it), then every
// open YouTube tab re-checks what it shows, so a disliked video (or channel) goes at once.
export const feedback = (msg) => timed("feedback (a click)", () => learn1(msg));
async function learn1({ id, like, title, channel }) {
  let v = videos.get(id);
  if (!v) videos.set(id, (v = { id, title, channel, order: ++order, source: "feedback", seenAt: now() }));
  v.title ??= title; v.channel ??= channel;
  await clicks.feedback(v, like); // counts at once
  feedbackSink?.(v, like);
  recheckTabs();
  return { ok: true, stats: clicks.stats() };
}
// Videos through the whole pipeline without showing, counting or remembering them (bridge: Test). For your own tests:
// [{ id?, title, channel?, description?, published?, duration_seconds?, image?, fields? }]
//   → [{ id, hidden, decided_by, why, fields, trace: [{ stage, decision, why }] }]
export async function test(list) {
  return timed("test (a batch)", () => Promise.all(list.map(async (x, i) => {
    const v = { id: x.id || `test:${i}`, title: x.title ?? "", channel: x.channel ?? "", description: x.description ?? "", published: x.published ?? "",
      duration: x.duration_seconds ?? 0, image: x.image ?? null, imageType: x.imageType ?? null, noImage: !x.image, fields: { ...x.fields },
      source: "test", short: !!x.short, seenAt: now(), order: 0 };
    const d = await settle(v);
    return { id: v.id, hidden: d.state === "hide", decided_by: d.stage ?? "", why: d.why, fields: recordOf(v).fields, trace: d.trace };
  })));
}
export function forget() { clicks.forget(); recheckTabs(); }
export const recheckTabs = () => { for (const t of tabs) browser.tabs.sendMessage(t, { type: "yt-recheck" }).catch(() => {}); };
