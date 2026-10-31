// The toolbar popup: YouTube filtering on/off, your algorithm, and your filter sentences (as many as you like).
// Everything lives in background.js; closing the popup loses nothing.
const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect();
let filters = [];

// ---- filters ----
const save = (list) => port.postMessage({ type: "set-filters", filters: list });
function renderLearning(state) {
  const l = state.stats.learning ?? { likes: 0, dislikes: 0 };
  $("learned").textContent = !l.likes && !l.dislikes ? "Nothing yet. Your likes and dislikes make Rudder yours."
    : `Learned from ${l.likes} liked and ${l.dislikes} disliked${l.learning ? ", and it now hides videos like the ones you disliked" : " (it starts predicting after 3 dislikes and a few videos you were fine with)"}${l.channels?.length ? ` · channels hidden: ${l.channels.slice(0, 3).join(", ")}${l.channels.length > 3 ? "…" : ""}` : ""}.`;
  if (document.activeElement?.closest?.("#recent")) return;
  $("recent").replaceChildren(...(state.recent ?? []).slice(0, 25).map((v) => {
    const li = document.createElement("li"), what = document.createElement("div"), t = document.createElement("div"), why = document.createElement("div"), up = document.createElement("button");
    what.className = "what"; t.className = "t"; why.className = "why"; li.dataset.id = v.id;
    t.textContent = v.title; t.title = `${v.title}${v.channel ? " — " + v.channel : ""}`;
    why.textContent = v.why || "hidden";
    Object.assign(up, { title: "It was fine: show it, and learn from it" });
    up.append(rudder(true), "Fine");
    up.addEventListener("click", () => { up.disabled = true; port.postMessage({ type: "rudder-like", id: v.id }); });
    what.append(t, why); li.append(what, up);
    return li;
  }));
}
// the rudder from Rudder's icon: blue, tiller up = more like this; red, upside down = less like this
function rudder(like) {
  const ns = "http://www.w3.org/2000/svg", el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const s = el("svg", { viewBox: "-13 0 124 124", width: "14", height: "14", fill: like ? "#5BB8F0" : "#E5484D", "aria-hidden": "true" }), g = el("g", like ? {} : { transform: "rotate(180 49 62)" });
  g.append(el("rect", { x: 14, y: 0, width: 8, height: 14, rx: 1 }), el("rect", { x: 8, y: 12, width: 22, height: 8, rx: 2 }),
    el("path", { "fill-rule": "evenodd", d: "M10 22 H30 C52 22 72 16 84 6 Q90 2 90 10 C90 52 76 96 48 118 Q42 124 34 124 H10 Z M29 40 H37 C49 40 59 37 67 33 C66 60 57 85 37 102 H29 Z" }));
  s.append(g);
  return s;
}
// popups can't show confirm(): a second click within 4 s confirms
let forgetArmed = 0;
$("forget").addEventListener("click", () => {
  if (Date.now() - forgetArmed < 4000) { forgetArmed = 0; $("forget").textContent = "Forgotten"; port.postMessage({ type: "rudder-forget" }); return; }
  forgetArmed = Date.now();
  $("forget").textContent = "Click again to forget every like and dislike";
  setTimeout(() => { if (forgetArmed && Date.now() - forgetArmed >= 4000) $("forget").textContent = "Forget everything it learned"; }, 4100);
});
function renderFilters(state) {
  renderLearning(state);
  $("enabled").checked = state.enabled;
  document.body.classList.toggle("off", !state.enabled);
  const s = state.stats;
  $("stats").textContent = !state.filters.length ? "Add a filter below to start hiding videos."
    : !state.enabled ? "Filtering is off: YouTube shows everything."
    : `${s.checked} video${s.checked === 1 ? "" : "s"} checked this session · ${s.hidden} hidden${s.waiting ? ` · checking ${s.waiting} more…` : ""}`;
  // don't rebuild the list under the user's cursor; just refresh the counts
  const same = state.filters.length === filters.length && state.filters.every((f, i) => f === filters[i]);
  filters = state.filters;
  if (same && $("list").children.length === filters.length) {
    [...$("list").children].forEach((li, i) => { li.querySelector(".count").textContent = countText(s.by[filters[i]]); });
    return;
  }
  $("list").replaceChildren(...filters.map((f, i) => {
    const li = document.createElement("li"), input = document.createElement("input"), count = document.createElement("span"), del = document.createElement("button");
    Object.assign(input, { value: f, maxLength: 200, title: "Edit, then press Enter" });
    input.setAttribute("aria-label", `Filter ${i + 1}`);
    const commit = () => {
      const v = input.value.trim();
      if (v === f) return;
      save(v ? filters.map((x, k) => (k === i ? v : x)) : filters.filter((_, k) => k !== i));
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.value = f; input.blur(); } });
    input.addEventListener("change", commit);
    count.className = "count";
    count.textContent = countText(s.by[f]);
    Object.assign(del, { className: "del", textContent: "×", title: "Remove this filter" });
    del.setAttribute("aria-label", `Remove "${f}"`);
    del.addEventListener("click", () => save(filters.filter((_, k) => k !== i)));
    li.append(input, count, del);
    return li;
  }));
}
const countText = (n) => (n ? `${n} hidden` : "");
$("add").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("new").value.trim();
  if (!v) return;
  $("new").value = "";
  save([...filters, v]);
});
$("enabled").addEventListener("change", () => port.postMessage({ type: "set-filters", enabled: $("enabled").checked }));
const poll = setInterval(() => port.postMessage({ type: "filters" }), 1500); // live counts while open
addEventListener("unload", () => clearInterval(poll));

port.onMessage.addListener((m) => {
  if (m.type === "filters") renderFilters(m);
  else if (m.type === "status") $("status").textContent = m.text;
});
$("new").focus();
