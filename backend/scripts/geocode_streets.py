# Street-name geocoding for polling units whose register names contain a street/
# road/junction phrase (~15k units, none of which have better than a ward-centroid
# fix). Extracts the street phrase, geocodes via OSM Nominatim (1 req/s fair use,
# LGA query then state fallback), validates the result is in the right state, and
# appends to storage/raw/street_locations.csv (pu_code,lat,lng,radius_m,source,score).
# Resumable: already-processed codes are skipped on restart.
#   python3 scripts/geocode_streets.py [maxQueries]
import csv, re, os, json, sys, time, urllib.request, urllib.parse

HOME = os.path.expanduser("~")
REG = os.path.join(HOME, "hawkeye/backend/storage/raw/nigeria_polling_units.csv")
OUT = os.path.join(HOME, "hawkeye/backend/storage/raw/street_locations.csv")
DONE = OUT + ".done"  # every attempted code (hit or miss) for resume
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 10**9

TOKEN = r"(?:street|str|road|rd|close|avenue|ave|crescent|cres|lane|drive|junction)"
TIGHT = re.compile(r"([a-z'’]{3,}(?: [a-z'’]{3,})?) ?\b(" + TOKEN + r")\b", re.I)
STOP = {"open", "space", "front", "junc", "junction", "corner", "beside", "opposite",
        "near", "along", "by", "off", "the", "and", "with", "sch", "school", "church",
        "cath", "pri", "prim"}

def geocode(q):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 1, "countrycodes": "ng"})
    req = urllib.request.Request(url, headers={"User-Agent": "Hawkeye-Election-Monitor/1.0 (info@hawkeye.com.ng)"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=20).read())
    except Exception:
        return []

done = set()
if os.path.exists(DONE):
    done = set(open(DONE).read().split())
new_out = not os.path.exists(OUT)
out = open(OUT, "a", newline="")
w = csv.writer(out)
if new_out:
    w.writerow(["pu_code", "lat", "lng", "radius_m", "source", "score"])
donef = open(DONE, "a")

cands = []
with open(REG, newline="", encoding="utf-8", errors="replace") as f:
    for r in csv.DictReader(f):
        m = list(TIGHT.finditer(r["location"] or ""))
        if not m:
            continue
        words = [x for x in m[-1].group(1).split() if x.lower() not in STOP]
        if not words:
            continue
        code = r["code"].replace("/", "-")
        if code in done:
            continue
        cands.append((code, " ".join(words[-2:]) + " " + m[-1].group(2), r["lg"].title(), r["state"].title()))

print(f"candidates remaining: {len(cands)}")
hits = tried = 0
for code, phrase, lg, state in cands:
    if tried >= MAX:
        break
    tried += 1
    d = geocode(f"{phrase}, {lg}, {state}, Nigeria")
    time.sleep(1.1)
    if not d:
        d = geocode(f"{phrase}, {state}, Nigeria")
        time.sleep(1.1)
    if d and state.lower() in d[0].get("display_name", "").lower():
        w.writerow([code, round(float(d[0]["lat"]), 6), round(float(d[0]["lon"]), 6), 500, "street", 0.7])
        hits += 1
    donef.write(code + "\n")
    if tried % 25 == 0:
        out.flush(); donef.flush()
        print(f"  {tried} tried · {hits} hits ({hits/tried*100:.0f}%)", flush=True)
out.close(); donef.close()
print(f"pass done: {tried} tried, {hits} hits -> {OUT}")
