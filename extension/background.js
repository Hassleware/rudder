// Rudder's background page. Every YouTube video goes through a pipeline of stages (pipeline.js), on the processor:
//   your-clicks     your own 👍 / 👎 on this exact video, and channels you've disliked twice (youtube/personal.js)
//   keywords        the filters' words in its title and channel (youtube/keywords.js; instant)
//   thumbnail-text  the filters' words in its thumbnail's text, read by Tesseract (ocr.js, ~60 ms a thumbnail)
// Apps on this computer can add their own stages (kind "app"), reorder or reconfigure these, or replace them all
// (bridge/: API.md). Learning what you'd dislike from your 👍 / 👎 is an app's job (WatchFeedback): Hull does it with
// Gemma. Gemma in the browser (until 2026-10-31) and a MiniLM learner (until 2026-11-03) did it here before
// (docs/history.md).
import { setEnabled, stats, recentHidden, feedback, forget, greenlight, clicks, test, redecide, recordOf, setSink, setShownSink, setFeedbackSink, recheckTabs } from "./youtube/intercept.js";
import { timed, timings, record } from "./timing.js";
import { defineKind, setPipeline, getPipeline, kindNames, PASS } from "./pipeline.js";
import { exactMatch, keywordMatch } from "./youtube/keywords.js";
import { readThumbnail } from "./ocr.js";
import { startApi } from "./api.js";
import { createCaptions } from "./youtube/captions.js";
import { tap } from "./youtube/intercept.js";

// The default filters: the user's own 43 merged into 11 (2026-10-31), plus common upsetting topics and relapse
// triggers; each filter's words and youtube/keywords.js do the rest (checked with tests/keywords-check.mjs).
const YOUTUBE_FILTERS = ["video games", "AI", "tech companies, coding, cyber security", "jobs, stocks, the rich, the poor", "news, war, death", "violent, angry, mean, offensive", "depressing, doom, mood ruining, the future", "motivational", "last this or last that", "vlogbrothers", "cf3",
  // grown on the user's request ("so social media can never make me feel upset again"): common upsetting topics
  "politics, elections, politicians", "crime, scams, true crime", "disasters, accidents, emergencies", "illness, disease, health scares", "drama, controversy, people being exposed", "rage bait, clickbait", "scary, horror, disturbing", "dieting, weight loss, body image", "conspiracies, culture wars", "animal cruelty, suffering", "breakups, cheating, toxic relationships", "climate, pollution",
  // relapse triggers (the user's request: "anything that could possibly cause an addictive person to relapse")
  "alcohol, drinking", "drugs, cigarettes, vaping", "gambling, betting, casinos", "sexual, suggestive, adult", "binge eating, junk food, food challenges", "shopping, spending, hauls", "self-harm, suicide, eating disorders", "addiction, relapse, withdrawal"];
const SETTINGS_V = 4; // saved settings older than this are replaced by the defaults once
// a filter matches its own words exactly unless "related" is on (then related words too: youtube/keywords.js). The
// built-in filters were written for related words, and so were filters saved before the switch (no "related" key)
let yt = { enabled: true, filters: YOUTUBE_FILTERS.map((sentence) => ({ sentence, related: true })), v: SETTINGS_V };

const ports = new Set();
const send = (msg) => ports.forEach((p) => p.postMessage(msg));

// ---- the built-in stage kinds (pipeline.js). "keywords" and "thumbnail-text" use the popup's filters unless their
// config has its own { filters: [...] } ----
// a stage config's own filters (apps' word lists) match related words, as they always have
const filtersOf = (config) => (Array.isArray(config.filters) ? config.filters.map((s) => ({ sentence: String(s), related: true }))
  : yt.filters.map((f) => ({ sentence: f.sentence, related: f.related !== false })));
