# Usage: python collect.py <out dir>
# Collect YouTube thumbnails for the thumbnail benchmark: search results per query -> mqdefault.jpg (320x180).
import json, os, re, sys, time, urllib.parse, urllib.request

OUT = sys.argv[1]  # output folder (img/ and real.json go here)
os.makedirs(os.path.join(OUT, "img"), exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"}

POS = {  # on-topic: 4 each
    "bees": "honey bee hive beekeeping", "guns": "rifle shooting range", "crypto": "bitcoin price analysis",
    "cooking": "pasta recipe cooking", "football": "premier league highlights", "dogs": "puppy training",
    "ocean": "ocean documentary marine life", "gambling": "casino slot machine", "illness": "flu symptoms doctor",
    "space": "nasa rocket launch",
}
LOOK = {  # look-alikes: 3 each
    "bees": "spelling bee competition", "guns": "glue gun craft ideas", "crypto": "catacombs crypt tour",
    "cooking": "accounting fraud cooking the books", "football": "american football nfl highlights",
    "dogs": "hot dog eating contest", "ocean": "lake swimming", "gambling": "stock market investing",
    "illness": "gym workout routine", "space": "space saving storage ideas",
}
ORD = [  # ordinary: 3 each; the first 5 queries calibrate, the last 5 test
    "home office desk setup", "how to fold clothes", "piano tutorial beginner", "excel tutorial", "car review",
    "learn spanish lesson", "room makeover", "city walking tour", "knitting tutorial", "budget travel tips",
]

def search(q):
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(q)
    html = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "replace")
    seen = []
    for m in re.finditer(r'"videoRenderer":\{"videoId":"([\w-]{11})".{0,3000}?"title":\{"runs":\[\{"text":"(.*?)"\}', html):
        if m.group(1) not in [v for v, _ in seen]:
            seen.append((m.group(1), json.loads('"' + m.group(2) + '"')))
    return seen

items, used = [], set()
def take(q, n, **meta):
    got = 0
    for vid, title in search(q):
        if vid in used: continue
        try:
            data = urllib.request.urlopen(urllib.request.Request(f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg", headers=UA), timeout=30).read()
        except Exception:
            continue
        open(os.path.join(OUT, "img", vid + ".jpg"), "wb").write(data)
        used.add(vid); got += 1
        items.append({"key": vid, "query": q, "title": title, **meta})
        if got == n: break
    print(f"{q}: {got}", file=sys.stderr)
    time.sleep(0.5)

for t, q in POS.items(): take(q, 4, kind="pos", topic=t)
for t, q in LOOK.items(): take(q, 3, kind="look", topic=t)
for i, q in enumerate(ORD): take(q, 3, kind="ordinary", topic=None, split="calib" if i < 5 else "test")
json.dump(items, open(os.path.join(OUT, "real.json"), "w"), indent=1)
print(len(items), "thumbnails")
