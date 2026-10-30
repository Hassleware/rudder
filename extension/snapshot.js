// Steps through a recorded reply (gpu-fixes.js records it, background.js keeps it): for each word, every GPU
// output in order, grouped into stages by stages.js. The background reloads this page when a new reply is recorded.
const $ = (id) => document.getElementById(id);
const data = browser.extension.getBackgroundPage()?.lastSnapshot;
const steps = data?.steps ?? [], words = data?.words ?? [];
let word = 0, all = [], groupRange = {}, shown = [], cur = 0, curRow = 0; // curRow = row number kept across words

const kb = (n) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : (n / 1024).toFixed(1) + " KB");
const quote = (t) => JSON.stringify(t).replace(/\\n/g, "↵");
function stats(v) {
  let min = Infinity, max = -Infinity, sum = 0, sq = 0, bad = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) { bad++; continue; }
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x; sq += x * x;
  }
  const n = v.length - bad;
  return { min, max, mean: sum / n, rms: Math.sqrt(sq / n), bad };
}

function plot(v, color) {
  const c = $("plot"), w = (c.width = c.clientWidth * devicePixelRatio), h = (c.height = c.clientHeight * devicePixelRatio);
  const g = c.getContext("2d"), { min, max } = stats(v);
  const lo = Math.min(min, 0), hi = Math.max(max, 0), y = (x) => h - ((x - lo) / (hi - lo || 1)) * h;
  g.strokeStyle = "#8888";
  g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke(); // zero line
  g.fillStyle = color;
  for (let px = 0; px < w; px++) { // min-max envelope per pixel column
    const a = Math.floor((px / w) * v.length), b = Math.max(a + 1, Math.floor(((px + 1) / w) * v.length));
    let mn = Infinity, mx = -Infinity;
    for (let i = a; i < b && i < v.length; i++) if (Number.isFinite(v[i])) { mn = Math.min(mn, v[i]); mx = Math.max(mx, v[i]); }
    if (mn <= mx) g.fillRect(px, y(mx), 1, Math.max(1, y(mn) - y(mx)));
  }
}

function show(k) {
  if (!shown.length) return;
  cur = Math.max(0, Math.min(shown.length - 1, k));
  const r = shown[cur], [label, color] = PHASES[r.phase];
  curRow = r.i;
  document.querySelector("#list .on")?.classList.remove("on");
  r.li.classList.add("on");
  r.li.scrollIntoView({ block: "nearest" });
  $("stage").textContent = `${r.group}  ›  ${label}  (rows ${r.span.start}–${r.span.end})`;
  $("stage").style.borderColor = color;
  $("title").textContent = `#${r.i + 1}  ${r.kernel}  (run ${r.run})  →  ${r.name}`;
  $("explain").textContent = explain(r);
  const s = stats(r.values);
  $("stats").textContent = `${r.type} · ${r.values.length} values copied of a ${kb(r.bytes)} buffer · min ${s.min.toPrecision(4)} · max ${s.max.toPrecision(4)} · mean ${s.mean.toPrecision(4)} · rms ${s.rms.toPrecision(4)}` + (s.bad ? ` · ${s.bad} NaN/inf` : "");
  plot(r.values, color);
  $("nums").textContent = Array.from(r.values.slice(0, 512), (x) => (Number.isInteger(x) ? x : x.toPrecision(4))).join("  ");
}

const li = (cls, text, color) => {
  const e = Object.assign(document.createElement("li"), { className: cls, textContent: text, title: text });
  if (color) e.style.setProperty("--c", color);
  return e;
};

function render() {
  const f = $("filter").value.toLowerCase();
  shown = all.filter((r) => !f || `${r.kernel} ${r.name} ${r.group} ${PHASES[r.phase][0]}`.toLowerCase().includes(f));
  const items = [];
  let g = null, p = null;
  shown.forEach((r, j) => {
    if (r.group !== g) {
      g = r.group; p = null;
      const [a, b] = groupRange[g];
      items.push(li("group", `${g}   rows ${a}–${b}`));
    }
    if (r.span !== p) {
      p = r.span;
      items.push(li("phase", `${PHASES[r.phase][0]}   rows ${r.span.start}–${r.span.end}`, PHASES[r.phase][1]));
    }
    r.li = li("row", `${r.i + 1}. ${r.kernel} (${r.run}) → ${r.name}`, PHASES[r.phase][1]);
    r.li.title = explain(r);
    r.li.onclick = () => show(j);
    items.push(r.li);
  });
  $("list").replaceChildren(...items);
  show(Math.max(0, shown.findIndex((r) => r.i >= curRow))); // stay on the same row when switching words
}