const matchOf = (f, text, channel) => (f.related ? keywordMatch : exactMatch)(f.sentence, text, channel);
defineKind("your-clicks", {
  check(v) { const r = clicks.judge(v); return r.verdict ? { decision: r.verdict, why: r.why } : PASS; },
});
defineKind("keywords", {
  check(v, config) {
    const t = performance.now();
    try {
      for (const f of filtersOf(config)) { const m = matchOf(f, v.title, v.channel); if (m) return { decision: "hide", why: `${f.sentence} (keyword: ${m})`, filter: f.sentence }; }
      return PASS;
    } finally { record("keywords (a video)", performance.now() - t); }
  },
});
defineKind("thumbnail-text", {
  needsImage: true,
  check(v, config) {
    if (!v.image) return PASS; // no thumbnail to read
    if (v.ocr === undefined) return null;
    const fields = { thumbnail_text: v.ocr };
    // short words ("ill", "ai", "rip") are what Tesseract most often makes out of noise: on thumbnails, 4+ letters
    for (const f of filtersOf(config)) {
      const m = v.ocr && matchOf(f, v.ocr);
      if (m && m.split(/ \+ | /).every((w) => w.length >= (config.min_letters ?? 4))) return { decision: "hide", why: `${f.sentence} (thumbnail text: ${m})`, filter: f.sentence, fields };
    }
    return { decision: "pass", fields };
  },
  async batch(vs) { await Promise.all(vs.map(async (v) => { v.ocr = await timed("ocr (a thumbnail)", () => readThumbnail(v.image)); })); },
});
// an app's stage, run over the bridge: config { name, when_missing: "hide" (default) | "pass", ...anything the app reads }
const appKey = (config) => JSON.stringify(config);
// the answer from this sighting (intercept.js sets sightedAt when YouTube sends the video again); a remembered answer
// from before a restart never matches
const sighting = (v) => (v.sightedAt ??= Date.now());
const DECISIONS = new Set(["hide", "show", "pass"]);
defineKind("app", {
  needsImage: true,
  validate(config) { if (!config.name) throw new Error('an "app" stage needs config.name: the name its app says hello with'); },
  check(v, config) {
    const r = v.app?.[appKey(config)];
    if (r && (config.remember !== false || r.at === sighting(v))) return r;
    if (!api.has(config.name)) return config.when_missing === "pass" ? PASS : { decision: "hide", why: `app ${config.name} isn't running` };
    return null;
  },
  async batch(vs, config) {
    const asked = vs.map(sighting); // a new sighting meanwhile (a refresh) needs a new answer: these are for this one
    const rs = await api.stage(config.name, config, vs.map(recordOf));
    if (rs.length !== vs.length) throw new Error(`app ${config.name} answered ${rs.length} of ${vs.length} videos`);
    vs.forEach((v, i) => {
      const decision = String(rs[i]?.decision ?? "pass").toLowerCase();
      if (!DECISIONS.has(decision)) throw new Error(`app ${config.name}: unknown decision "${rs[i]?.decision}"`);
      const fields = Object.fromEntries(Object.entries(rs[i]?.fields ?? {}).map(([k, x]) => [k, String(x).slice(0, 2000)]));
      (v.app ??= {})[appKey(config)] = { decision, why: String(rs[i]?.why ?? "").slice(0, 200), fields, at: asked[i] };
    });
  },
});

// ---- the pipeline: the default, or the one an app set (kept in extension storage) ----
const DEFAULT_PIPELINE = [{ id: "your-clicks", kind: "your-clicks" }, { id: "keywords", kind: "keywords" }, { id: "thumbnail-text", kind: "thumbnail-text" }];
const pipelineState = () => ({ stages: getPipeline(), kinds: kindNames() });
// an empty list restores the default; throws (changing nothing) if the list is wrong
function usePipeline(list, save = true) {
  setPipeline(list?.length ? list : DEFAULT_PIPELINE);
  if (save) browser.storage.local.set({ pipeline: list?.length ? getPipeline() : null }).catch(() => {});
  redecide();
  applyYoutube("soft");
  return pipelineState();
}
setPipeline(DEFAULT_PIPELINE);
browser.storage.local.get("pipeline").then((r) => {
  if (!r.pipeline?.length) return;
  // a saved pipeline may still have the old MiniLM learner's stage ("learned"): it's gone
  try { usePipeline(r.pipeline.filter((st) => st.kind !== "learned"), false); } catch (err) { console.warn("rudder: saved pipeline unusable, using the default:", err); }
}).catch(() => {});

