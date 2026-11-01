// CPU-only check of Rudder's pipeline (pipeline.js) and its use in youtube/intercept.js, with a fake browser and test
// stage kinds: stages run in order and the first hide or show decides; slow stages run in batches and only when
// reached; a failing stage hides; fields reach later stages; changing the pipeline needs no new runs; test() traces
// every stage without counting anything; YouTube's data becomes Rudder's video record.
// Run: node tests/intercept-check.mjs
const store = {};
let onMessage = null;
globalThis.browser = {
  webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} }, filterResponseData() {} },
  runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
  tabs: { sendMessage: async () => {} },
  storage: { local: { get: async () => ({ ...store }), set: async (o) => Object.assign(store, o), remove: async () => {} } },
};
const { verdict, stats, test, videos, redecide, recordOf } = await import("../extension/youtube/intercept.js");
const { defineKind, setPipeline, PASS } = await import("../extension/pipeline.js");
const { timings } = await import("../extension/timing.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const expect = (what, got, want) => { const ok = got === want; if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : " (want " + want + ")"}`); };

// test kinds: a word in the title says something at once; a slow stage (a batch, like OCR or an app); a stage that reads
// a field an earlier stage added
let runs = [], fail = false;
defineKind("word", { check: (v, c) => (new RegExp(c.word, "i").test(v.title) ? { decision: c.say ?? "hide", why: `has ${c.word}`, filter: c.word } : PASS) });
defineKind("slow", {
  check: (v) => (v.slow === undefined ? null : v.slow),
  async batch(vs) {
    runs.push(...vs.map((v) => v.id));
    if (fail) throw new Error("model lost");
    for (const v of vs) v.slow = /cats/i.test(v.title) ? { decision: "hide", why: "cats", fields: { animal: "cat" } } : { decision: "pass", fields: { animal: "none" } };
  },
});
defineKind("sees", { check: (v) => ({ decision: "pass", fields: { saw: v.fields?.animal ?? "nothing" } }) });
const FULL = [{ id: "allow", kind: "word", config: { word: "bicycle", say: "show" } }, { id: "news", kind: "word", config: { word: "dies" } }, { id: "slow", kind: "slow" }, { id: "sees", kind: "sees" }];
setPipeline(FULL);
const ask = (id, title) => verdict({ id, title, channel: "", viewer: true, dist: 0 });

expect("a quick stage hides at once", ask("ps1", "Patrick Stewart dies aged 86"), "block");
expect("…and the slow stage never ran for it", runs.includes("ps1"), false);
expect("an earlier show wins, no slow stage", ask("b1", "Restoring a rusty bicycle"), "show");
expect("a harmless video waits for the slow stage", ask("g1", "Learn guitar chords"), "wait");
await wait(300);
expect("…then shows", ask("g1", "Learn guitar chords"), "show");
ask("c1", "Funny cats compilation"); await wait(300);
expect("the slow stage hides cats", ask("c1", "Funny cats compilation"), "block");
fail = true;
ask("x1", "Knitting basics"); await wait(300);
expect("a failing stage hides (strict)", ask("x1", "Knitting basics"), "block");
fail = false;

runs = [];
setPipeline(FULL.filter((s) => s.id !== "slow")); redecide();
expect("slow stage removed: cats shown", ask("c1", "Funny cats compilation"), "show");
expect("…with no new runs", runs.length, 0);
setPipeline([{ id: "everything", kind: "word", config: { word: "." } }]); redecide();
expect("pipeline replaced by one stage: it decides alone", ask("g1", "Learn guitar chords"), "block");
setPipeline(FULL); redecide();
let threw = "";
try { setPipeline([{ kind: "nope" }]); } catch (err) { threw = err.message; }
expect("an unknown kind is refused", /unknown stage kind/.test(threw), true);
expect("…and the pipeline is unchanged", ask("c1", "Funny cats compilation"), "block");

// test(): every stage's say, fields passed on, nothing counted or kept
const before = stats().checked, known = videos.size;
const [t1, t2] = await test([{ title: "Funny cats compilation" }, { title: "Learn guitar chords" }]);
expect("test: trace of a hidden video", t1.trace.map((x) => `${x.stage}:${x.decision}`).join(" "), "allow:pass news:pass slow:hide");
expect("test: hidden, by which stage", `${t1.hidden} ${t1.decided_by} ${t1.why}`, "true slow cats");
expect("test: a later stage saw an earlier stage's field", `${t2.hidden} ${t2.fields.saw}`, "false none");
expect("test: nothing counted or kept", `${stats().checked} ${videos.size}`, `${before} ${known}`);
await wait(300); // the knitting video failed before; a pipeline change clears failures, so it was checked again
expect("stats: hidden by stage", JSON.stringify(stats().byStage), JSON.stringify({ news: 1, slow: 1 }));
expect("…and the knitting video now shows", ask("x1", "Knitting basics"), "show");
expect("timings: each stage's batches timed", ["slow (a batch)", "test (a batch)"].every((n) => timings().some((t) => t.name === n)), true);

// the video record, from YouTube's data: a home tile, then the same video's player data (description, length, date)
const tile = { lockupViewModel: { contentId: "abcdefghijk", contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
  metadata: { lockupMetadataViewModel: { title: { content: "Bread at home" }, metadata: { contentMetadataViewModel: { metadataRows: [
    { metadataParts: [{ text: { content: "Baker Jo" } }] }, { metadataParts: [{ text: { content: "1.2M views" } }, { text: { content: "3 days ago" } }] }] } } } },
  contentImage: { thumbnailViewModel: { image: { sources: [{ url: "https://i.ytimg.com/vi/abcdefghijk/hq.jpg", width: 480 }] },
    overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: "12:34" } }] } }] } } } };
onMessage({ type: "yt-data", json: JSON.stringify({ contents: [tile] }), source: "browse" }, { tab: { id: 1 } });
let r = recordOf(videos.get("abcdefghijk"));
expect("record from a home tile", [r.title, r.channel, r.published, r.duration_seconds, r.thumbnail_url, r.source].join(" | "), "Bread at home | Baker Jo | 3 days ago | 754 | https://i.ytimg.com/vi/abcdefghijk/hq.jpg | browse");
onMessage({ type: "yt-data", json: JSON.stringify({ videoDetails: { videoId: "abcdefghijk", title: "Bread at home", author: "Baker Jo", shortDescription: "How to bake bread", lengthSeconds: "754" }, microformat: { playerMicroformatRenderer: { publishDate: "2026-10-29" } } }), source: "player" }, { tab: { id: 1 } });
r = recordOf(videos.get("abcdefghijk"));
expect("…filled in by its player data", [r.description, r.published].join(" | "), "How to bake bread | 2026-10-29");
console.log("stats:", JSON.stringify(stats()));
console.log(bad ? `\n${bad} failed` : "\nCHECK OK");
