# Harvest EXACT polling-unit GPS from INEC's public PU locator
# (cvr.inecnigeria.org). Cascade (states->lgas->wards->pus) is an open JSON API;
# the "directions" endpoint 302-redirects to a Google Maps link with the unit's
# real lat,lng (no auth/CAPTCHA). Dropdown label prefixes rebuild our delimitation
# pu_code SS-LL-WW-UUU. CONCURRENT: a thread pool fetches PU coords in parallel
# (still polite — modest worker count, identifying UA). Resumable per ward.
#   python3 scripts/fetch_inec_coords.py [firstState=1] [lastState=37] [workers=12]
#
# NAMED output: as well as the code+coords, we now keep the locator's LGA, ward
# and polling-unit NAMES (the dropdown label text, minus its numeric prefix) plus
# the numeric state code. Those names are what scripts/recover_units_by_name.js
# uses to rescue the ~50k rows whose locator numbering has drifted from our
# register's codes — a wrong number can't match, but the name still can.
import os, re, sys, csv, json, time, threading, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
OUT = os.path.join(HOME, "hawkeye/backend/storage/raw/inec_pu_coords_named.csv")
DONE = OUT + ".wards_done"
B = "https://cvr.inecnigeria.org"
UA = "Hawkeye-Election-Monitor/1.0 (transparency project; info@hawkeye.com.ng)"
HDRS = {"User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": B + "/pu_locator/"}
S0 = int(sys.argv[1]) if len(sys.argv) > 1 else 1
S1 = int(sys.argv[2]) if len(sys.argv) > 2 else 37
# Workers: 12 is a good speed/politeness balance. You can push higher for a faster
# crawl, but INEC's host may throttle or temp-block an IP that hammers it — and a
# mid-crawl block costs more time than it saves. It's resumable per ward, so if you
# do get blocked, just wait and re-run; finished wards are skipped.
WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 12

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
def code_of(label):
    m = PREFIX.match(label)
    return m.group(1).zfill(2) if m else None

def name_of(label):  # "12 - UTAGBA OGBE" -> "UTAGBA OGBE"
    return re.sub(r"^\s*\d+\s*[-–]?\s*", "", label).strip()

def coords(sid, lid, wid, pid):
    body = urllib.parse.urlencode({
        "_method": "POST", "data[Search][state_id]": sid,
        "data[Search][local_government_id]": lid,
        "data[Search][registration_area_id]": wid,
        "data[Search][polling_unit_id]": pid,
    }).encode()
    req = urllib.request.Request(B + "/pu_locator/index", data=body,
                                 headers={**HDRS, "Content-Type": "application/x-www-form-urlencoded"})
    for _ in range(3):
        try:
            try:
                txt = urllib.request.urlopen(req, timeout=25).read().decode(errors="replace")
            except urllib.error.HTTPError as e:
                txt = e.read().decode(errors="replace")
            m = re.search(r"q=([-0-9.]+)%2C([-0-9.]+)", txt) or re.search(r"q=([-0-9.]+),([-0-9.]+)", txt)
            return (float(m.group(1)), float(m.group(2))) if m else None
        except Exception:
            time.sleep(1.5)
    return None

lock = threading.Lock()
done = set(open(DONE).read().split()) if os.path.exists(DONE) else set()
# Robust resume: skip any pu_code already in the CSV. The delimitation code
# (SS-LL-WW-UUU) is stable across runs, unlike the locator's internal ward ids —
# so a re-run re-lists wards cheaply but never re-fetches a coord we already have.
have = set()
if os.path.exists(OUT):
    with open(OUT, newline="") as _f:
        _r = csv.reader(_f); next(_r, None)
        for _row in _r:
            if _row:
                have.add(_row[0])
print(f"resume: {len(have)} coords already in CSV, {len(done)} wards marked done", flush=True)
new = not os.path.exists(OUT)
out = open(OUT, "a", newline="", buffering=1); w = csv.writer(out)
if new:
    w.writerow(["pu_code", "lat", "lng", "state_code", "lga", "ward", "pu_name"])
donef = open(DONE, "a", buffering=1)
total = [0]

def do_pu(args):
    sid, lid, wid, pid, code, scode, lgname, wname, pname = args
    c = coords(sid, lid, wid, pid)
    if c and -1 < c[0] < 15 and 2 < c[1] < 15:
        with lock:
            w.writerow([code, round(c[0], 6), round(c[1], 6), scode, lgname, wname, pname])
            total[0] += 1

pool = ThreadPoolExecutor(max_workers=WORKERS)
for sid in range(S0, S1 + 1):
    scode = str(sid).zfill(2)
    lgas = opts(get_json(f"/PublicApi/lgas/1/Search?data%5BSearch%5D%5Bstate_id%5D={sid}"))
    if not lgas:
        continue
    for lid, llabel in lgas:
        lcode = code_of(llabel)
        lgname = name_of(llabel)
        wards = opts(get_json(f"/PublicApi/wards/1/Search?data%5BSearch%5D%5Blocal_government_id%5D={lid}"))
        for wid, wlabel in wards:
            key = f"{sid}-{lid}-{wid}"
            if key in done:
                continue
            wcode = code_of(wlabel)
            wname = name_of(wlabel)
            pus = opts(get_json(f"/PublicApi/pus/1/Search?data%5BSearch%5D%5Bregistration_area_id%5D={wid}"))
            jobs = []
            for pid, plabel in pus:
                pcode = code_of(plabel)
                pname = name_of(plabel)
                if all((scode, lcode, wcode, pcode)):
                    code = f"{scode}-{lcode}-{wcode}-{pcode.zfill(3)}"
                    if code in have:
                        continue          # already fetched — don't re-request
                    jobs.append((sid, lid, wid, pid, code, scode, lgname, wname, pname))
            list(pool.map(do_pu, jobs))       # ward's PUs fetched in parallel
            donef.write(key + "\n")
        print(f"state {sid} lga {lcode} done · {total[0]} coords", flush=True)
pool.shutdown()
out.close(); donef.close()
print(f"FINISHED states {S0}-{S1}: {total[0]} coords -> {OUT}")
