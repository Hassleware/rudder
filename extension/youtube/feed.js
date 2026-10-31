// YouTube's recommendations (content script): the home page, search results, channel pages, a watch page's related
// videos and the Shorts viewer. Every one stays invisible (youtube/hide.css)
// until the background page, which has read the video's title (from the page's own data) and thumbnail (from the page's
// own image download) and run the filter, says "show"; "block" takes it out. Invisible ones keep their size, so the
// layout and YouTube's lazy image loading work as normal. This script reads the page and where tiles are; it doesn't
// scroll or request anything itself. One exception, fill(): when Rudder has removed videos, it lets YouTube's own
// "load more" fetch the next page, as a scroll would. Shorts rows are refilled from shorts the page already has. Never filtered: the video being watched, the short the Shorts viewer was opened on, the
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
  // the Shorts viewer: one slot per short in the swipe sequence, each showing its thumbnail until the player moves in
  const SLOTS = "ytd-shorts .reel-video-in-sequence-new";
  const slotId = (slot) => slot.querySelector(".reel-video-in-sequence-thumbnail")?.style.backgroundImage.match(/\/vi\/([\w-]{11})/)?.[1];
  const idOf = (tile) => {
    if (tile.matches(SLOTS)) return slotId(tile);
    const href = tile.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')?.getAttribute("href") ?? "";
    return href.match(/[?&]v=([\w-]{11})/)?.[1] ?? href.match(/\/shorts\/([\w-]{11})/)?.[1];
  };

  // Tiles are revealed strictly in page order: one is shown only once every tile before it is decided, so the grid
  // fills from the top with no holes ("ready" = passed, waiting for an earlier tile). Rejected tiles leave the grid.
  // Nothing already on screen ever moves. A tile YouTube never filled in stops holding the rest back after 5 s (it
  // stays hidden); one still being checked holds them for up to 60 s. Shorts viewer slots (free) don't wait on each other.
  let since = new WeakMap();
  function reveal(tiles, free) {
    let open = true;
    const shown = [], t = Date.now();
    for (const tile of tiles) {
      const v = tile.getAttribute("gemma-verdict");
      if (v === "block") continue;
      if (v === "ready" && open) { tile.setAttribute("gemma-verdict", "show"); shown.push(tile.getAttribute("gemma-id")); continue; }
      if (v === "show" || v === "ready") continue;
      if (!since.has(tile)) since.set(tile, t);
      if (!free && t - since.get(tile) < (tile.hasAttribute("gemma-id") ? 60000 : 5000)) open = false;
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
    const item = (el) => el.tagName === "YTD-RICH-ITEM-RENDERER", inPlace = (el) => el.getAttribute("gemma-verdict") !== "block";
    kids.forEach((el, i) => {
      if (item(el)) { el.style.order = i * 10; if (inPlace(el)) places.push(i * 10); }
      else if (el.tagName !== "YTD-RICH-SECTION-RENDERER") el.style.order = 1e7; // the "load more" spinner stays last
    });
    let before = 0;
    kids.forEach((el, i) => {
      if (item(el)) { if (inPlace(el)) before++; return; }
      if (el.tagName !== "YTD-RICH-SECTION-RENDERER") return;
      const need = Math.ceil(before / perRow) * perRow; // first row boundary at or after this shelf's place
      el.style.order = need === before ? i * 10 : need <= places.length ? places[need - 1] + 5 : 1e7 - 1;
    });
    fillShorts();
  }

  // Shorts rows: each draws 6 of the 9 shorts YouTube sent; its "Show more" draws the rest from the page's own data (no
  // request). Once Rudder removes one, the row is expanded; once a row's shorts are all decided, shown shorts from later
  // rows move up to fill it, and a row still not full is hidden. One row each.
  function fillShorts() {
    const shelves = [...document.querySelectorAll(`${GRID} ytd-rich-shelf-renderer[is-shorts]`)];
    const v = (el) => el.getAttribute("gemma-verdict"), items = (sh) => [...sh.querySelectorAll("ytd-rich-item-renderer")];
    shelves.forEach((shelf, i) => {
      if (!shelf.hasAttribute("rudder-expanded") && items(shelf).some((el) => v(el) === "block")) {
        const more = [...shelf.querySelectorAll("button")].find((b) => /show more/i.test(b.getAttribute("aria-label") || b.textContent));
        if (more) { shelf.setAttribute("rudder-expanded", ""); more.click(); }
      }
      const perRow = +shelf.getAttribute("elements-per-row") || 6, into = shelf.querySelector("#contents");
      const isDecided = () => items(shelf).every((el) => v(el) === "show" || v(el) === "block");
      let need = perRow - items(shelf).filter((el) => v(el) === "show").length;
      if (isDecided()) { // appended after its own shown shorts: no gap
        for (const donor of shelves.slice(i + 1)) {
          for (const el of items(donor)) if (need > 0 && into && v(el) === "show") { into.append(el); need--; }
        }
      }
      const mine = items(shelf), decided = isDecided();
      mine.filter((el) => v(el) !== "block").forEach((el, k) => el.toggleAttribute("rudder-over", shelf.hasAttribute("rudder-expanded") && k >= perRow));
      shelf.closest("ytd-rich-section-renderer")?.toggleAttribute("rudder-short", decided && mine.filter((el) => v(el) === "show").length < perRow);
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
      skip(h, id, up);
    } else pauseIfHidden();
  }
  // Skip a rejected short: jump straight to the nearest short that way not already known to be rejected, instantly (no
  // animation for anything to slide past in, no landing on known-bad ones); YouTube's own button if none is loaded yet.
  let skippedAt = 0;
  function skip(h, id, up) {
    if (Date.now() - skippedAt < 600) return; // one skip at a time
    skippedAt = Date.now();
    const slots = [...h.querySelectorAll(".reel-video-in-sequence-new")], step = up ? -1 : 1;
    const at = slots.findIndex((x) => x.getAttribute("gemma-id") === id);
    for (let k = at + step; at >= 0 && k >= 0 && slots[k]; k += step) {
      if (slots[k].getAttribute("gemma-verdict") === "block") continue;
      if (slots[k].getAttribute("gemma-id")) { slots[k].scrollIntoView({ block: "start", behavior: "instant" }); return; }
      break;
    }
    h.querySelector(`#navigation-button-${up ? "up" : "down"} button`)?.click();
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

  // Your own algorithm: 👍 / 👎 in each video's ⋮ menu (both of YouTube's menu styles), including the ⋮ under the video
  // you're watching and on a short. The menu belongs to the video whose ⋮ was clicked last; Rudder's two items are
  // copies of YouTube's own items (same look), with their own action.
  const ALL = [TILES, SEARCH, CHANNEL, OTHER, SIDE].join(", ");
  let menuFor = null; // { id, title, channel, tile, at }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("button");
    const label = (btn?.getAttribute("aria-label") ?? "").toLowerCase();
    const tile = btn?.closest(ALL), playing = !tile && btn?.closest("ytd-watch-metadata, ytd-shorts");
    if (!(tile || playing) || !(label.includes("action menu") || label.includes("more actions"))) return;
    if (tile) menuFor = { id: idOf(tile), tile, at: Date.now(),
      title: text(tile.querySelector("#video-title, .yt-lockup-metadata-view-model__title, h3")),
      channel: text(tile.querySelector('a[href^="/@"]:not(#avatar-link), ytd-channel-name a, .yt-content-metadata-view-model__metadata-text')) };
    else { // the video you're watching, or the short on screen (its title and channel are in Rudder's data already)
      const short = playing.tagName === "YTD-SHORTS";
      menuFor = { id: short ? shortId() : new URLSearchParams(location.search).get("v"), tile: null, short, at: Date.now(),
        title: short ? null : text(playing.querySelector("h1")), channel: short ? null : text(playing.querySelector("ytd-channel-name a")) };
    }
    for (const ms of [30, 120, 300, 600, 1000, 1600]) setTimeout(addMenuItems, ms); // the menu is built a moment after the click
  }, true);
  // the rudder from Rudder's icon: blue, tiller up = more like this; red, upside down = less like this
  const svg = (like) => {
    const ns = "http://www.w3.org/2000/svg", el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const s = el("svg", { viewBox: "-13 0 124 124", width: "24", height: "24", fill: like ? "#5BB8F0" : "#E5484D" }), g = el("g", like ? {} : { transform: "rotate(180 49 62)" });
    g.append(el("rect", { x: 14, y: 0, width: 8, height: 14, rx: 1 }), el("rect", { x: 8, y: 12, width: 22, height: 8, rx: 2 }),
      el("path", { "fill-rule": "evenodd", d: "M10 22 H30 C52 22 72 16 84 6 Q90 2 90 10 C90 52 76 96 48 118 Q42 124 34 124 H10 Z M29 40 H37 C49 40 59 37 67 33 C66 60 57 85 37 102 H29 Z" }));
    s.append(g);
    s.style.display = "block";
    return s;
  };
  function toast(message) {
    const t = Object.assign(document.createElement("div"), { textContent: message });
    Object.assign(t.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: 99999, background: "#f2ede1", color: "#111", border: "2px solid #111", borderRadius: "0", padding: "8px 14px", font: "700 13px/1.4 ui-monospace, 'SF Mono', Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: ".06em", transition: "opacity .3s" });
    document.body.append(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 2600);
  }
  // On the video or short you're watching, YouTube's own like / dislike buttons wear Rudder's rudders and teach Rudder
  // too: one click likes it on YouTube and tells Rudder. Clicking again to undo only undoes it on YouTube.
  function decorateThumbs() { // only a label on the button: youtube/hide.css draws the rudder in YouTube's own icon box
    for (const scope of document.querySelectorAll("ytd-watch-metadata, ytd-shorts")) {
      for (const kind of ["like", "dislike"]) {
        for (const btn of scope.querySelectorAll(`${kind}-button-view-model button, #${kind}-button button`)) if (btn.getAttribute("rudder-thumb") !== kind) btn.setAttribute("rudder-thumb", kind);
      }
    }
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("button[rudder-thumb]");
    if (!btn || btn.getAttribute("aria-pressed") === "true") return; // undoing a like / dislike: YouTube only
    const like = btn.getAttribute("rudder-thumb") === "like", short = !!btn.closest("ytd-shorts");
    const id = short ? shortId() : new URLSearchParams(location.search).get("v"), meta = btn.closest("ytd-watch-metadata");
    if (!id) return;
    toast(like ? "More like this" : "Less like this");
    browser.runtime.sendMessage({ type: "rudder-feedback", id, like, title: meta ? text(meta.querySelector("h1")) : null, channel: meta ? text(meta.querySelector("ytd-channel-name a")) : null }).catch(() => {});
    if (!like && short) setTimeout(() => { const h = host(); if (h && shortId() === id) { h.setAttribute("gemma-verdict", "block"); skip(h, id, false); } }, 300); // after YouTube has taken the dislike
  }, true);
  function addMenuItems() {
    if (!menuFor || Date.now() - menuFor.at > 4000 || !menuFor.id) return;
    const drop = [...document.querySelectorAll("tp-yt-iron-dropdown")].find((d) => d.getAttribute("aria-hidden") !== "true" && getComputedStyle(d).display !== "none" && d.getBoundingClientRect().height > 0);
    const list = drop?.querySelector("yt-list-view-model, ytd-menu-popup-renderer #items");
    const sample = list?.querySelector("yt-list-item-view-model:not([rudder-item]), ytd-menu-service-item-renderer:not([rudder-item])");
    if (!sample || list.querySelector(`[rudder-item][rudder-for="${menuFor.id}"]`)) return;
    for (const old of list.querySelectorAll("[rudder-item]")) old.remove(); // the menu is reused for the next video
    const target = menuFor, top = list.firstElementChild; // both go above YouTube's items, in order
    for (const [like, label] of [[true, "Rudder: more like this"], [false, "Rudder: less like this"]]) {
      const item = sample.cloneNode(true);
      item.setAttribute("rudder-item", ""); item.setAttribute("rudder-for", target.id);
      item.removeAttribute("has-separator");
      // the label in a plain element with the same look (the older menu's own text element resets itself)
      const title = item.querySelector(".ytListItemViewModelTitle, yt-formatted-string.title");
      if (title) { const span = Object.assign(document.createElement("span"), { className: title.className, textContent: label }); title.replaceWith(span); }
      const icon = item.querySelector("svg")?.parentElement;
      if (icon) icon.replaceChildren(svg(like));
      const act = (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.type !== "click") return;
        drop.close?.();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        if (!like && target.tile) { target.tile.setAttribute("gemma-verdict", "block"); settleShelves(); }
        if (!like && target.short && host() && shortId() === target.id) { host().setAttribute("gemma-verdict", "block"); skip(host(), target.id, false); } // a short you 👎: on to the next
        toast(like ? "More like this" : "Less like this");
        browser.runtime.sendMessage({ type: "rudder-feedback", id: target.id, like, title: target.title, channel: target.channel }).catch(() => {});
      };
      for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "tap"]) item.addEventListener(type, act, true);
      list.insertBefore(item, top);
    }
  }

  // Fill the feed: while the home grid has fewer than 8 rows (32 videos) shown or still being checked, or the sidebar
  // fewer than 20, YouTube's own "load more" spot (what a scroll would reach) is briefly pinned on screen, invisible,
  // so YouTube fetches its next page itself: the same request a scroll sends. At most 4 pages per visit, 4 s apart.
  const MORE = [[GRID, ":scope > #contents > ytd-rich-item-renderer", 32], ["ytd-watch-next-secondary-results-renderer", "yt-lockup-view-model, ytd-compact-video-renderer", 20]];
  let pages = { href: null, n: 0, at: 0 };
  function fill() {
    if (pages.href !== location.href) pages = { href: location.href, n: 0, at: 0 };
    for (const [box, tiles, want] of MORE) {
      const list = document.querySelector(box), spot = list?.querySelector("ytd-continuation-item-renderer");
      if (!spot || spot.hasAttribute("rudder-more") || pages.n >= 4 || Date.now() - pages.at < 4000) continue;
      const v = (el) => el.getAttribute("gemma-verdict");
      const kept = [...list.querySelectorAll(tiles)].filter((el) => v(el) !== "block").length;
      if (kept >= want) continue;
      pages.n++; pages.at = Date.now();
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
      const lists = [TILES, SEARCH, CHANNEL, OTHER, SIDE, SLOTS].map((s) => [...document.querySelectorAll(s)]), ask = [];
      const watching = new URLSearchParams(location.search).get("v");
      for (const tile of lists.flat()) {
        if (tile.querySelector("ytd-ad-slot-renderer")) { tile.setAttribute("gemma-verdict", "block"); continue; } // ad
        const id = idOf(tile);
        if (!id) continue; // not filled in yet: stays hidden
        if (tile.getAttribute("gemma-id") !== id) { tile.setAttribute("gemma-id", id); tile.removeAttribute("gemma-verdict"); } // YouTube reuses tiles
        if (tile.hasAttribute("gemma-verdict") && !(recheck && id !== watching)) continue;
        if (id === watching || (id === opened && tile.matches(SLOTS))) { tile.setAttribute("gemma-verdict", "ready"); continue; } // the video being watched, or the short the viewer was opened on: never filtered
        const img = tile.querySelector("img"), r = tile.getBoundingClientRect();
        ask.push({
          tile, id, imageLoaded: !!(img?.complete && img.naturalWidth), viewer: tile.matches(SLOTS) || undefined,
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
      lists.forEach((l, k) => reveal(l, k === lists.length - 1)); // the last list: Shorts viewer slots
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
  // a Shorts slot whose short changed is hidden again at once, before the next frame (fail closed)
  const regateSlots = () => {
    for (const slot of document.querySelectorAll(SLOTS)) {
      const id = slotId(slot);
      if (slot.getAttribute("gemma-id") !== (id ?? "")) { slot.setAttribute("gemma-id", id ?? ""); slot.removeAttribute("gemma-verdict"); }
    }
  };
  new MutationObserver(() => { gateShort(); regateSlots(); pauseIfHidden(); addMenuItems(); decorateThumbs(); soon(); }).observe(document.documentElement, { childList: true, subtree: true });
  new MutationObserver((records) => {
    if (records.some((r) => r.target.classList?.contains("reel-video-in-sequence-thumbnail"))) { regateSlots(); soon(); }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style"] });
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
