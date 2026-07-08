# Rescue named-crawl coords whose pu_code drifted from the register, by matching
# on NAMES (state -> LGA -> ward -> unit) instead of the mismatched number.
# Reads the register CSV directly (no DB / no better-sqlite3), so it runs anywhere.
#   python3 scripts/recover_units_by_name.py [threshold=0.55]
# In:  storage/raw/inec_pu_coords_named.csv  (pu_code,lat,lng,state_code,lga,ward,pu_name)
#      storage/raw/nigeria_polling_units.csv (register: state_code,lg,ward,location,code,...)
# Out: storage/raw/inec_pu_coords_recovered.csv (pu_code,lat,lng,source)
#      then: node scripts/attach_coordinates.js <out> --source inec_locator
import csv, os, sys

HOME = os.path.expanduser("~")
RAW = os.path.join(HOME, "hawkeye/backend/storage/raw")
NAMED = os.path.join(RAW, "inec_pu_coords_named.csv")
REG = os.path.join(RAW, "nigeria_polling_units.csv")
OUT = os.path.join(RAW, "inec_pu_coords_recovered.csv")
TH = float(sys.argv[1]) if len(sys.argv) > 1 else 0.55

import re
def norm(s):
    n = re.sub(r"\s+", " ", re.sub(r"[^a-z ]+", " ", str(s or "").lower())).strip()
    return "fct" if re.search(r"\bfct\b|federal capital|abuja", n) else n

def bigrams(s):
    t = f"_{s}_"
    return {t[i:i+2] for i in range(len(t)-1)}

_bg = {}
def bg(s):
    b = _bg.get(s)
    if b is None:
        b = bigrams(s); _bg[s] = b
    return b

def dice(a, b):
    if not a or not b:
        return 0.0
    return 2*len(a & b)/(len(a)+len(b))

def best(name, cands):  # cands: {normname: value} -> (value, score, tie)
    if name in cands:
        return cands[name], 1.0, False
    nb = bg(name); top=None; ts=0.0; sec=0.0
    for cn, val in cands.items():
        s = dice(nb, bg(cn))
        if s > ts: sec, ts, top = ts, s, val
        elif s > sec: sec = s
    return top, ts, (ts - sec < 0.05)

# ---- register hierarchy: state_code -> lg -> ward -> (unit name -> full code)
reg = {}
reg_set = set()
state_lgas = {}   # register state_code -> set(norm lga) — for the locator->register remap
with open(REG, newline="", encoding="utf-8", errors="replace") as f:
    for r in csv.DictReader(f):
        full = (r.get("code") or "").strip().replace("/", "-")
        if not re.match(r"^\d{2}-\d{2}-\d{2}-\d{3}$", full):
            continue
        reg_set.add(full)
        sc = full.split("-")[0]
        lgn = norm(r["lg"])
        (reg.setdefault(sc, {}).setdefault(lgn, {})
            .setdefault(norm(r["ward"]), {}).setdefault(norm(r["location"]), full))
        state_lgas.setdefault(sc, set()).add(lgn)
print(f"register: {len(reg_set)} units", flush=True)

# The crawl's state number is the locator's sequential state_id, which does NOT
# always equal the register's delimitation state code (e.g. locator 15 = FCT but
# register 15 = Gombe). Derive the remap by which register state's LGA-name set a
# locator state's crawl LGA names overlap most. Aligned states map to themselves.
from collections import defaultdict
crawl_lgas = defaultdict(set)
with open(NAMED, newline="") as f:
    for r in csv.DictReader(f):
        crawl_lgas[(r["pu_code"] or "").strip().split("-")[0]].add(norm(r.get("lga")))
remap = {}
for lsc, lgas in crawl_lgas.items():
    best_sc, best_ov = lsc, -1
    for rsc, rlgas in state_lgas.items():
        ov = len(lgas & rlgas)
        if ov > best_ov:
            best_ov, best_sc = ov, rsc
    remap[lsc] = best_sc
print("state remap (locator->register, where differing): "
      + ", ".join(f"{k}->{v}" for k, v in sorted(remap.items()) if k != v), flush=True)

def in_ng(lat, lng):
    return 4 <= lat <= 14 and 2.5 <= lng <= 15

out = []
emitted = set()
already = recovered = ambiguous = nomatch = invalid = dup = 0
with open(NAMED, newline="") as f:
    for r in csv.DictReader(f):
        try:
            lat = float(r["lat"]); lng = float(r["lng"])
        except Exception:
            invalid += 1; continue
        if not in_ng(lat, lng):
            invalid += 1; continue
        code = (r["pu_code"] or "").strip()
        if code in reg_set:
            already += 1; continue          # exact code — normal attach handles it
        sc = remap.get(code.split("-")[0], code.split("-")[0])
        st = reg.get(sc)
        lgn, wdn, pun = norm(r.get("lga")), norm(r.get("ward")), norm(r.get("pu_name"))
        if not st or not lgn or not wdn or not pun:
            nomatch += 1; continue
        lg, ls, _ = best(lgn, st)
        if not lg or ls < 0.6:
            nomatch += 1; continue
        wd, ws, _ = best(wdn, lg)
        if not wd or ws < 0.6:
            nomatch += 1; continue
        pu, ps, tie = best(pun, wd)
        if not pu or ps < TH:
            nomatch += 1; continue
        if tie:
            ambiguous += 1; continue
        if pu in emitted:
            dup += 1; continue
        emitted.add(pu)
        out.append((pu, f"{lat:.6f}", f"{lng:.6f}", "inec_locator"))
        recovered += 1

with open(OUT, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["pu_code", "lat", "lng", "source"])
    w.writerows(out)

print(f"already valid code:        {already}")
print(f"RECOVERED by name:         {recovered}")
print(f"ambiguous (tie, skipped):  {ambiguous}")
print(f"no register match:         {nomatch}")
print(f"dup target / invalid:      {dup} / {invalid}")
print(f"-> {OUT}")
print("next: node scripts/attach_coordinates.js storage/raw/inec_pu_coords_named.csv --source inec_locator")
print("      node scripts/attach_coordinates.js storage/raw/inec_pu_coords_recovered.csv --source inec_locator")
