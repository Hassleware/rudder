// A page script: runs in the YouTube page itself (added by the content script youtube/feed.js), so it
// can read the page's own data. YouTube's HTML sets window.ytInitialData (every video on the first screen) before the
// app draws the grid; in-site navigation hands the app new data in the yt-navigate-finish event. Both are passed to
// the content script with postMessage. It reads, with one exception: on a watch page it asks YouTube's player for
// English captions, which the player then downloads itself, for Rudder to read (youtube/captions.js).
(() => {
  const send = (data, source) => { if (data) window.postMessage({ rudderYT: true, source, json: JSON.stringify(data) }, location.origin); };
  let sent = null;
  const poll = setInterval(() => {
    if (window.ytInitialData && window.ytInitialData !== sent) { sent = window.ytInitialData; send(sent, "page"); clearInterval(poll); }
  }, 20);
  setTimeout(() => clearInterval(poll), 30000);
  window.addEventListener("yt-navigate-finish", (e) => send(e.detail?.response?.response ?? e.detail?.response, "navigation"));

  // English captions on every watched video: a person's English captions, else automatic English ones, else another
  // language translated to English. Drawn on screen only if you chose to (feed.js, hide.css).
  let asked = null, trying = null, tries = 0;
  setInterval(() => {
    const p = document.getElementById("movie_player");
    const id = location.pathname === "/watch" && p?.getVideoData?.()?.video_id;
    if (!id || id === asked) return;
    if (id !== trying) { trying = id; tries = 0; }
    if (++tries > 15) { asked = id; return; } // no captions at all
    p.loadModule?.("captions");
    const list = p.getOption?.("captions", "tracklist") ?? [];
    const en = list.find((t) => /^en\b/.test(t.languageCode) && t.kind !== "asr") ?? list.find((t) => /^en\b/.test(t.languageCode));
    const pick = en ?? (list[0] && { ...list[0], translationLanguage: { languageCode: "en", languageName: "English" } });
    if (!pick) return; // the list isn't loaded yet
    p.setOption("captions", "track", pick);
    asked = id;
  }, 1000);
})();
