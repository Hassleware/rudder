// Runs inside the YouTube page (put there by youtube/feed.js), so it
// can read the page's own data. YouTube's HTML sets window.ytInitialData (every video on the first screen) before the
// app draws the grid; in-site navigation hands the app new data in the yt-navigate-finish event. Both are passed to
// the content script with postMessage. Reads only; requests nothing.
(() => {
  const send = (data, source) => { if (data) window.postMessage({ gemmaYT: true, source, json: JSON.stringify(data) }, location.origin); };
  let sent = null;
  const poll = setInterval(() => {
    if (window.ytInitialData && window.ytInitialData !== sent) { sent = window.ytInitialData; send(sent, "page"); clearInterval(poll); }
  }, 20);
  setTimeout(() => clearInterval(poll), 30000);
  window.addEventListener("yt-navigate-finish", (e) => send(e.detail?.response?.response ?? e.detail?.response, "navigation"));
})();