// settings: the popup's filter list (any number of sentences) and the on/off switch, kept in extension storage
// apps' panels for the popup (panel.js renders them; bridge: SetPanel)
const panels = new Map();
let api = null;
const ytState = () => ({ type: "filters", enabled: yt.enabled, filters: yt.filters.map((f) => f.sentence),
  related: yt.filters.filter((f) => f.related !== false).map((f) => f.sentence), stages: getPipeline().map((s) => s.id),
  // app stages whose app isn't connected: they hide what they'd check (or pass it, with when_missing "pass")
  waiting: getPipeline().filter((s) => s.kind === "app" && !api?.has(s.config.name)).map((s) => ({ id: s.id, app: s.config.name, hides: s.config.when_missing !== "pass" })),
  stats: stats(), recent: recentHidden(), panels: [...panels.values()] });
// how open YouTube pages take a change: "reset" (the filters changed: every tile is decided again, hidden until then) or
// "soft" (a switch: on/off, the pipeline): what's on screen stays put, the change applies to the rest (feed.js)
function applyYoutube(how) {
  setEnabled(yt.enabled);
  if (how) browser.tabs.query({ url: "https://www.youtube.com/*" }).then((ts) => ts.forEach((t) => browser.tabs.sendMessage(t.id, { type: how === "soft" ? "yt-soft" : "yt-reset" }).catch(() => {})));
  send(ytState());
  api?.changed();
}
function setYoutubeSettings(msg) {
  if (msg.filters) {
    // each filter: { sentence, related } (the popup), or just its words (the API: a filter already there keeps its
    // switch, a new one is exact)
    const seen = new Set(), list = [], before = new Map(yt.filters.map((f) => [f.sentence.toLowerCase(), f.related !== false]));
    for (const raw of msg.filters) {
      const s = String(raw?.sentence ?? raw).replace(/\s+/g, " ").trim().slice(0, 200);
      const related = typeof raw === "object" && raw ? !!raw.related : (before.get(s.toLowerCase()) ?? false);
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); list.push({ sentence: s, related }); }
    }
    yt = { ...yt, filters: list };
  }
  if ("enabled" in msg) yt = { ...yt, enabled: !!msg.enabled };
  browser.storage.local.set({ "yt-settings": yt }).catch(() => {});
  applyYoutube(msg.filters ? "reset" : "soft");
}
api = startApi({
  state: () => ({ ...ytState(), type: "state" }),
  setFilters: (filters) => setYoutubeSettings({ filters }),
  setEnabled: (on) => setYoutubeSettings({ enabled: on }),
  getPipeline: pipelineState,
  setPipeline: (stages) => usePipeline(stages),
  appsChanged: () => { recheckTabs(); send(ytState()); },
  setPanel: (p) => { if (!p) panels.clear(); else if (p.blocks?.length) panels.set(p.id, p); else panels.delete(p.id); send(ytState()); },
  timings,
  test,
});
setShownSink((ids, at) => api.shown(ids, at));
setFeedbackSink((v, like) => api.feedback(recordOf(v), like));

// captions of the videos you watch, line by line as you watch them (youtube/captions.js; bridge: WatchCaptions)
const captions = createCaptions((lines) => api.captions(lines));
browser.webRequest.onBeforeRequest.addListener((d) => tap(d, (bytes) => captions.track(d.url, new TextDecoder().decode(bytes))),
  { urls: ["https://www.youtube.com/api/timedtext*"] }, ["blocking"]);
