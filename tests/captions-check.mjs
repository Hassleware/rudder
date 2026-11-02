// Captions (extension/youtube/captions.js): YouTube's caption formats parse; only English is kept, a person's captions
// over automatic ones; lines go out as playback passes them, a seek skips what was jumped over, and lines downloaded
// after playback started still go out.
// Run: node tests/captions-check.mjs
import assert from "node:assert/strict";
import { parseTrack, createCaptions } from "../extension/youtube/captions.js";

const json3 = JSON.stringify({ events: [
  { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Bayes " }, { utf8: "theorem\nis" }] },
  { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: "\n" }] }, // a line break event: nothing to say
  { tStartMs: 2500, dDurationMs: 1500, segs: [{ utf8: "about &amp; beliefs" }] },
  { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: "priors" }] },
] });
assert.deepEqual(parseTrack(json3).map((l) => [l.start, l.end, l.text]), [[0, 2000, "Bayes theorem is"], [2500, 4000, "about &amp; beliefs"], [9000, 10000, "priors"]]);
assert.deepEqual(parseTrack('<timedtext><body><p t="1200" d="800">hello <s>there</s></p><p t="3000" d="500">it&#39;s me</p></body></timedtext>').map((l) => [l.start, l.end, l.text]),
  [[1200, 2000, "hello there"], [3000, 3500, "it's me"]]);
assert.deepEqual(parseTrack('<transcript><text start="1.5" dur="2">one &amp; two</text></transcript>').map((l) => [l.start, l.text]), [[1500, "one & two"]]);

const out = [], c = createCaptions((lines) => out.push(...lines));
const url = (q) => `https://www.youtube.com/api/timedtext?v=abc&fmt=json3&${q}`;
c.track(url("lang=fr"), json3);
assert.equal(c.has("abc"), false); // not English
c.playhead(1, "abc", 0); // watching starts before the captions arrive
c.playhead(1, "abc", 1);
c.track(url("lang=en&kind=asr"), json3);
c.playhead(1, "abc", 2);
assert.deepEqual(out.map((l) => [l.text, l.auto, l.language]), [["Bayes theorem is", true, "en"]]); // from where watching began
c.track(url("lang=en"), JSON.stringify({ events: [{ tStartMs: 2500, segs: [{ utf8: "about beliefs" }] }, { tStartMs: 9000, segs: [{ utf8: "priors" }] }] }));
c.track(url("lang=en&kind=asr"), json3); // automatic doesn't replace a person's
c.playhead(1, "abc", 3);
assert.equal(out.at(-1).text, "about beliefs");
assert.equal(out.at(-1).auto, false);
c.playhead(1, "abc", 20); // a seek past "priors": skipped
c.playhead(1, "abc", 21);
assert.equal(out.length, 2);
c.track(url("lang=de&tlang=en"), json3.replace("abc", "x")); // translated to English counts
assert.equal(c.has("abc"), true);
console.log("CHECK OK");
