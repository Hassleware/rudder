// Your 👍 / 👎: from each video's ⋮ menu ("Rudder: more / less like this") and YouTube's own like buttons, kept on
// your device. A video you rated is decided by your rating (the "your-clicks" stage), and a channel you've 👎 twice
// and never 👍 is hidden. Learning what else you'd dislike is left to apps, which get every rating with the video's
// record (bridge: WatchFeedback): Hull learns it with Gemma.
// Channels you light, from the ⋮ menu (removed in the popup): greenlit ones are never filtered, stoplit ones always
// hidden. A channel is on one list at most. A video you rated yourself still goes by your rating.
const STORE = "rudder-clicks-v1", OLD_STORES = ["rudder-learning-v2", "rudder-learning-v1"]; // the old learner's: its clicks are kept
const LIGHTS = { green: "rudder-greenlit-v1", stop: "rudder-stoplit-v1" };
const same = (a, b) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function createClicks(storage = globalThis.browser?.storage?.local) {
  let clicks = [], loaded = null, saveTimer = null; // clicks: { id, title, channel, like, at }, newest last
  const lit = { green: [], stop: [] }; // channel names, as YouTube writes them
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => storage?.set({ [STORE]: clicks }).catch(() => {}), 500); };
  const load = () => (loaded ??= (async () => {
    const got = (await storage?.get([STORE, ...Object.values(LIGHTS), ...OLD_STORES]).catch(() => ({}))) ?? {};
    const now = [...lit.green, ...lit.stop]; // lit while loading wins
    for (const k in LIGHTS) lit[k] = [...(got[LIGHTS[k]] ?? []).filter((c) => !now.some((g) => same(g, c))), ...lit[k]];
    const old = OLD_STORES.map((k) => got[k]?.examples).find(Boolean);
    const saved = got[STORE] ?? (old ?? []).map(({ id, title, channel, like, at }) => ({ id, title, channel, like, at }));
    const ids = new Set(clicks.map((x) => x.id)); // anything clicked while loading wins
    clicks = [...saved.filter((x) => !ids.has(x.id)), ...clicks];
    if (!got[STORE] && old) save();
  })());
  const channel = (ch) => { let up = 0, down = 0; if (ch) for (const x of clicks) if (x.channel === ch) x.like ? up++ : down++; return { up, down }; };
  const hiddenChannels = () => [...new Set(clicks.filter((x) => !x.like && x.channel).map((x) => x.channel))].filter((c) => { const s = channel(c); return s.down >= 2 && !s.up; });

  return {
    load,
    stats: () => ({ likes: clicks.filter((x) => x.like).length, dislikes: clicks.filter((x) => !x.like).length, channels: hiddenChannels(),
      greenlit: [...lit.green], stoplit: [...lit.stop] }),
    // a channel greenlit ("green"), stoplit ("stop") or neither (null)
    light(ch, kind) {
      ch = (ch ?? "").trim();
      if (!ch) return;
      for (const k in lit) lit[k] = lit[k].filter((c) => !same(c, ch));
      if (lit[kind]) lit[kind].push(ch);
      storage?.set(Object.fromEntries(Object.entries(LIGHTS).map(([k, key]) => [key, lit[k]]))).catch(() => {});
    },
    async feedback(v, like) {
      await load();
      clicks = clicks.filter((x) => x.id !== v.id);
      clicks.push({ id: v.id, title: v.title ?? "", channel: v.channel ?? "", like, at: Date.now() });
      if (clicks.length > 5000) clicks.splice(0, clicks.length - 5000);
      save();
    },
    forget() { clicks = []; save(); },
    has: (id) => clicks.some((x) => x.id === id),
    // what your ratings say about this video: { verdict: "hide" | "show" | null, why }
    judge(v) {
      const own = clicks.find((x) => x.id === v.id);
      if (own) return { verdict: own.like ? "show" : "hide", why: own.like ? "you liked it" : "you disliked it" };
      if (v.channel && lit.stop.some((c) => same(c, v.channel))) return { verdict: "hide", why: "a channel you stoplit" };
      if (v.channel && lit.green.some((c) => same(c, v.channel))) return { verdict: "show", why: "a channel you greenlit" };
      const ch = channel(v.channel);
      if (ch.down >= 2 && !ch.up) return { verdict: "hide", why: "a channel you disliked" };
      return { verdict: null };
    },
  };
}
