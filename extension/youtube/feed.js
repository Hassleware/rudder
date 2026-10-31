// YouTube's recommendations (content script): the home page, search results, channel pages, a watch page's related
// videos and the Shorts viewer. Every one stays invisible (youtube/hide.css)
// until the background page, which has read the video's title (from the page's own data) and thumbnail (from the page's
// own image download) and run the filter, says "show"; "block" takes it out. Invisible ones keep their size, so the
// layout and YouTube's lazy image loading work as normal. This script reads the page and where tiles are; it doesn't
// scroll or request anything itself. One exception, fill(): when Rudder has removed videos, it lets YouTube's own
// "load more" fetch the next page, as a scroll would. Never filtered: the video being watched, the short the Shorts viewer was opened on, the
// playlist panel.
(() => {
  // add a page script (youtube/page.js) so the page's own data can be read, and pass it to the background page
  const script = Object.assign(document.createElement("script"), { src: browser.runtime.getURL("youtube/page.js") });
  (document.head ?? document.documentElement).appendChild(script);
  script.onload = () => script.remove();
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.gemmaYT) return;
    browser.runtime.sendMessage({ type: "yt-data", source: e.data.source, json: e.data.json }).catch(() => {});
  });

  const TILES = 'ytd-browse[page-subtype="home"] ytd-rich-item-renderer';
  // the related videos beside (or under) the video being watched; not the playlist panel, never the watched video
  const SIDE = "ytd-watch-next-secondary-results-renderer :is(yt-lockup-view-model, ytd-compact-video-renderer)";
  const SEARCH = "ytd-search :is(ytd-video-renderer, grid-shelf-view-model ytm-shorts-lockup-view-model-v2)";
  const CHANNEL = 'ytd-browse[page-subtype="channels"] :is(ytd-rich-item-renderer, ytd-shelf-renderer yt-lockup-view-model, ytd-reel-shelf-renderer ytm-shorts-lockup-view-model-v2)';
  // every other feed page (Subscriptions, Trending/Explore, topic pages); not your own playlists or history
  const OTHER = 'ytd-browse:not([page-subtype="home"]):not([page-subtype="channels"]):not([page-subtype="playlist"]):not([page-subtype="history"]) :is(ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-shelf-renderer yt-lockup-view-model, ytd-reel-shelf-renderer ytm-shorts-lockup-view-model-v2)';
  const GRID = 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer';
  let busy = false, again = false;
  const text = (el) => el?.textContent.trim().replace(/\s+/g, " ") || null;
  const idOf = (tile) => {
    const href = tile.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')?.getAttribute("href") ?? "";
    return href.match(/[?&]v=([\w-]{11})/)?.[1] ?? href.match(/\/shorts\/([\w-]{11})/)?.[1];
  };

  // Tiles are revealed strictly in page order: one is shown only once every tile before it is decided, so the grid
  // fills from the top with no holes ("ready" = passed, waiting for an earlier tile). Rejected tiles leave the grid.
  // A tile that stays undecided for more than 5 s (e.g. YouTube never filled it in) stops holding the rest back: it
  // stays hidden and the ones after it may show.
  let since = new WeakMap();
  function reveal(tiles) {
    let open = true;
    const shown = [], t = Date.now();
    for (const tile of tiles) {
      const v = tile.getAttribute("gemma-verdict");
      if (v === "block") continue;
      if (v === "ready" && open) { tile.setAttribute("gemma-verdict", "show"); shown.push(tile.getAttribute("gemma-id")); continue; }
      if (v === "show" || v === "ready") continue;
      if (!since.has(tile)) since.set(tile, t);
      if (t - since.get(tile) < 5000) open = false;
    }
    if (shown.length) browser.runtime.sendMessage({ type: "yt-shown", ids: shown, at: Date.now() }).catch(() => {});
  }

  // YouTube's grid is one wrap-around list (4 per row) with shelves (Shorts, news) that start a new row. When tiles
  // before a shelf are removed, its row would end short, so each shelf is moved (CSS order) to the next row boundary.
  function settleShelves() {
    const grid = document.querySelector(GRID), list = grid?.querySelector(":scope > #contents");
    if (!list) return;
    const perRow = parseInt(getComputedStyle(grid).getPropertyValue("--ytd-rich-grid-items-per-row")) || 4;
    const kids = [...list.children], places = []; // places[k] = order of the k-th tile that takes a place in the grid
    kids.forEach((el, i) => {
      if (el.tagName === "YTD-RICH-ITEM-RENDERER") { el.style.order = i * 10; if (el.getAttribute("gemma-verdict") !== "block") places.push(i * 10); }
      else if (el.tagName !== "YTD-RICH-SECTION-RENDERER") el.style.order = 1e7; // the "load more" spinner stays last
    });
    let before = 0;
    kids.forEach((el, i) => {
      if (el.tagName === "YTD-RICH-ITEM-RENDERER") { if (el.getAttribute("gemma-verdict") !== "block") before++; return; }
      if (el.tagName !== "YTD-RICH-SECTION-RENDERER") return;
      const need = Math.ceil(before / perRow) * perRow; // first row boundary at or after this shelf's place
      el.style.order = need === before ? i * 10 : need <= places.length ? places[need - 1] + 5 : 1e7 - 1;
    });
  }

  // The Shorts viewer shows one short at a time in one reused player. Each new short stays hidden and paused until
  // it's judged (usually already done: the next ~10 come in ahead); a rejected one is skipped, in the direction the
  // user was going.
  let opened = null, lastShown = null, pausedByUs = false;
  const cameFrom = new Map(); // rejected short -> the short the user came from when it was first skipped
  const shortId = () => location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1];
  const host = () => document.querySelector("ytd-shorts");
  function gateShort() { // right away on every change: a new short is hidden before it can be seen
    const id = shortId(), h = host();
    if (!id) { opened = null; return; }
    if (!h || h.getAttribute("gemma-id") === id) return;
    opened ??= id; // the short the viewer was opened on: the user's choice
    h.setAttribute("gemma-id", id);
    h.setAttribute("gemma-verdict", id === opened ? "show" : "wait");
  }
  function pauseIfHidden() {
    const h = host(), video = h?.querySelector("video");
    if (video && shortId() && h.getAttribute("gemma-verdict") !== "show" && !video.paused) { video.pause(); pausedByUs = true; }
  }
  document.addEventListener("play", pauseIfHidden, true);
  async function shorts() {
    gateShort();
    const id = shortId(), h = host();
    if (!id || !h) return;
    if (h.getAttribute("gemma-verdict") === "show") { lastShown = id; return; }
    const v = (await browser.runtime.sendMessage({ type: "yt-tiles", tiles: [{ id, viewer: true, dist: 0 }] }))?.[id];
    if (shortId() !== id) return;
    if (v === "show") {
      h.setAttribute("gemma-verdict", "show");
      lastShown = id;
      browser.runtime.sendMessage({ type: "yt-shown", ids: [id], at: Date.now() }).catch(() => {});
      if (pausedByUs) { pausedByUs = false; h.querySelector("video")?.play().catch(() => {}); }
    } else if (v === "block") {
      if (!cameFrom.has(id)) cameFrom.set(id, lastShown);
      const up = cameFrom.get(id) !== lastShown; // back here from below: keep going up
      h.querySelector(`#navigation-button-${up ? "up" : "down"} button`)?.click();
    } else pauseIfHidden();
  }

  // Autoplay: when a video ends, YouTube counts down to the next one. It may only start if that video has passed;
  // otherwise the countdown is cancelled with YouTube's own Cancel button (the countdown stays hidden until decided).
  async function autoplay() {
    const over = document.querySelector(".ytp-autonav-endscreen-countdown-overlay");
    if (!over || over.offsetParent === null || getComputedStyle(over).display === "none") return;
    const href = over.querySelector("a.ytp-autonav-endscreen-link-container, a[href*='/watch?v=']")?.getAttribute("href") ?? "";
    const id = href.match(/[?&]v=([\w-]{11})/)?.[1];
    if (over.getAttribute("gemma-id") === id && over.getAttribute("gemma-verdict") === "show") return;
    over.setAttribute("gemma-id", id ?? "");
    const v = id ? (await browser.runtime.sendMessage({ type: "yt-tiles", tiles: [{ id, viewer: true, dist: 0, title: over.querySelector(".ytp-autonav-endscreen-video-info-title, .ytp-autonav-endscreen-upnext-title")?.textContent.trim() }] }))?.[id] : null;
    if (v === "show") { over.setAttribute("gemma-verdict", "show"); return; }
    over.querySelector(".ytp-autonav-endscreen-upnext-cancel-button, button[aria-label*='Cancel' i]")?.click(); // strict: not passed (yet) → no autoplay
  }

  // Your own algorithm: 👍 / 👎 in each video's ⋮ menu (both of YouTube's menu styles). The menu belongs to the tile
  // whose ⋮ was clicked last; Rudder's two items are copies of YouTube's own items (same look), with their own action.
  const ALL = [TILES, SEARCH, CHANNEL, OTHER, SIDE].join(", ");
  let menuFor = null; // { id, title, channel, tile, at }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("button");
    const label = (btn?.getAttribute("aria-label") ?? "").toLowerCase();
    const tile = btn?.closest(ALL);
    if (!tile || !(label.includes("action menu") || label.includes("more actions"))) return;
    menuFor = { id: idOf(tile), tile, at: Date.now(),
      title: text(tile.querySelector("#video-title, .yt-lockup-metadata-view-model__title, h3")),
      channel: text(tile.querySelector('a[href^="/@"]:not(#avatar-link), ytd-channel-name a, .yt-content-metadata-view-model__metadata-text')) };
    for (const ms of [30, 120, 300, 600, 1000, 1600]) setTimeout(addMenuItems, ms); // the menu is built a moment after the click
  }, true);
  const ICON = {
    up: "M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z",
    down: "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z",
  };
  const svg = (d) => {
    const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "24"); s.setAttribute("height", "24"); s.setAttribute("fill", "currentColor"); s.style.display = "block";
    p.setAttribute("d", d); s.append(p);
    return s;
  };
  function toast(message) {
    const t = Object.assign(document.createElement("div"), { textContent: message });
    Object.assign(t.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: 99999, background: "#14191f", color: "#e8eef4", border: "1px solid #5bb8f0", borderRadius: "8px", padding: "10px 16px", font: "14px/1.4 Roboto, system-ui, sans-serif", boxShadow: "0 4px 16px #0006", transition: "opacity .3s" });
    document.body.append(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 2600);
  }
  function addMenuItems() {
    if (!menuFor || Date.now() - menuFor.at > 4000 || !menuFor.id) return;
    const drop = [...document.querySelectorAll("tp-yt-iron-dropdown")].find((d) => d.getAttribute("aria-hidden") !== "true" && getComputedStyle(d).display !== "none" && d.getBoundingClientRect().height > 0);
    const list = drop?.querySelector("yt-list-view-model, ytd-menu-popup-renderer #items");
    const sample = list?.querySelector("yt-list-item-view-model:not([rudder-item]), ytd-menu-service-item-renderer:not([rudder-item])");
    if (!sample || list.querySelector(`[rudder-item][rudder-for="${menuFor.id}"]`)) return;
    for (const old of list.querySelectorAll("[rudder-item]")) old.remove(); // the menu is reused for the next video
    const target = menuFor;
    for (const [like, label] of [[true, "Rudder: more like this"], [false, "Rudder: less like this"]]) {
      const item = sample.cloneNode(true);
      item.setAttribute("rudder-item", ""); item.setAttribute("rudder-for", target.id);
      item.removeAttribute("has-separator");
      // the label in a plain element with the same look (the older menu's own text element resets itself)
      const title = item.querySelector(".ytListItemViewModelTitle, yt-formatted-string.title");
      if (title) { const span = Object.assign(document.createElement("span"), { className: title.className, textContent: label }); title.replaceWith(span); }
      const icon = item.querySelector("svg")?.parentElement;
      if (icon) icon.replaceChildren(svg(like ? ICON.up : ICON.down));
      const act = (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.type !== "click") return;
        drop.close?.();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        if (!like) { target.tile.setAttribute("gemma-verdict", "block"); settleShelves(); }
        toast(like ? "Rudder will keep videos like this" : "Rudder will show you less like this");
        browser.runtime.sendMessage({ type: "rudder-feedback", id: target.id, like, title: target.title, channel: target.channel }).catch(() => {});
      };
      for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "tap"]) item.addEventListener(type, act, true);
      list.insertBefore(item, list.firstElementChild);
    }
  }

  // Fill the feed: once Rudder has removed videos from the home grid or the sidebar, YouTube's own "load more" spot
  // (what a scroll would reach) is briefly pinned on screen, invisible, so YouTube fetches its next page itself: the
  // same request a scroll sends. Stops when the spot is 2 screens below the window, or after 4 pages per visit.
  const MORE = [GRID, "ytd-watch-next-secondary-results-renderer"];
  let pages = { href: null, n: 0 };
  function fill() {
    if (pages.href !== location.href) pages = { href: location.href, n: 0 };
    for (const box of MORE) {
      const list = document.querySelector(box), spot = list?.querySelector("ytd-continuation-item-renderer");
      if (!spot || spot.hasAttribute("rudder-more") || pages.n >= 4 || !list.querySelector('[gemma-verdict="block"]')) continue;
      const top = spot.getBoundingClientRect().top;
      if (top < innerHeight || top > 3 * innerHeight) continue; // on screen: YouTube loads it anyway; far: enough
      pages.n++;
      spot.setAttribute("rudder-more", "");
      const was = spot.style.cssText;
      spot.style.cssText = was + ";position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
      // YouTube asks for the page as soon as it sees the spot; put it back (YouTube may reuse it for the next page)
      setTimeout(() => { spot.style.cssText = was; spot.removeAttribute("rudder-more"); }, 1500);
    }
  }

  async function check(recheck = false) {
    if (busy) { again = true; return; }
    busy = true;
    try {
      addMenuItems();
      const lists = [TILES, SEARCH, CHANNEL, OTHER, SIDE].map((s) => [...document.querySelectorAll(s)]), ask = [];
      const watching = new URLSearchParams(location.search).get("v");
      for (const tile of lists.flat()) {
        if (tile.querySelector("ytd-ad-slot-renderer")) { tile.setAttribute("gemma-verdict", "block"); continue; } // ad
        const id = idOf(tile);
        if (!id) continue; // not filled in yet: stays hidden
        if (tile.getAttribute("gemma-id") !== id) { tile.setAttribute("gemma-id", id); tile.removeAttribute("gemma-verdict"); } // YouTube reuses tiles
        if (tile.hasAttribute("gemma-verdict") && !(recheck && id !== watching)) continue;
        if (id === watching) { tile.setAttribute("gemma-verdict", "ready"); continue; } // the video being watched: never filtered
        const img = tile.querySelector("img"), r = tile.getBoundingClientRect();
        ask.push({
          tile, id, imageLoaded: !!(img?.complete && img.naturalWidth),
          dist: (r.top - innerHeight) / innerHeight, // screens below the window (≤ 0: on screen); the nearest go first
          // what the tile itself shows, for videos whose data didn't come through (only used then)
          title: text(tile.querySelector("#video-title, .yt-lockup-metadata-view-model__title, h3")),
          channel: text(tile.querySelector('a[href^="/@"]:not(#avatar-link), ytd-channel-name a, .yt-content-metadata-view-model__metadata-text')),
        });
      }
      if (ask.length) {
        const verdicts = await browser.runtime.sendMessage({ type: "yt-tiles", tiles: ask.map(({ tile, ...t }) => t) });
        for (const { tile, id } of ask) {
          const v = verdicts?.[id], was = tile.getAttribute("gemma-verdict");
          if (v === "block") tile.setAttribute("gemma-verdict", "block");
          if (v === "show" && was !== "show") tile.setAttribute("gemma-verdict", "ready"); // a re-check never re-hides a shown tile
        }
      }
      lists.forEach(reveal);
      settleShelves();
      fill();
      await autoplay();
      await shorts();
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(check, 50); }
    }
  }

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 50); };
  new MutationObserver(() => { gateShort(); pauseIfHidden(); addMenuItems(); soon(); }).observe(document.documentElement, { childList: true, subtree: true });
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "yt-ready") soon();
    if (msg?.type === "yt-recheck") check(true); // you taught Rudder something: re-decide every tile on the page
    if (msg?.type === "yt-reset") { // the filters changed: every video is decided again (hidden until then)
      for (const el of document.querySelectorAll("[gemma-verdict]")) el.removeAttribute("gemma-verdict");
      host()?.removeAttribute("gemma-id");
      since = new WeakMap();
      check();
    }
  });
  addEventListener("scroll", soon, { passive: true }); // tiles' distance from the screen decides what's filtered next
  setInterval(check, 1000); // catches thumbnails the page drew from its own memory (no download for us to see)
  soon();
})();
