// Rudder's background page. No large model: every YouTube video is checked on the processor, in milliseconds.
//   1. keywords on its title and channel (youtube/keywords.js; instant, run in youtube/intercept.js)
//   2. the same keywords on its thumbnail's text, read by Tesseract (ocr.js, ~60 ms a thumbnail)
//   3. your own algorithm (youtube/personal.js): MiniLM reads each title into a fingerprint (text.js) and a small model
//      learns what you don't want from your 👍 / 👎
// Gemma (WebLLM on the GPU) did a yes/no check and read thumbnails as image tokens until 2026-10-31; live hunts showed
// keywords did ~90% of the hiding and Gemma's own calls were right about half the time, for a 45 s load and 2.8 GB of
// graphics memory (NOTES.md).
import { setJudge, setFilters, setEnabled, stats, setPrinter, recentHidden, feedback, forget, learner } from "./youtube/intercept.js";
import { keywordMatch } from "./youtube/keywords.js";
import { readThumbnail } from "./ocr.js";
import { embed } from "./text.js";
import { fingerprint } from "./youtube/personal.js";

// The default filters: the user's own 43 merged into 11 (2026-10-31), plus common upsetting topics and relapse
// triggers; each filter's words and youtube/keywords.js do the rest (checked with research/keywords-check.mjs).
const YOUTUBE_FILTERS = ["video games", "AI", "tech companies, coding, cyber security", "jobs, stocks, the rich, the poor", "news, war, death", "violent, angry, mean, offensive", "depressing, doom, mood ruining, the future", "motivational", "last this or last that", "vlogbrothers", "cf3",
  // grown on the user's request ("so social media can never make me feel upset again"): common upsetting topics
  "politics, elections, politicians", "crime, scams, true crime", "disasters, accidents, emergencies", "illness, disease, health scares", "drama, controversy, people being exposed", "rage bait, clickbait", "scary, horror, disturbing", "dieting, weight loss, body image", "conspiracies, culture wars", "animal cruelty, suffering", "breakups, cheating, toxic relationships", "climate, pollution",
  // relapse triggers (the user's request: "anything that could possibly cause an addictive person to relapse")
  "alcohol, drinking", "drugs, cigarettes, vaping", "gambling, betting, casinos", "sexual, suggestive, adult", "binge eating, junk food, food challenges", "shopping, spending, hauls", "self-harm, suicide, eating disorders", "addiction, relapse, withdrawal"];
const SETTINGS_V = 4; // saved settings older than this are replaced by the defaults once
let yt = { enabled: true, filters: YOUTUBE_FILTERS.map((sentence) => ({ sentence })), v: SETTINGS_V };

const ports = new Set();
const send = (msg) => ports.forEach((p) => p.postMessage(msg));

// each video: its thumbnail's words through every filter's keywords, and its fingerprint for your algorithm
const textOf = (v) => (v.channel ? `${v.title} — ${v.channel}` : v.title);
const print = async (v) => ({ t: fingerprint(await embed([textOf(v)])), i: null });
setJudge(async (videos, sentences) => {
  const [words, vecs] = await Promise.all([
    Promise.all(videos.map((v) => (v.image ? readThumbnail(v.image) : ""))), // an OCR error hides the batch (strict); checked again next time
    embed(videos.map(textOf)).catch((err) => { console.warn("rudder: fingerprints unavailable:", err); return null; }),
  ]);
  return videos.map((v, i) => ({
    verdicts: Object.fromEntries(sentences.map((s) => {
      // short words ("ill", "ai", "rip") are what Tesseract most often makes out of noise: on thumbnails, 4+ letters
      const m = words[i] && keywordMatch(s, words[i]), sure = m && m.split(" + ").every((w) => w.length >= 4);
      return [s, sure ? { blocked: true, verdict: `thumbnail text: ${m}` } : { blocked: false, verdict: "clear" }];
    })),
    print: vecs ? { t: fingerprint([vecs[i]]), i: null } : undefined,
  }));
}, "keywords+ocr v3");
setPrinter(print);
learner.load().then(() => learner.reprint(print)).catch(() => {});