// pick which word of the reply to look at
function setWord(w) {
  word = Math.max(0, Math.min(steps.length - 1, w));
  const recs = steps[word], cls = classify(recs);
  all = recs.map((r, i) => ({ ...r, i, ...cls[i] }));
  groupRange = {};
  let span = null;
  for (const r of all) { // each group's and stage's row range (1-based)
    (groupRange[r.group] ??= [r.i + 1, r.i + 1])[1] = r.i + 1;
    if (!span || span.group !== r.group || span.phase !== r.phase) span = { group: r.group, phase: r.phase, start: r.i + 1 };
    span.end = r.i + 1;
    r.span = span;
  }
  // The model sees everything in its memory (KV cache), but only this pass's token(s) run through the layers:
  // earlier tokens reach them through attention, from the keys/values saved when they were read.
  const { pos, n } = data.at[word] ?? { pos: 0, n: 0 };
  const fed = data.tokens.slice(pos, pos + n).map((t) => t.text).join("");
  $("wordinfo").textContent = `Word ${word + 1} of ${steps.length}:  ${pos} tokens already in memory  +  run through the layers ${quote(fed)}  →  picked ${quote(words[word].text)}`;
  $("context").replaceChildren(...data.tokens.slice(0, pos + n).map((t, i) => {
    const e = Object.assign(document.createElement(i >= pos ? "mark" : "span"), { textContent: t.text, title: `token ${i + 1}: id ${t.id}` });
    if (i < pos) e.className = i % 2 ? "b" : "a";
    return e;
  }));
  $("context").scrollTop = $("context").scrollHeight;
  document.querySelector("#reply .on")?.classList.remove("on");
  $("reply").children[word].classList.add("on");
  $("reply").children[word].scrollIntoView({ block: "nearest", inline: "nearest" });
  showFilter();
  render();
}

// this word's probe score and its sentence's cascade verdict (computed in the background page; rule in probe.js)
const marked = (f, k) => {
  const v = f?.verdict[k];
  if (!v || !(f.smooth[k] > f.gate)) return "";
  return v.score > 0 ? "blocked" : v.margin !== undefined ? "cleared" : "";
};
function showFilter() {
  const f = data?.filter;
  if (!f) return ($("filterinfo").textContent = "No filter set.");
  const v = f.verdict[word];
  if (!v) return ($("filterinfo").textContent = `"${f.sentence}": no score for the last word (its state is never computed).`);
  $("filterinfo").className = v.score > 0 ? "blocked" : v.margin !== undefined ? "cleared" : "";
  const why = v.verdict === "clear" ? `probe peak ${v.peak.toFixed(1)} ≤ ${f.gate}, no judge needed`
    : v.verdict === "blocked" ? `probe certain: top-3 average ${v.top3.toFixed(1)} ≥ ${f.certain}`
    : `probe peak ${v.peak.toFixed(1)} + ${f.w} × judge ${v.margin.toFixed(1)} = ${v.ensemble.toFixed(1)} ${v.ensemble > f.t ? ">" : "≤"} ${f.t}`;
  $("filterinfo").textContent = `"${f.sentence}": this word ${f.smooth[word].toFixed(1)} · its sentence: ${v.verdict.toUpperCase()} (${why})`;
  $("filterinfo").title = "Probe: one dot product per word on layer 7, in units of ordinary text's spread, smoothed and averaged with the " +
    `next two words. Each sentence: probe peak ≤ ${f.gate} → clear; top-3 average ≥ ${f.certain} → blocked; otherwise Gemma ` +
    `judges the sentence alone (margin = logit Yes − logit No) and probe peak + ${f.w} × margin > ${f.t} blocks it.`;
}
const bg = browser.extension.getBackgroundPage();
$("filterText").value = bg?.filterSentence() ?? "";
$("setFilter").onclick = async () => {
  $("setFilter").disabled = true;
  $("filterinfo").textContent = "Reading the sentence through the model…";
  try { await bg.setFilter($("filterText").value.trim()); } // reloads this page when done
  catch (e) { $("filterinfo").textContent = "Failed: " + e.message; $("setFilter").disabled = false; }
};
$("filterText").addEventListener("keydown", (e) => e.key === "Enter" && $("setFilter").click());

if (!steps.length) {
  $("wordinfo").textContent = "No snapshot yet. In the Gemma popup turn Snapshot on, then send a message. This tab updates by itself.";
} else {
  $("reply").replaceChildren(...words.map((w, k) => {
    const s = Object.assign(document.createElement("span"), { textContent: w.text.replace(/\n/g, "↵"), title: `Word ${k + 1}: ${quote(w.text)} (id ${w.id})` });
    s.onclick = () => setWord(k);
    const m = marked(data.filter, k);
    if (m) s.classList.add(m);
    return s;
  }));
  // colour key: click a stage to show only that stage
  $("legend").replaceChildren(...Object.values(PHASES).map(([label, color]) => {
    const b = Object.assign(document.createElement("button"), { textContent: label, title: "Show only: " + label });
    b.style.setProperty("--c", color);
    b.onclick = () => { $("filter").value = $("filter").value === label ? "" : label; render(); };
    return b;
  }));
  $("filter").addEventListener("input", render);
  $("prev").onclick = () => setWord(word - 1);
  $("next").onclick = () => setWord(word + 1);
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return; // typing in the filter boxes
    const k = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key], w = { ArrowRight: 1, l: 1, ArrowLeft: -1, h: -1 }[e.key];
    if (k) { e.preventDefault(); show(cur + k); }
    if (w) { e.preventDefault(); setWord(word + w); }
  });
  addEventListener("resize", () => shown.length && show(cur));
  setWord(0);
}
