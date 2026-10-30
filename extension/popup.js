// Chat window only; the model lives in background.js, so closing the popup loses nothing.
const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect();
let current = null; // the assistant bubble being written

const add = (role, text) => {
  const d = Object.assign(document.createElement("div"), { className: `msg ${role}`, textContent: text });
  $("log").append(d);
  d.scrollIntoView();
  return d;
};
const setBusy = (busy) => { $("send").disabled = $("clear").disabled = busy; };

port.onMessage.addListener((m) => {
  if (m.type === "init") {
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
    current.scrollIntoView();
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
$("q").focus();
