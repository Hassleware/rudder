// Your 👍 / 👎: from each video's ⋮ menu ("Rudder: more / less like this") and YouTube's own like buttons, kept on
// your device. A video you rated is decided by your rating (the "your-clicks" stage), and a channel you've 👎 twice
// and never 👍 is hidden. Learning what else you'd dislike is left to apps, which get every rating with the video's
// record (bridge: WatchFeedback): Hull learns it with Gemma.
const STORE = "rudder-clicks-v1", OLD_STORES = ["rudder-learning-v2", "rudder-learning-v1"]; // the old learner's: its clicks are kept

export function createClicks(storage = globalThis.browser?.storage?.local) {
  let clicks = [], loaded = null, saveTimer = null; // clicks: { id, title, channel, like, at }, newest last
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => storage?.set({ [STORE]: clicks }).catch(() => {}), 500); };
  const load = () => (loaded ??= (async () => {
    const got = (await storage?.get([STORE, ...OLD_STORES]).catch(() => ({}))) ?? {};
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
    stats: () => ({ likes: clicks.filter((x) => x.like).length, dislikes: clicks.filter((x) => !x.like).length, channels: hiddenChannels() }),
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
      const ch = channel(v.channel);
      if (ch.down >= 2 && !ch.up) return { verdict: "hide", why: "a channel you disliked" };
      return { verdict: null };
    },
  };
}
