# Rudder test set, step 2: merge the sources into one labelled set (hide / show under the 31 default filters).
#   search.json  YouTube searches per filter topic and per harmless topic (collect.py), with hand fixes below
#   user/        the user's screenshot (2026-10-31): their own verdicts
#   tbench/      the earlier thumbnail benchmark (research/thumbs, removed since; in git history), relabelled under the default filters
# Every item gets a dev/test split (alternating within each source+label) so thresholds are tuned on dev only.
# Usage: python build.py <scratch dir with testset/, vision/user/, vision/tbench/>
import json, os, shutil, sys

S = sys.argv[1]
OUT = os.path.join(S, "testset")
img = lambda *p: os.path.join(S, *p)
items = []

# --- searches, with hand fixes where the video isn't what the query was after ---
FIX = {  # title start → (label, filter)
    "WORLD CHAMPION (Full Documentary)": ("show", None),
    "24/7 halloween ambience": ("hide", "anything scary, horror or disturbing"),
    "Angry Puppies Are TOO Funny": ("show", None),
    "Software Engineer's Modern & Minimal Apartment": ("hide", "anything about tech companies, coding or cyber security"),
    "SUNDAY RESET ROUTINE MARATHON": ("show", None),
}
for x in json.load(open(os.path.join(OUT, "search.json"), encoding="utf-8")):
    for start, (label, f) in FIX.items():
        if x["title"].startswith(start) or start in x["title"]:
            x["label"], x["filter"] = label, f
    items.append({"id": x["id"], "title": x["title"], "channel": x["channel"], "image": f"img/{x['id']}.jpg", "label": x["label"], "filter": x["filter"], "source": "search", "group": x["query"]})

# --- the user's screenshot ---
for u in json.load(open(img("vision", "user", "index.json"), encoding="utf-8")):
    shutil.copy(img("vision", "user", u["key"] + ".jpg"), os.path.join(OUT, "img", "user-" + u["key"] + ".jpg"))
    items.append({"id": "user-" + u["key"], "title": u["title"], "channel": u["channel"], "image": f"img/user-{u['key']}.jpg", "label": "hide" if u["want"] == "must" else "show", "filter": None, "source": "screenshot", "group": u["key"]})

# --- thumbnail benchmark: topic → the default filter that covers it (None: not covered → show) ---
TOPIC = {"gambling": "anything about gambling, betting or casinos", "crypto": "anything about gambling, betting or casinos",
         "guns": "anything violent, angry, mean or offensive", "illness": "anything about illness, disease or health scares"}
LOOK = {  # look-alikes that the default filters DO cover
    "gambling": "anything about jobs, stocks, the rich or the poor",          # stock market investing
    "dogs": "anything about binge eating, junk food or food challenges",      # hot dog eating contest
    "cooking": "anything about crime, scams or true crime",                   # cooking the books (fraud)
}
ORD_HIDE = {"Software Engineer": "anything about tech companies, coding or cyber security", "Tesla": "anything about tech companies, coding or cyber security"}
for x in json.load(open(img("vision", "tbench", "all.json"), encoding="utf-8")):
    k, f = x["kind"], None
    if k in ("pos", "text"): f = TOPIC.get(x["topic"])
    elif k == "look": f = LOOK.get(x["topic"])
    else: f = next((v for s, v in ORD_HIDE.items() if s in (x.get("title") or "")), None)
    synthetic = k.startswith("text")  # words rendered on a plain background: the title would give it away, so it gets a neutral one
    shutil.copy(img("vision", "tbench", "img", x["key"] + ".jpg"), os.path.join(OUT, "img", "tb-" + x["key"] + ".jpg"))
    items.append({"id": "tb-" + x["key"], "title": "My weekend vlog" if synthetic else x.get("title") or "My weekend vlog", "channel": "", "image": f"img/tb-{x['key']}.jpg",
                  "label": "hide" if f else "show", "filter": f, "source": "tbench-" + k, "group": x.get("topic") or k,
                  "gemmaCalibration": x.get("split") == "calib" or k in ("ordinary", "text-neutral")})  # in Rudder's calib/ (all 40 ordinary)

# dev/test split: alternate within each source+label
count = {}
for x in items:
    key = (x["source"], x["label"])
    count[key] = count.get(key, 0) + 1
    x["split"] = "dev" if count[key] % 2 else "test"
if True:  # the screenshot is the user's own: always test
    for x in items:
        if x["source"] == "screenshot": x["split"] = "test"
json.dump(items, open(os.path.join(OUT, "items.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
from collections import Counter
print(len(items), "items:", dict(Counter((x["split"], x["label"]) for x in items)))
print(dict(Counter(x["source"] for x in items)))
