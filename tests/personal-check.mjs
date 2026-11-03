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
C.light("Grumpy ", "green");
expect("a greenlit channel's videos are shown, even one disliked twice", C.judge(vid("g9", "grumpy")).why === "a channel you greenlit");
expect("…but a video you 👎 yourself still goes", C.judge(vid("g2", "grumpy")).verdict === "hide");
expect("…and it's listed once", C.stats().greenlit.join() === "Grumpy");
C.light("grumpy", null);
expect("stop greenlighting: as before", C.judge(vid("g9", "grumpy")).why === "a channel you disliked");
C.light("Spammy", "stop");
expect("a stoplit channel's videos are hidden", C.judge(vid("s1", "spammy")).why === "a channel you stoplit");
expect("…but one you 👍 yourself still shows", (await C.feedback(vid("s2", "Spammy"), true), C.judge(vid("s2", "Spammy")).verdict === "show"));
C.light("Spammy", "green");
expect("greenlighting a stoplit channel moves it across", C.judge(vid("s1", "spammy")).verdict === "show" && C.stats().stoplit.length === 0);
C.light("Spammy", null);
C.light("ByteByteGo", "green");
C.light("Loud Channel", "stop");
await new Promise((r) => setTimeout(r, 600));
const C2 = createClicks(storage);
await C2.load();
expect("remembered across sessions", C2.stats().dislikes === 5 && C2.judge(vid("g2", "grumpy")).verdict === "hide");
expect("greenlit channels too", C2.judge(vid("b1", "ByteByteGo")).why === "a channel you greenlit");
expect("and stoplit ones", C2.judge(vid("l1", "loud channel")).why === "a channel you stoplit");
console.log(bad ? `\n${bad} failed` : "\nCHECK OK");
process.exit(bad ? 1 : 0);