// settings: the popup's filter list (any number of sentences) and the on/off switch, kept in extension storage
const ytState = () => ({ type: "filters", enabled: yt.enabled, filters: yt.filters.map((f) => f.sentence), stats: stats(), recent: recentHidden() });
function applyYoutube(reset) {
  setFilters(yt.filters.map((f) => f.sentence));
  setEnabled(yt.enabled && yt.filters.length > 0);
  if (reset) browser.tabs.query({ url: "https://www.youtube.com/*" }).then((ts) => ts.forEach((t) => browser.tabs.sendMessage(t.id, { type: "yt-reset" }).catch(() => {})));
  send(ytState());
}
function setYoutubeSettings(msg) {
  if (msg.filters) {
    const seen = new Set(), list = [];
    for (const raw of msg.filters) {
      const s = String(raw).replace(/\s+/g, " ").trim().slice(0, 200);
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); list.push({ sentence: s }); }
    }
    yt = { ...yt, filters: list };
  }
  if ("enabled" in msg) yt = { ...yt, enabled: !!msg.enabled };
  browser.storage.local.set({ "yt-settings": yt }).catch(() => {});
  applyYoutube(true);
}
applyYoutube(false);
// the defaults used to be worded for the old model ("anything about video games"); saved lists get the plain names, and
// filters you added yourself are kept as you wrote them (research/rename-check.mjs: same words, same matches)
const RENAMED = {"anything about video games": "video games", "anything about AI": "AI", "anything about tech companies, coding or cyber security": "tech companies, coding, cyber security", "anything about jobs, stocks, the rich or the poor": "jobs, stocks, the rich, the poor", "anything about news, war or death": "news, war, death", "anything violent, angry, mean or offensive": "violent, angry, mean, offensive", "anything depressing, doom inducing, mood ruining or about the future": "depressing, doom, mood ruining, the future", "anything motivational": "motivational", "anything about a last this or last that": "last this or last that", "anything about politics, elections or politicians": "politics, elections, politicians", "anything about crime, scams or true crime": "crime, scams, true crime", "anything about disasters, accidents or emergencies": "disasters, accidents, emergencies", "anything about illness, disease or health scares": "illness, disease, health scares", "anything about drama, controversy or someone being exposed": "drama, controversy, people being exposed", "anything rage bait or clickbait": "rage bait, clickbait", "anything scary, horror or disturbing": "scary, horror, disturbing", "anything about dieting, weight loss or body image": "dieting, weight loss, body image", "anything about conspiracies or culture wars": "conspiracies, culture wars", "anything about animal cruelty or suffering": "animal cruelty, suffering", "anything about breakups, cheating or toxic relationships": "breakups, cheating, toxic relationships", "anything about the climate or pollution": "climate, pollution", "anything about alcohol or drinking": "alcohol, drinking", "anything about drugs, cigarettes or vaping": "drugs, cigarettes, vaping", "anything about gambling, betting or casinos": "gambling, betting, casinos", "anything sexual, suggestive or adult": "sexual, suggestive, adult", "anything about binge eating, junk food or food challenges": "binge eating, junk food, food challenges", "anything about shopping, spending or hauls": "shopping, spending, hauls", "anything about self-harm, suicide or eating disorders": "self-harm, suicide, eating disorders", "anything about addiction, relapse or withdrawal": "addiction, relapse, withdrawal"};
browser.storage.local.get("yt-settings").then((r) => {
  const saved = r["yt-settings"];
  if (saved?.filters?.some((f) => RENAMED[f.sentence])) {
    saved.filters = saved.filters.map((f) => ({ sentence: RENAMED[f.sentence] ?? f.sentence }));
    browser.storage.local.set({ "yt-settings": saved }).catch(() => {});
  }
  if (saved?.v >= SETTINGS_V) { yt = saved; applyYoutube(true); }
  else browser.storage.local.set({ "yt-settings": yt }).catch(() => {});
}).catch(() => {});

// the popup
browser.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "filters") port.postMessage(ytState());
    if (msg.type === "set-filters") setYoutubeSettings(msg);
    if (msg.type === "rudder-like") feedback({ id: msg.id, like: true }).then(() => port.postMessage(ytState())).catch(() => {});
    if (msg.type === "rudder-forget") { forget(); port.postMessage(ytState()); }
  });
  port.postMessage(ytState());
});
