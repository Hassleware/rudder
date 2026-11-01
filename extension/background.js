// Rudder's background page. Every YouTube video goes through a pipeline of stages (pipeline.js), on the processor:
//   your-clicks     your own 👍 / 👎 on this exact video
//   keywords        the filters' words in its title and channel (youtube/keywords.js; instant)
//   learned         your own algorithm (youtube/personal.js): MiniLM reads each title into a fingerprint (text.js) and
//                   a small model learns what you don't want from your 👍 / 👎; channels you disliked
//   thumbnail-text  the filters' words in its thumbnail's text, read by Tesseract (ocr.js, ~60 ms a thumbnail)
// Apps on this computer can add their own stages (kind "app"), reorder or reconfigure these, or replace them all
// (bridge/: API.md). Gemma (WebLLM on the GPU) judged videos until 2026-10-31; keywords did ~90% of the hiding and
// Gemma's own calls were right about half the time, for a 45 s load and 2.8 GB of graphics memory (NOTES.md).
import { setEnabled, stats, setPrinter, recentHidden, feedback, forget, learner, test, redecide, recordOf, setSink, recheckTabs } from "./youtube/intercept.js";
import { timed, timings, record } from "./timing.js";
import { defineKind, setPipeline, getPipeline, kindNames, PASS } from "./pipeline.js";
import { keywordMatch } from "./youtube/keywords.js";
import { readThumbnail } from "./ocr.js";
import { embed } from "./text.js";
import { fingerprint } from "./youtube/personal.js";
import { startApi } from "./api.js";

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

// ---- the built-in stage kinds (pipeline.js). "keywords" and "thumbnail-text" use the popup's filters unless their
// config has its own { filters: [...] } ----
const filtersOf = (config) => (Array.isArray(config.filters) ? config.filters.map(String) : yt.filters.map((f) => f.sentence));
const textOf = (v) => (v.channel ? `${v.title} — ${v.channel}` : v.title);
const print = async (v) => ({ t: fingerprint(await embed([textOf(v)])), i: null });
defineKind("your-clicks", {
  check(v) { const r = learner.judge(v); return r.explicit ? { decision: r.verdict, why: r.why } : PASS; },
});
defineKind("keywords", {
  check(v, config) {
    const t = performance.now();
    try {
      for (const s of filtersOf(config)) { const m = keywordMatch(s, v.title, v.channel); if (m) return { decision: "hide", why: `${s} (keyword: ${m})`, filter: s }; }
      return PASS;
    } finally { record("keywords (a video)", performance.now() - t); }
  },
});
// hides; it only shows ("like videos you liked", a channel you liked) with config { can_show: true }, since a show
// skips every stage after it
defineKind("learned", {
  check(v, config) {
    if (v.print === undefined) return null; // fingerprint first
    const r = learner.judge(v), fields = r.p != null ? { dislike_chance: r.p.toFixed(2) } : undefined;
    return r.explicit || !r.verdict || (r.verdict === "show" && !config.can_show) ? { decision: "pass", fields } : { decision: r.verdict, why: r.why, fields };
  },
  async batch(vs) { // no fingerprint (an error) = the model says nothing; channels still count
    const vecs = await timed("fingerprints (a batch)", () => embed(vs.map(textOf))).catch((err) => { console.warn("rudder: fingerprints unavailable:", err); return null; });
    vs.forEach((v, i) => { v.print = vecs ? { t: fingerprint([vecs[i]]), i: null } : null; });
  },
});
defineKind("thumbnail-text", {
  needsImage: true,
  check(v, config) {
    if (!v.image) return PASS; // no thumbnail to read
    if (v.ocr === undefined) return null;
    const fields = { thumbnail_text: v.ocr };
    // short words ("ill", "ai", "rip") are what Tesseract most often makes out of noise: on thumbnails, 4+ letters
    for (const s of filtersOf(config)) {
      const m = v.ocr && keywordMatch(s, v.ocr);
      if (m && m.split(" + ").every((w) => w.length >= (config.min_letters ?? 4))) return { decision: "hide", why: `${s} (thumbnail text: ${m})`, filter: s, fields };
    }
    return { decision: "pass", fields };
  },
  async batch(vs) { await Promise.all(vs.map(async (v) => { v.ocr = await timed("ocr (a thumbnail)", () => readThumbnail(v.image)); })); },
});
// an app's stage, run over the bridge: config { name, when_missing: "hide" (default) | "pass", ...anything the app reads }
const appKey = (config) => JSON.stringify(config);
const DECISIONS = new Set(["hide", "show", "pass"]);
defineKind("app", {
  needsImage: true,
  validate(config) { if (!config.name) throw new Error('an "app" stage needs config.name: the name its app says hello with'); },
  check(v, config) {
    const r = v.app?.[appKey(config)];
    if (r) return r;
    if (!api.has(config.name)) return config.when_missing === "pass" ? PASS : { decision: "hide", why: `app ${config.name} isn't running` };
    return null;
  },
  async batch(vs, config) {
    const rs = await api.stage(config.name, config, vs.map(recordOf));
    if (rs.length !== vs.length) throw new Error(`app ${config.name} answered ${rs.length} of ${vs.length} videos`);
    vs.forEach((v, i) => {
      const decision = String(rs[i]?.decision ?? "pass").toLowerCase();
      if (!DECISIONS.has(decision)) throw new Error(`app ${config.name}: unknown decision "${rs[i]?.decision}"`);
      const fields = Object.fromEntries(Object.entries(rs[i]?.fields ?? {}).map(([k, x]) => [k, String(x).slice(0, 2000)]));
      (v.app ??= {})[appKey(config)] = { decision, why: String(rs[i]?.why ?? "").slice(0, 200), fields };
    });
  },
});
setPrinter(print);
learner.load().then(() => learner.reprint(print)).catch(() => {});

