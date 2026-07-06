# Recover crawl coords whose locator ward numbering diverges from the register.
# For affected LGAs, fetch locator LGA/ward LABELS (names — cheap; no coord
# calls), fuzzy-match them to register lg/ward names, rewrite the code's
# lga+ward segments, and emit storage/raw/inec_pu_coords_recovered.csv with
# rows that now exist in the register.
#   python3 scripts/recover_ward_codes.py
import csv, json, os, re, time, urllib.request

HOME = os.path.expanduser("~")
RAW = os.path.join(HOME, "hawkeye/backend/storage/raw")
B = "https://cvr.inecnigeria.org"
HDRS = {"User-Agent": "Hawkeye-Election-Monitor/1.0 (transparency project; info@hawkeye.com.ng)",
        "X-Requested-With": "XMLHttpRequest", "Referer": B + "/pu_locator/"}

def get_json(path):
    req = urllib.request.Request(B + path, headers=HDRS)
    for _ in range(3):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=25).read())
        except Exception:
            time.sleep(1.5)
    return []

def opts(d):
    out = []
    for row in d:
        for k, v in row.items():
            if k not in ("0", "selected"):
                out.append((k, v.strip()))
    return out

PREFIX = re.compile(r"^\s*(\d+)")
def split_label(label):  # "12 - UTAGBA OGBE" -> ("12", "utagba ogbe")
    m = PREFIX.match(label)
    code = m.group(1).zfill(2) if m else None
    name = re.sub(r"^\s*\d+\s*[-–]?\s*", "", label)
    return code, norm(name)

def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]+", " ", s.lower())).strip()

def bigrams(s):
    t = f"_{s}_"
    return {t[i:i + 2] for i in range(len(t) - 1)}

def dice(a, b):
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))

def best(name, cands):  # cands: {code: name}; returns (code, score)
    bg = bigrams(name)
    top, ts = None, 0.0
    for code, cn in cands.items():
        s = dice(bg, bigrams(cn))
        if s > ts:
            top, ts = code, s
    return top, ts

# ---- register: names + full-code set
reg_lg = {}     # state_code -> {lg_code: lg_name}
reg_ward = {}   # (state_code, lg_code) -> {ward_code: ward_name}
reg_set = set()
with open(os.path.join(RAW, "nigeria_polling_units.csv"), newline="", encoding="utf-8", errors="replace") as f:
    for r in csv.DictReader(f):
        sc, lc, wc = r["state_code"], r["lg_code"], r["ward_code"]
        reg_lg.setdefault(sc, {})[lc] = norm(r["lg"])
        reg_ward.setdefault((sc, lc), {})[wc] = norm(r["ward"])
        reg_set.add(f"{sc}-{lc}-{wc}-{r['pu_code']}")

# ---- crawl rows whose full code missed AND whose s-l-w prefix is unknown
ward_prefixes = {c.rsplit("-", 1)[0] for c in reg_set}
missing = {}    # (s, lcode, wcode) -> [(pu_code, lat, lng)]
with open(os.path.join(RAW, "inec_pu_coords.csv"), newline="") as f:
    for r in csv.DictReader(f):
        code = r["pu_code"]
        if code in reg_set:
            continue
        s, l, w, p = code.split("-")
        if f"{s}-{l}-{w}" in ward_prefixes:
            continue  # ward exists; PU genuinely absent from register — skip
        missing.setdefault((s, l, w), []).append((code, r["lat"], r["lng"]))

states = sorted({k[0] for k in missing})
lgas_affected = sorted({(k[0], k[1]) for k in missing})
print(f"rows to recover: {sum(len(v) for v in missing.values())} in {len(missing)} wards, "
      f"{len(lgas_affected)} LGAs, {len(states)} states")

# ---- fetch locator labels for affected states/LGAs and build the remap
recovered, ambiguous, unmapped = [], 0, 0
for s in states:
    sid = int(s)
    loc_lgas = {}
    for lid, label in opts(get_json(f"/PublicApi/lgas/1/Search?data%5BSearch%5D%5Bstate_id%5D={sid}")):
        code, name = split_label(label)
        if code:
            loc_lgas[code] = (lid, name)
    for (s2, lcode) in [x for x in lgas_affected if x[0] == s]:
        if lcode not in loc_lgas:
            unmapped += sum(len(missing[k]) for k in missing if k[0] == s and k[1] == lcode)
            continue
        lid, lname = loc_lgas[lcode]
        reg_lcode, sc1 = best(lname, reg_lg.get(s, {}))
        if not reg_lcode or sc1 < 0.5:
            unmapped += sum(len(missing[k]) for k in missing if k[0] == s and k[1] == lcode)
            continue
        loc_wards = {}
        for wid, wlabel in opts(get_json(f"/PublicApi/wards/1/Search?data%5BSearch%5D%5Blocal_government_id%5D={lid}")):
            wcode, wname = split_label(wlabel)
            if wcode:
                loc_wards[wcode] = wname
        for (s3, l3, wcode), rows in list(missing.items()):
            if s3 != s or l3 != lcode:
                continue
            wname = loc_wards.get(wcode)
            if not wname:
                unmapped += len(rows)
                continue
            reg_wcode, sc2 = best(wname, reg_ward.get((s, reg_lcode), {}))
            if not reg_wcode or sc2 < 0.5:
                ambiguous += len(rows)
                continue
            for (code, lat, lng) in rows:
                newcode = f"{s}-{reg_lcode}-{reg_wcode}-{code.rsplit('-', 1)[1]}"
                if newcode in reg_set:
                    recovered.append((newcode, lat, lng))
    print(f"state {s} done · recovered so far {len(recovered)}", flush=True)

out = os.path.join(RAW, "inec_pu_coords_recovered.csv")
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["pu_code", "lat", "lng"])
    w.writerows(recovered)
print(f"RECOVERED {len(recovered)} (ambiguous {ambiguous}, unmapped {unmapped}) -> {out}")
