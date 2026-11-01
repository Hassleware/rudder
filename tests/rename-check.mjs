// Renaming the default filters must not change what they catch: every title in keywords-check.mjs and the live hunts
// through the old and the new names, compiled to the same words. Run: node tests/rename-check.mjs
import fs from "node:fs";
const { compile } = await import("../extension/youtube/keywords.js");
const R = JSON.parse(fs.readFileSync(new URL("./filter-rename.json", import.meta.url), "utf8"));
const norm = (s) => JSON.stringify(compile(s).map((alt) => alt.map((slot) => slot.word).sort()).sort());
let bad = 0;
for (const [old, now] of Object.entries(R)) if (norm(old) !== norm(now)) { bad++; console.log(`DIFF  "${old}" ${norm(old)}\n      "${now}" ${norm(now)}`); }
console.log(bad ? `${bad} differ` : `CHECK OK: all ${Object.keys(R).length} renamed filters compile to the same words`);
process.exit(bad ? 1 : 0);
