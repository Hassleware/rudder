// The toolbar popup: Rudder's statistics, and the filter list (add, remove). Everything lives in background.js.
const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect();
let filters = [], shown = "";
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const save = (list) => port.postMessage({ type: "set-filters", filters: list });
const fill = (ul, items) => ul.replaceChildren(...(items.length ? items : [el("li", "empty", "—")]));

function render(state) {
  const s = state.stats, l = s.learning ?? {};
  $("checked").textContent = s.checked;
  $("hidden").textContent = s.hidden;
  $("rate").textContent = s.checked ? `${Math.round((100 * s.hidden) / s.checked)}%` : "0%";
  $("likes").textContent = l.likes ?? 0;
  $("dislikes").textContent = l.dislikes ?? 0;
  $("model").textContent = l.learning ? "on" : `${Math.min(l.dislikes ?? 0, 3)}/3`; // starts after 3 dislikes

  filters = state.filters;
  const top = Math.max(1, ...filters.map((f) => s.by[f] ?? 0));
  const key = JSON.stringify([filters, s.by]);
  if (key === shown) return; // unchanged: don't rebuild under the cursor
  shown = key;
  fill($("list"), filters.map((f) => {
    const li = el("li"), bar = el("div", "bar"), del = el("button", "", "×");
    bar.style.width = `${(100 * (s.by[f] ?? 0)) / top}%`;
    del.setAttribute("aria-label", `Remove ${f}`);
    del.addEventListener("click", () => save(filters.filter((x) => x !== f)));
    li.append(bar, el("span", "name", f), el("span", "n", s.by[f] ?? 0), del);
    return li;
  }));
  fill($("channels"), (l.channels ?? []).map((c) => { const li = el("li"); li.append(el("span", "name", c)); return li; }));
  fill($("recent"), (state.recent ?? []).slice(0, 25).map((v) => { const li = el("li"); li.append(el("span", "name", v.title), el("span", "why", v.why.replace(/ \(.*\)$/, ""))); return li; }));
}

$("add").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("new").value.trim();
  if (!v) return;
  $("new").value = "";
  save([...filters, v]);
});
port.onMessage.addListener((m) => { if (m.type === "filters") render(m); });
const poll = setInterval(() => port.postMessage({ type: "filters" }), 1500); // live numbers while open
addEventListener("unload", () => clearInterval(poll));
