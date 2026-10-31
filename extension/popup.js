// The toolbar popup: model status and setup, YouTube filtering on/off, and the user's filter sentences (as many as
// they like). Everything lives in background.js; closing the popup loses nothing.
const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect();
let current = null; // the assistant bubble being written
let filters = [];

// ---- filters ----
const save = (list) => port.postMessage({ type: "set-filters", filters: list });
function renderFilters(state) {
  $("enabled").checked = state.enabled;
  document.body.classList.toggle("off", !state.enabled);
  const s = state.stats;
  $("stats").textContent = !state.filters.length ? "Add a filter below to start hiding videos."
    : !state.enabled ? "Filtering is off: YouTube shows everything."
    : `${s.checked} video${s.checked === 1 ? "" : "s"} checked this session · ${s.hidden} hidden`;
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
  else if (m.type === "init") { $("status").textContent = m.status; $("setup").hidden = !m.setup; }
  else if (m.type === "status") $("status").textContent = m.text;
});

$("download").addEventListener("click", () => port.postMessage({ type: "load" }));
// File pickers close popups in Firefox, so importing happens in its own tab.
$("import").addEventListener("click", () => { browser.tabs.create({ url: "import.html" }); window.close(); });
$("new").focus();
