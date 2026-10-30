// The toolbar popup: model status and setup, YouTube filtering on/off, the user's filter sentences (as many as they
// like), and a chat with the model. Everything lives in background.js; closing the popup loses nothing.
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

// ---- chat ----
const add = (role, text) => {
  const d = Object.assign(document.createElement("div"), { className: `msg ${role}`, textContent: text });
  $("log").append(d);
  d.scrollIntoView({ block: "nearest" });
  return d;
};
const setBusy = (busy) => { $("send").disabled = $("clear").disabled = busy; };

port.onMessage.addListener((m) => {
  if (m.type === "filters") renderFilters(m);
  else if (m.type === "init") {
    $("log").replaceChildren();
    for (const h of m.history) add(h.role, h.content);
    current = m.partial !== null ? add("assistant", m.partial) : null;
    setBusy(m.partial !== null);
    $("status").textContent = m.status;
    $("setup").hidden = !m.setup;
    $("snap").textContent = m.snapOn ? "Snapshot: on" : "Snapshot: off";
    $("snap").classList.toggle("on", m.snapOn);
  } else if (m.type === "status") {
    $("status").textContent = m.text;
  } else if (m.type === "user") {
    add("user", m.text);
    current = add("assistant", "");
    setBusy(true);
  } else if (m.type === "delta") {
    current.textContent += m.text;
    current.scrollIntoView({ block: "nearest" });
  } else if (m.type === "error") {
    current?.remove();
    add("error", "Error: " + m.text);
  } else if (m.type === "done") {
    current = null;
    setBusy(false);
    $("q").focus();
  }
});

$("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("q").value.trim();
  if (!text || $("send").disabled) return;
  $("q").value = "";
  port.postMessage({ type: "send", text });
});
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("f").requestSubmit(); }
});
$("clear").addEventListener("click", () => port.postMessage({ type: "clear" }));
$("snap").addEventListener("click", () => port.postMessage({ type: "snapshot" }));
$("download").addEventListener("click", () => port.postMessage({ type: "load" }));
// File pickers close popups in Firefox, so importing happens in its own tab.
$("import").addEventListener("click", () => { browser.tabs.create({ url: "import.html" }); window.close(); });
$("new").focus();
