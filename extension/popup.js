// The toolbar popup: Rudder's statistics, and the filter list (add, remove). Everything lives in background.js.
const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect();
let filters = [], related = new Set(), shown = "";
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
// each filter with its switch: exact (its words as written) or related (and words tied to them)
const save = (list) => port.postMessage({ type: "set-filters", filters: list.map((f) => (typeof f === "object" ? f : { sentence: f, related: related.has(f) })) });
const fill = (ul, items) => ul.replaceChildren(...(items.length ? items : [el("li", "empty", "—")]));

function render(state) {
  const s = state.stats, l = s.learning ?? {};
  $("on").setAttribute("aria-pressed", String(state.enabled));
  $("off").setAttribute("aria-pressed", String(!state.enabled));
  $("switch-label").textContent = state.enabled ? "FILTERING" : "OFF: YOUTUBE AS IT COMES";
  document.body.classList.toggle("off", !state.enabled);
  $("checked").textContent = s.checked;
  $("hidden").textContent = s.hidden;
  $("rate").textContent = s.checked ? `${Math.round((100 * s.hidden) / s.checked)}%` : "0%";
  $("likes").textContent = l.likes ?? 0;
  $("dislikes").textContent = l.dislikes ?? 0;
  $("model").textContent = (l.channels ?? []).length;

  filters = state.filters;
  related = new Set(state.related ?? []);
  const top = Math.max(1, ...filters.map((f) => s.by[f] ?? 0));
  const key = JSON.stringify([filters, state.related, s.by, state.stages, s.byStage, state.waiting, l.greenlit]);
  if (key === shown) return; // unchanged: don't rebuild under the cursor
  shown = key;
  // the pipeline's stages in order (apps can change them), each with how many videos it hid
  const most = Math.max(1, ...(state.stages ?? []).map((id) => s.byStage?.[id] ?? 0));
  fill($("stages"), (state.stages ?? []).map((id) => {
    const li = el("li"), bar = el("div", "bar"), w = (state.waiting ?? []).find((x) => x.id === id);
    if (w) { li.classList.add("waiting"); li.classList.toggle("hides", w.hides); }
    bar.style.width = `${(100 * (s.byStage?.[id] ?? 0)) / most}%`;
    const name = el("span", "name", id);
    if (w) name.dataset.app = w.app;
    li.append(bar, name, el("span", "n", s.byStage?.[id] ?? 0));
    return li;
  }));
  fill($("list"), filters.map((f) => {
    const li = el("li"), bar = el("div", "bar"), del = el("button", "", "×"), on = related.has(f);
    const mode = el("button", "mode", on ? "+RELATED" : "EXACT");
    mode.setAttribute("aria-pressed", String(on));
    mode.title = on ? "Also hides words tied to it: click for these words only" : "Hides these words only: click to also hide words tied to it";
    mode.addEventListener("click", () => save(filters.map((x) => ({ sentence: x, related: x === f ? !on : related.has(x) }))));
    bar.style.width = `${(100 * (s.by[f] ?? 0)) / top}%`;
    del.setAttribute("aria-label", `Remove ${f}`);
    del.addEventListener("click", () => save(filters.filter((x) => x !== f)));
    li.append(bar, el("span", "name", f), el("span", "n", s.by[f] ?? 0), mode, del);
    return li;
  }));
  fill($("greenlit"), (l.greenlit ?? []).map((c) => {
    const li = el("li"), del = el("button", "", "×");
    del.setAttribute("aria-label", `Stop greenlighting ${c}`);
    del.addEventListener("click", () => port.postMessage({ type: "rudder-greenlight", channel: c, on: false }));
    li.append(el("span", "name", c), del);
    return li;
  }));
  fill($("channels"), (l.channels ?? []).map((c) => { const li = el("li"); li.append(el("span", "name", c)); return li; }));
  fill($("recent"), (state.recent ?? []).slice(0, 25).map((v) => { const li = el("li"); li.append(el("span", "name", v.title), el("span", "why", v.why.replace(/ \(.*\)$/, ""))); return li; }));
}

for (const [b, on] of [["on", true], ["off", false]]) $(b).addEventListener("click", () => port.postMessage({ type: "set-enabled", enabled: on }));
$("add").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("new").value.trim();
  if (!v) return;
  $("new").value = "";
  save([...filters, v]);
});
// apps' panels (panel.js), redrawn only when they change
let panelsShown = "";
function renderPanels(list = []) {
  const key = JSON.stringify(list);
  if (key === panelsShown) return;
  panelsShown = key;
  $("panels").replaceChildren(...list.map((p) => renderPanel(p, (panel, button) => port.postMessage({ type: "panel-click", panel, button }))));
  // connected apps that sent an icon: shown at the top while their panel is up
  $("apps").replaceChildren(...list.filter((p) => p.icon && p.icon.length < 20000).map((p) => {
    const chip = el("span", "app"), img = el("img");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(p.icon);
    img.alt = "";
    chip.title = `${p.title || p.id} is connected`;
    chip.append(img, el("span", "", `${p.title || p.id} connected`));
    return chip;
  }));
}
port.onMessage.addListener((m) => { if (m.type === "filters") { render(m); renderPanels(m.panels); } });
const poll = setInterval(() => port.postMessage({ type: "filters" }), 1500); // live numbers while open
addEventListener("unload", () => clearInterval(poll));
