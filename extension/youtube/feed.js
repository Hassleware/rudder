// YouTube home page (content script). Every home tile stays invisible (youtube/hide.css) until the background page,
// which has read the video's title (from the page's own data) and thumbnail (from the page's own image download), says
// it may be shown. Invisible tiles keep their size, so the layout and YouTube's lazy image loading work as normal. This script
// only reads link attributes; it doesn't scroll, measure or request anything.
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

  const PENDING = 'ytd-browse[page-subtype="home"] ytd-rich-item-renderer:not([gemma-verdict="show"])';
  let busy = false, again = false;

  async function check() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const tiles = [];
      for (const tile of document.querySelectorAll(PENDING)) {
        const href = tile.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')?.getAttribute("href") ?? "";
        const id = href.match(/[?&]v=([\w-]{11})/)?.[1] ?? href.match(/\/shorts\/([\w-]{11})/)?.[1];
        if (!id) continue; // ads and anything that isn't a video stay hidden
        const img = tile.querySelector("img");
        tiles.push({ tile, id, imageLoaded: !!(img?.complete && img.naturalWidth) });
      }
      if (!tiles.length) return;
      const verdicts = await browser.runtime.sendMessage({ type: "yt-tiles", tiles: tiles.map(({ id, imageLoaded }) => ({ id, imageLoaded })) });
      const shown = [];
      for (const { tile, id } of tiles) if (verdicts?.[id] === "show") { tile.setAttribute("gemma-verdict", "show"); shown.push(id); }
      if (shown.length) browser.runtime.sendMessage({ type: "yt-shown", ids: shown, at: Date.now() }).catch(() => {});
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(check, 50); }
    }
  }

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 50); };
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  browser.runtime.onMessage.addListener((msg) => { if (msg?.type === "yt-ready") soon(); });
  setInterval(check, 1000); // catches thumbnails the page drew from its own memory (no download for us to see)
  soon();
})();
