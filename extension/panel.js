// Rudder's mini UI framework: apps show panels in the popup (bridge: SetPanel). A panel is an id, a title and a list of
// blocks; each block has one kind, and each kind has a renderer here. Text only (textContent), never HTML.
// A new kind: add a renderer to KINDS, and the matching field to Block in bridge/rudder.proto.
const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

const KINDS = {
  // a line of text
  text: (t) => h("p", "ptext", t),
  // big numbers in the same grid as Rudder's own statistics
  stats: ({ stats = [] }) => {
    const g = h("div", "grid");
    for (const s of stats) { const c = h("div", "cell"); c.append(h("div", "num", s.value ?? ""), h("div", "lbl", s.label ?? "")); g.append(c); }
    return g;
  },
  // labelled bars, scaled to the largest value
  bars: ({ bars = [] }) => {
    const ul = h("ul"), top = Math.max(1e-9, ...bars.map((b) => b.value ?? 0));
    for (const b of bars) {
      const li = h("li"), bar = h("div", "bar");
      bar.style.width = `${(100 * (b.value ?? 0)) / top}%`;
      li.append(bar, h("span", "name", b.label ?? ""), h("span", "n", String(+(b.value ?? 0).toFixed(2))));
      ul.append(li);
    }
    return ul;
  },
  table: ({ columns = [], rows = [] }) => {
    const t = h("table", "ptable"), head = h("tr");
    for (const c of columns) head.append(h("th", "", c));
    if (columns.length) t.append(head);
    for (const r of rows) { const tr = h("tr"); for (const c of r.cells ?? []) tr.append(h("td", "", c)); t.append(tr); }
    return t;
  },
  // clicks reach the app on PanelEvents, with this label
  button: (label, click) => { const b = h("button", "pbutton", label); b.addEventListener("click", () => click(label)); return b; },
};

// panel → element; click(panelId, buttonLabel)
function renderPanel(p, click) {
  const sec = h("section", "panel");
  sec.append(h("h2", "", p.title || p.id));
  for (const block of p.blocks ?? []) {
    const [kind, value] = Object.entries(block)[0] ?? [];
    sec.append(KINDS[kind] ? KINDS[kind](value, (label) => click(p.id, label)) : h("p", "ptext", `unknown block: ${kind}`));
  }
  return sec;
}
