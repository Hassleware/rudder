// CPU-only check of your ratings (extension/youtube/personal.js): a video you rated is decided by your rating; a
// channel you 👎 twice and never 👍 is hidden, one you 👍 isn't; everything else is left to the other stages; the
// old learner's clicks are kept; ratings survive a restart.
// Run: node tests/personal-check.mjs
const mem = { "rudder-learning-v2": { examples: [{ id: "old", title: "Old", channel: "c", like: false, at: 1, e: { t: "x" } }], shown: [] } };
const storage = { get: async (k) => Object.fromEntries([k].flat().map((x) => [x, mem[x]])), set: async (o) => Object.assign(mem, o) };
const { createClicks } = await import("../extension/youtube/personal.js");
const C = createClicks(storage);
await C.load();
let bad = 0;
const expect = (what, ok) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const vid = (id, channel) => ({ id, title: "t " + id, channel });

expect("the old learner's clicks are kept", C.judge(vid("old", "c")).why === "you disliked it");
expect("no opinion on a video you didn't rate", C.judge(vid("a", "x")).verdict === null);
await C.feedback(vid("a", "x"), true);
expect("a 👍 shows that video", C.judge(vid("a", "x")).verdict === "show");
await C.feedback(vid("g1", "grumpy"), false);
expect("one 👎 on a channel doesn't hide it", C.judge(vid("g9", "grumpy")).verdict === null);
await C.feedback(vid("g2", "grumpy"), false);
expect("a channel with 2 👎 is hidden", C.judge(vid("g9", "grumpy")).why === "a channel you disliked");
await C.feedback(vid("f1", "fan"), false);
await C.feedback(vid("f2", "fan"), false);
await C.feedback(vid("f3", "fan"), true);
expect("…unless you've also 👍 it", C.judge(vid("f9", "fan")).verdict === null);
expect(`stats (${JSON.stringify(C.stats())})`, C.stats().likes === 2 && C.stats().dislikes === 5 && C.stats().channels.join() === "grumpy");
await new Promise((r) => setTimeout(r, 600));
const C2 = createClicks(storage);
await C2.load();
expect("remembered across sessions", C2.stats().dislikes === 5 && C2.judge(vid("g2", "grumpy")).verdict === "hide");
console.log(bad ? `\n${bad} failed` : "\nCHECK OK");
process.exit(bad ? 1 : 0);