// ---- the pipeline: the default, or the one an app set (kept in extension storage) ----
const DEFAULT_PIPELINE = [{ id: "your-clicks", kind: "your-clicks" }, { id: "keywords", kind: "keywords" }, { id: "learned", kind: "learned" }, { id: "thumbnail-text", kind: "thumbnail-text" }];
const pipelineState = () => ({ stages: getPipeline(), kinds: kindNames() });
// an empty list restores the default; throws (changing nothing) if the list is wrong
function usePipeline(list, save = true) {
  setPipeline(list?.length ? list : DEFAULT_PIPELINE);
  if (save) browser.storage.local.set({ pipeline: list?.length ? getPipeline() : null }).catch(() => {});
  redecide();
  applyYoutube(true);
  return pipelineState();
}
setPipeline(DEFAULT_PIPELINE);
browser.storage.local.get("pipeline").then((r) => {
  if (!r.pipeline?.length) return;
  try { usePipeline(r.pipeline, false); } catch (err) { console.warn("rudder: saved pipeline unusable, using the default:", err); }
}).catch(() => {});

// settings: the popup's filter list (any number of sentences) and the on/off switch, kept in extension storage
// apps' panels for the popup (panel.js renders them; bridge: SetPanel)
const panels = new Map();
const ytState = () => ({ type: "filters", enabled: yt.enabled, filters: yt.filters.map((f) => f.sentence), stages: getPipeline().map((s) => s.id), stats: stats(), recent: recentHidden(), panels: [...panels.values()] });
function applyYoutube(reset) {
  setEnabled(yt.enabled);
  if (reset) browser.tabs.query({ url: "https://www.youtube.com/*" }).then((ts) => ts.forEach((t) => browser.tabs.sendMessage(t.id, { type: "yt-reset" }).catch(() => {})));
  send(ytState());
  api?.changed();
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
const api = startApi({
  state: () => ({ ...ytState(), type: "state" }),
  setFilters: (filters) => setYoutubeSettings({ filters }),
  getPipeline: pipelineState,
  setPipeline: (stages) => usePipeline(stages),
  appsChanged: () => { recheckTabs(); send(ytState()); },
  setPanel: (p) => { if (!p) panels.clear(); else if (p.blocks?.length) panels.set(p.id, p); else panels.delete(p.id); send(ytState()); },
  timings,
  test,
});
setSink((v, d) => api.video(recordOf(v), { hidden: d.state === "hide", decided_by: d.stage ?? "", why: d.why ?? "" }));
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
    if (msg.type === "panel-click") api.event(msg.panel, msg.button);
    if (msg.type === "rudder-forget") { forget(); port.postMessage(ytState()); }
  });
  port.postMessage(ytState());
});
