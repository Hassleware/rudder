// Scores the shipped filter in the background page (which has the model) and shows the results per filter.
const $ = (id) => document.getElementById(id);
const pct = (x) => (100 * x).toFixed(0) + "%";

function show(r) {
  $("log").textContent += `\nDone in ${r.seconds} s.`;
  const head = ["filter", "AUROC", "direct hit", "indirect hit", "look-alike fire", "other-topic fire", "ordinary fire", "mixed: fired early", "mixed: sentences to fire"];
  const tr = (cells, tag = "td") => { const e = document.createElement("tr"); for (const c of cells) e.append(Object.assign(document.createElement(tag), { textContent: c })); return e; };
  const rows = [];
  for (const [split, title] of [["dev", "Dev filters (the research chose the method on these)"], ["test", "Held-out filters (never used to choose anything)"]]) {
    rows.push(tr([title], "th"), tr(head, "th"));
    for (const f of r[split]) rows.push(tr([f.filter, f.auroc.toFixed(3), pct(f.direct), pct(f.indirect), pct(f.hardNeg), pct(f.cross), pct(f.benign), f.mixed[0].early ? "yes" : "no", f.mixed[0].delay]));
  }
  $("out").replaceChildren(...rows);
}

// long-text test: false alarms and judge calls over the pages, and whether each hidden needle was blocked
function showHay(r) {
  $("log").textContent += `\nDone in ${r.seconds} s.`;
  const tr = (cells, tag = "td") => { const e = document.createElement("tr"); for (const c of cells) e.append(Object.assign(document.createElement(tag), { textContent: c })); return e; };
  const cell = (n) => `${n.caught ? "BLOCKED" : "missed"} (${n.verdict}, peak ${n.peak?.toFixed(1) ?? "–"}${n.margin !== undefined ? `, judge ${n.margin.toFixed(1)}` : ""})`;
  const share = (kind) => { const ns = r.needles.filter((n) => n.kind === kind); return `${ns.filter((n) => n.caught).length}/${ns.length}`; };
  const rows = [
    tr([`Blocked: passing mentions ${share("mention")}, on-topic sentences ${share("direct")}, look-alikes ${share("look-alike")}.`], "th"),
    tr(["Hidden needle (verdict for its sentence)"], "th"), tr(["filter", "mention 1", "mention 2", "on-topic sentence", "look-alike"], "th"),
  ];
  for (const f of r.quiet.map((q) => q.filter)) rows.push(tr([f, ...r.needles.filter((n) => n.filter === f).map(cell)]));
  rows.push(tr([`The pages alone, no needle (${r.quiet[0].words} words)`], "th"), tr(["filter", "sentences blocked", "judge calls", "judge calls per 1000 words"], "th"));
  for (const q of r.quiet) rows.push(tr([q.filter, q.blocked, q.judged, (1000 * q.judged / q.words).toFixed(1)]));
  $("out").replaceChildren(...rows);
}

for (const [id, fn, view] of [["go", "runBench", show], ["hay", "runHaystack", showHay]]) {
  $(id).onclick = async () => {
    $("go").disabled = $("hay").disabled = true;
    $("log").textContent = "Running…";
    try {
      view(await browser.extension.getBackgroundPage()[fn]((m) => ($("log").textContent += "\n" + m)));
    } catch (e) {
      $("log").textContent += "\nFailed: " + e.message;
    }
    $("go").disabled = $("hay").disabled = false;
  };
}
