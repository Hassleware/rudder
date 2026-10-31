// CPU-only check of Rudder's learner (extension/youtube/personal.js) with made-up fingerprints: two "topics" (clusters)
// in layer-7 space; 👎 a few of one, 👍 / see a few of the other, and the learner should hide the rest of the first
// and leave the second alone; channels with 2 👎 get hidden; an explicit 👍 always shows.
// Run: node research/personal-check.mjs
const mem = {};
const storage = { get: async (k) => Object.fromEntries([k].flat().map((x) => [x, mem[x]])), set: async (o) => Object.assign(mem, o) };
const { createLearner, fingerprint } = await import("../extension/youtube/personal.js");
let s = 1;
const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
const centre = () => Float32Array.from({ length: 1536 }, rnd);
const near = (c) => [Float32Array.from(c, (x) => x * 4 + rnd() * 3)]; // one layer-7 row near a topic centre
const A = centre(), B = centre();
const vid = (i, c, ch) => ({ id: "v" + i, title: "t" + i, channel: ch, print: { t: fingerprint(near(c)), i: fingerprint(near(c)) } });
const L = createLearner(storage);
await L.load();
let bad = 0;
const expect = (what, ok) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

expect("no opinion before any feedback", L.judge(vid(0, A, "x")).verdict === null);
for (let i = 1; i <= 4; i++) await L.feedback(vid(i, A, "chan" + i), false); // 👎 four "A" videos
for (let i = 10; i < 30; i++) L.shown(vid(i, B, "b" + i)); // shown "B" videos, not disliked
await L.feedback(vid(5, B, "bb"), true);
const hiddenA = Array.from({ length: 20 }, (_, i) => L.judge(vid(100 + i, A, "new" + i)).verdict === "hide").filter(Boolean).length;
const hiddenB = Array.from({ length: 20 }, (_, i) => L.judge(vid(200 + i, B, "new" + i)).verdict === "hide").filter(Boolean).length;
expect(`learned: hides new videos like the disliked ones (${hiddenA}/20)`, hiddenA >= 16);
expect(`learned: leaves the other kind alone (${hiddenB}/20 hidden)`, hiddenB <= 2);
await L.feedback(vid(300, B, "grumpy"), false);
await L.feedback(vid(301, B, "grumpy"), false);
expect("a channel with 2 dislikes is hidden", L.judge(vid(302, B, "grumpy")).why === "a channel you disliked");
await L.feedback(vid(400, A, "fan"), true);
expect("an explicit like always shows", L.judge(vid(400, A, "fan")).verdict === "show");
await new Promise((r) => setTimeout(r, 600));
const L2 = createLearner(storage);
await L2.load();
expect(`remembered across sessions (${L2.stats().dislikes} dislikes, learning ${L2.stats().learning})`, L2.stats().dislikes === 6 && L2.stats().learning);
console.log(bad ? `\n${bad} failed` : "\nCHECK OK");
process.exit(bad ? 1 : 0);
