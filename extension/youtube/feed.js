// YouTube home page and the watch page's related videos (content script). Every one stays invisible (youtube/hide.css)
// until the background page, which has read the video's title (from the page's own data) and thumbnail (from the page's
// own image download) and run the filter, says "show"; "block" takes it out. Invisible ones keep their size, so the
// layout and YouTube's lazy image loading work as normal. This script reads the page and where tiles are; it doesn't
// scroll or request anything. The video being watched and the playlist panel are never filtered.
(() => {
  // put a script into the page so it can read the page's own data (youtube/page.js), and pass what it
  // reads to the background page
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
  const since = new WeakMap();
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

  async function check() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const home = [...document.querySelectorAll(TILES)], side = [...document.querySelectorAll(SIDE)], ask = [];
      const watching = new URLSearchParams(location.search).get("v");
      for (const tile of [...home, ...side]) {
        if (tile.querySelector("ytd-ad-slot-renderer")) { tile.setAttribute("gemma-verdict", "block"); continue; } // ad
        const id = idOf(tile);
        if (!id) continue; // not filled in yet: stays hidden
        if (tile.getAttribute("gemma-id") !== id) { tile.setAttribute("gemma-id", id); tile.removeAttribute("gemma-verdict"); } // YouTube reuses tiles
        if (tile.hasAttribute("gemma-verdict")) continue;
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
          const v = verdicts?.[id];
          if (v === "block") tile.setAttribute("gemma-verdict", "block");
          if (v === "show") tile.setAttribute("gemma-verdict", "ready");
        }
      }
      reveal(home);
      reveal(side);
      settleShelves();
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(check, 50); }
    }
  }

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 50); };
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  browser.runtime.onMessage.addListener((msg) => { if (msg?.type === "yt-ready") soon(); });
  addEventListener("scroll", soon, { passive: true }); // tiles' distance from the screen decides what's filtered next
  setInterval(check, 1000); // catches thumbnails the page drew from its own memory (no download for us to see)
  soon();
})();
