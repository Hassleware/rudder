// YouTube, seen before it's drawn (background page). Nothing is requested by the extension; it reads what the page
// already has or downloads:
//   - the page's own data (ytInitialData, read inside the page by youtube/page.js): the first videos (id, title,
//     channel, thumbnail address). Its HTML can come through YouTube's service worker, so it isn't read off the network.
//   - the page's youtubei/v1/browse responses (Firefox webRequest.filterResponseData, every byte passed on unchanged):
//     the videos YouTube adds as you scroll
//   - the page's thumbnail downloads from i.ytimg.com (same way): the image bytes, before the page decodes them
// youtube/feed.js keeps each home tile hidden until verdict() says it may be shown. For now the verdict only waits until
// the extension has seen the video's title and its thumbnail; the filter plugs in here later.
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
      channel: text(m?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text),
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
  for (const k in node) collect(node[k], out, shelf);
}

function learn(json, source, tabId) {
  const found = [];
  collect(json, found);
  for (const v of found) {
    if (!videos.has(v.id)) videos.set(v.id, { ...v, order: ++order, source, seenAt: now() });
  }
  if (found.length) poke(tabId);
}

// tell the tab something arrived, so it asks again for verdicts on its waiting tiles
const poke = (tabId) => { if (tabId >= 0) browser.tabs.sendMessage(tabId, { type: "yt-ready" }).catch(() => {}); };

browser.webRequest.onBeforeRequest.addListener((d) => tap(d, (bytes) => {
  learn(JSON.parse(new TextDecoder().decode(bytes)), "browse", d.tabId);
}), { urls: ["https://www.youtube.com/youtubei/v1/browse*"] }, ["blocking"]); // any type: YouTube's service worker may make it

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

// May this tile be shown? Not until we've seen its title and its thumbnail. If the page showed the thumbnail from its
// own memory (no download for us to read), it's allowed after 2 s, and marked so.
export function verdict(id, imageLoaded) {
  const v = videos.get(id);
  if (!v?.title) return "wait";
  if (!v.image) {
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
    return Promise.resolve(Object.fromEntries(msg.tiles.map(({ id, imageLoaded }) => [id, verdict(id, imageLoaded)])));
  }
  if (msg?.type === "yt-shown") for (const id of msg.ids) { const v = videos.get(id); if (v) v.shownAt ??= msg.at; }
});