browser.runtime.onMessage.addListener((msg, sender) => { if (msg?.type === "yt-playhead") captions.playhead(sender.tab?.id ?? -1, String(msg.id), +msg.t); });
browser.tabs.onRemoved.addListener((tab) => captions.closed(tab));
setSink((v, d) => api.video(recordOf(v), { hidden: d.state === "hide", decided_by: d.stage ?? "", why: d.why ?? "" }));
applyYoutube(false);
// the defaults used to be worded for the old model ("anything about video games"); saved lists get the plain names, and
// filters you added yourself are kept as you wrote them (tests/rename-check.mjs: same words, same matches)
const RENAMED = {"anything about video games": "video games", "anything about AI": "AI", "anything about tech companies, coding or cyber security": "tech companies, coding, cyber security", "anything about jobs, stocks, the rich or the poor": "jobs, stocks, the rich, the poor", "anything about news, war or death": "news, war, death", "anything violent, angry, mean or offensive": "violent, angry, mean, offensive", "anything depressing, doom inducing, mood ruining or about the future": "depressing, doom, mood ruining, the future", "anything motivational": "motivational", "anything about a last this or last that": "last this or last that", "anything about politics, elections or politicians": "politics, elections, politicians", "anything about crime, scams or true crime": "crime, scams, true crime", "anything about disasters, accidents or emergencies": "disasters, accidents, emergencies", "anything about illness, disease or health scares": "illness, disease, health scares", "anything about drama, controversy or someone being exposed": "drama, controversy, people being exposed", "anything rage bait or clickbait": "rage bait, clickbait", "anything scary, horror or disturbing": "scary, horror, disturbing", "anything about dieting, weight loss or body image": "dieting, weight loss, body image", "anything about conspiracies or culture wars": "conspiracies, culture wars", "anything about animal cruelty or suffering": "animal cruelty, suffering", "anything about breakups, cheating or toxic relationships": "breakups, cheating, toxic relationships", "anything about the climate or pollution": "climate, pollution", "anything about alcohol or drinking": "alcohol, drinking", "anything about drugs, cigarettes or vaping": "drugs, cigarettes, vaping", "anything about gambling, betting or casinos": "gambling, betting, casinos", "anything sexual, suggestive or adult": "sexual, suggestive, adult", "anything about binge eating, junk food or food challenges": "binge eating, junk food, food challenges", "anything about shopping, spending or hauls": "shopping, spending, hauls", "anything about self-harm, suicide or eating disorders": "self-harm, suicide, eating disorders", "anything about addiction, relapse or withdrawal": "addiction, relapse, withdrawal"};
browser.storage.local.get("yt-settings").then((r) => {
  const saved = r["yt-settings"];
  if (saved?.filters?.some((f) => RENAMED[f.sentence])) {
    saved.filters = saved.filters.map((f) => ({ ...f, sentence: RENAMED[f.sentence] ?? f.sentence }));
    browser.storage.local.set({ "yt-settings": saved }).catch(() => {});
  }
  if (saved?.v >= SETTINGS_V) { yt = saved; applyYoutube("reset"); }
  else browser.storage.local.set({ "yt-settings": yt }).catch(() => {});
}).catch(() => {});

// the popup
browser.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "filters") port.postMessage(ytState());
    if (msg.type === "set-filters") setYoutubeSettings(msg);
    if (msg.type === "set-enabled") setYoutubeSettings({ enabled: !!msg.enabled });
    if (msg.type === "rudder-like") feedback({ id: msg.id, like: true }).then(() => port.postMessage(ytState())).catch(() => {});
    if (msg.type === "panel-click") api.event(msg.panel, msg.button);
    if (msg.type === "rudder-forget") { forget(); port.postMessage(ytState()); }
    if (msg.type === "rudder-greenlight") greenlight(msg).then(() => port.postMessage(ytState())).catch(() => {});
  });
  port.postMessage(ytState());
});
