# Rudder test set, step 1: YouTube search results (title, channel, thumbnail) for topics the default filters should
# hide and topics they should leave alone. A query's topic is its label (some noise: a search can return off-topic
# videos). Downloads public thumbnails (mqdefault.jpg, 320x180) once; research only, not part of the extension.
# Usage: python collect.py <out dir>   → <out>/img/<id>.jpg and <out>/search.json
import json, os, re, sys, time, urllib.parse, urllib.request

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, "img"), exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", "Accept-Language": "en-GB,en;q=0.9"}
PER = 5

# query → the default filter it should trigger
HIDE = {
    "celebrity dies aged": "anything about news, war or death",
    "breaking news today": "anything about news, war or death",
    "ukraine war frontline footage": "anything about news, war or death",
    "minecraft speedrun world record": "anything about video games",
    "overwatch 2 gameplay": "anything about video games",
    "league of legends montage": "anything about video games",
    "video game soundtrack ost": "anything about video games",
    "chatgpt new update": "anything about AI",
    "ai will replace programmers": "anything about AI",
    "big tech layoffs": "anything about jobs, stocks, the rich or the poor",
    "stock market crash explained": "anything about jobs, stocks, the rich or the poor",
    "street fight caught on camera": "anything violent, angry, mean or offensive",
    "the world is ending documentary": "anything depressing, doom inducing, mood ruining or about the future",
    "sad story that will make you cry": "anything depressing, doom inducing, mood ruining or about the future",
    "sigma male motivation edit": "anything motivational",
    "presidential debate highlights": "anything about politics, elections or politicians",
    "true crime documentary": "anything about crime, scams or true crime",
    "earthquake caught on camera": "anything about disasters, accidents or emergencies",
    "my cancer journey vlog": "anything about illness, disease or health scares",
    "youtuber exposed drama": "anything about drama, controversy or someone being exposed",
    "scary videos you should not watch alone": "anything scary, horror or disturbing",
    "weight loss transformation": "anything about dieting, weight loss or body image",
    "conspiracy theories explained": "anything about conspiracies or culture wars",
    "animal rescue heartbreaking": "anything about animal cruelty or suffering",
    "storytime my boyfriend cheated": "anything about breakups, cheating or toxic relationships",
    "climate change crisis": "anything about the climate or pollution",
    "beer tasting review": "anything about alcohol or drinking",
    "vape review": "anything about drugs, cigarettes or vaping",
    "casino slots big win": "anything about gambling, betting or casinos",
    "mukbang eating challenge": "anything about binge eating, junk food or food challenges",
    "huge clothing haul": "anything about shopping, spending or hauls",
    "sobriety journey one year sober": "anything about addiction, relapse or withdrawal",
    "eating disorder recovery story": "anything about self-harm, suicide or eating disorders",
}
SHOW = ["vegetable soup recipe", "woodworking project", "knitting for beginners", "piano tutorial easy song",
        "birds of britain nature", "japan travel vlog", "watercolour painting tutorial", "lofi hip hop radio",
        "chess opening tutorial", "gardening tips spring", "origami tutorial", "house cleaning routine",
        "yoga for beginners", "lego build", "car detailing satisfying", "calligraphy for beginners",
        "cute puppies compilation", "science experiments for kids", "learn french lesson", "bread baking at home",
        "pottery wheel throwing", "hiking scotland", "astronomy for beginners telescope", "bike repair how to",
        "minimalist apartment tour"]

def search(q):
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(q) + "&hl=en&gl=GB"
    html = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'"videoRenderer":\{"videoId":"([\w-]{11})"(.{0,6000}?)"title":\{"runs":\[\{"text":"(.*?)"\}', html):
        vid, mid, title = m.group(1), m.group(2), json.loads('"' + m.group(3) + '"')
        ch = re.search(r'"ownerText":\{"runs":\[\{"text":"(.*?)"', html[m.end():m.end() + 6000])
        if vid not in [v["id"] for v in out]:
            out.append({"id": vid, "title": title, "channel": json.loads('"' + ch.group(1) + '"') if ch else ""})
    return out

items, used = [], set()
def take(q, label, filt):
    got = 0
    for v in search(q):
        if v["id"] in used: continue
        try:
            img = urllib.request.urlopen(urllib.request.Request(f"https://i.ytimg.com/vi/{v['id']}/mqdefault.jpg", headers=UA), timeout=30).read()
        except Exception:
            continue
        open(os.path.join(OUT, "img", v["id"] + ".jpg"), "wb").write(img)
        used.add(v["id"])
        items.append({**v, "label": label, "filter": filt, "query": q, "source": "search"})
        got += 1
        if got == PER: break
    print(f"{label} {got} {q}", flush=True)
    time.sleep(1.0)

for q, f in HIDE.items(): take(q, "hide", f)
for q in SHOW: take(q, "show", None)
json.dump(items, open(os.path.join(OUT, "search.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(items), "videos")
