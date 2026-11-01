// CPU-only check of Rudder's decisions (youtube/intercept.js) with a fake browser and a fake judge: keyword hits hide
// at once without the model, errors hide, the judge's verdicts are used, removing a filter needs no new check.
// Run: node research/intercept-check.mjs
const store = {};
globalThis.browser = {
  webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} }, filterResponseData() {} },
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
  storage: { local: { get: async () => ({ ...store }), set: async (o) => Object.assign(store, o), remove: async () => {} } },
};
const { setJudge, setFilters, verdict, stats, test, videos } = await import("../extension/youtube/intercept.js");
const { timings } = await import("../extension/timing.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = [], fail = false;
await setJudge(async (videos, sentences) => {
  calls.push({ ids: videos.map((v) => v.id), sentences });
  if (fail) throw new Error("GPU lost");
  return videos.map((v) => ({ verdicts: Object.fromEntries(sentences.map((s) => [s, { blocked: /cats/i.test(v.title) && /felines/.test(s), verdict: "judge" }])) }));
}, "test");
const ask = (id, title, channel) => verdict({ id, title, channel, viewer: true, dist: 0 });
let bad = 0;
const expect = (what, got, want) => { const ok = got === want; if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : " (want " + want + ")"}`); };

setFilters(["news", "anything about death", "anything about felines"]);
expect("Patrick Stewart, before any model check", ask("ps1", "Star Trek and X-Men actor Sir Patrick Stewart dies aged 86", "ITV News"), "block");
expect("…and the judge wasn't needed", calls.some((c) => c.ids.includes("ps1")), false);
expect("harmless video waits for the judge", ask("v1", "Restoring a rusty bicycle", "Restore It"), "wait");
await wait(300);
expect("…then shows", ask("v1", "Restoring a rusty bicycle", "Restore It"), "show");
ask("v2", "Funny cats compilation", "Pets"); await wait(300);
expect("judge says felines → hidden", ask("v2", "Funny cats compilation", "Pets"), "block");
fail = true;
ask("v3", "Learn guitar chords", "Andy"); await wait(300);
expect("check fails → hidden (strict)", ask("v3", "Learn guitar chords", "Andy"), "block");
fail = false;
calls = [];
setFilters(["news", "anything about death"]); await wait(300);
expect("filter removed: cats video back", ask("v2", "Funny cats compilation", "Pets"), "show");
expect("…with no new model check", calls.filter((c) => c.ids.includes("v2")).length, 0);
setFilters(["news", "anything about death", "anything about cooking"]); await wait(300);
expect("filter added: only the new filter is checked", JSON.stringify(calls.find((c) => c.ids.includes("v1"))?.sentences), JSON.stringify(["anything about cooking"]));
setFilters(["anything about cooking", "anything depressing"]); await wait(300);
expect("Patrick Stewart still hidden by 'depressing' keywords", ask("ps1", "Star Trek and X-Men actor Sir Patrick Stewart dies aged 86", "ITV News"), "block");
// test(): the same decisions for an app's own tests, without showing, counting or remembering anything
setFilters(["anything depressing", "anything about felines"]); await wait(300);
const before = stats().checked, known = videos.size;
const [t1, t2, t3] = await test([{ title: "Star Trek and X-Men actor Sir Patrick Stewart dies aged 86" }, { title: "Funny cats compilation" }, { title: "Learn guitar chords" }]);
expect("test: keyword hit hidden", `${t1.hidden} ${/keyword/.test(t1.why)}`, "true true");
expect("test: judge hit hidden", `${t2.hidden} ${t2.verdicts["anything about felines"]?.verdict}`, "true judge");
expect("test: harmless shown", t3.hidden, false);
expect("test: nothing counted or kept", `${stats().checked} ${videos.size}`, `${before} ${known}`);
const stages = timings().map((t) => t.name);
expect("timings: keywords, judge and test timed", ["keywords (a video)", "judge (a batch)", "test (a batch)"].every((n) => stages.includes(n)), true);
console.log("stats:", JSON.stringify(stats()));
console.log(bad ? `\n${bad} failed` : "\nCHECK OK");
process.exit(bad ? 1 : 0);
