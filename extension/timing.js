// Rudder times every stage (ms). Apps read them with the bridge's GetTimings; tests/*-check.mjs can import timings().
// Percentiles are over each stage's newest 500 runs; count, mean and max are since the last reset.
const stages = new Map(); // name → { n, sum, max, last, recent: [] }

export function record(name, ms) {
  let s = stages.get(name);
  if (!s) stages.set(name, (s = { n: 0, sum: 0, max: 0, last: 0, recent: [] }));
  s.n++; s.sum += ms; s.max = Math.max(s.max, ms); s.last = ms;
  s.recent.push(ms);
  if (s.recent.length > 500) s.recent.shift();
}

// time an async (or plain) function under a stage name
export async function timed(name, fn) {
  const t = performance.now();
  try { return await fn(); } finally { record(name, performance.now() - t); }
}

export function timings(reset = false) {
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const out = [...stages].map(([name, s]) => {
    const sorted = [...s.recent].sort((a, b) => a - b);
    return { name, count: s.n, mean: s.sum / s.n, p50: pct(sorted, 50), p95: pct(sorted, 95), max: s.max, last: s.last };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (reset) stages.clear();
  return out;
}
