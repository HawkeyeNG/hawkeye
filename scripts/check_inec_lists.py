#!/usr/bin/env python3
"""
Has INEC changed its 2027 candidate lists since we parsed them?

    python3 scripts/check_inec_lists.py            # exit 0 = same, 3 = something changed

INEC amends its final lists (court orders, substitutions, withdrawals) by
replacing a PDF or adding a page, without announcing it anywhere a machine can
read. This compares what the site serves NOW with what was downloaded into
tmp/inec-2027/ (sources.tsv: name, bytes, sha256, url):

  NEW      a document linked from the 2027 page that we never downloaded
  CHANGED  same address, different content (SHA-256 against the copy we parsed)
  GONE     a document we parsed that the site no longer links
  PAGE     a new /press/ page on the 2027 index, whatever it holds

It also says whether Borno has appeared in the State Assembly list: that state
was absent from the file published on 10 Oct 2026.

It reads every list (about 9 MB in all) to compare fingerprints — INEC's server
sends no ETag or Last-Modified, and a size alone would miss a same-size
replacement. It KEEPS nothing and changes nothing. When it reports a change, the refresh is by hand, and reviewed before anything is
published:
    bash <the download step>   →  scripts/parse_inec_final_lists_2027.py tmp/inec-2027/pdf
    →  scripts/build_ballots_2027.py   (read the report, then --write)
"""
import hashlib
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("HK_INEC_BASELINE") or os.path.join(ROOT, "tmp", "inec-2027")   # the override is for the control test
BASE = "https://www.inecnigeria.org"
INDEX = BASE + "/elections/2027-general-elections-update"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE          # INEC's chain has been incomplete; nothing sensitive is sent or trusted here
UA = {"User-Agent": "Mozilla/5.0 (Hawkeye list watch)"}


def get(url, method="GET", tries=4):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA, method=method)
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                return r.status, dict(r.headers), (r.read() if method == "GET" else b"")
        except Exception as e:           # noqa: BLE001 — a flaky site is retried, then reported
            last = e
    raise RuntimeError(f"{method} {url}: {last}")


# INEC redrew the wards of the three Warri LGAs in June 2026 (20 registration
# areas each) and listed them per state constituency, but its public polling-
# unit directory still shows the old ones, so that list cannot be tied to units
# yet (tmp/inec-2027/warri, and the note in build_sha_ward_composition.py).
WARRI_OLD = {"WARRI NORTH": 10, "WARRI SOUTH": 12, "WARRI SOUTH WEST": 10}
PU_API = "https://cvr.inecnigeria.org/PublicApi/"


def warri_wards():
    """Ward counts in INEC's polling-unit directory today, or None if it cannot be read."""
    import json
    rows = lambda body: {k: v for d in json.loads(body) for k, v in d.items() if k not in ("0", "selected")}  # noqa: E731
    name = lambda v: re.sub(r"\s+", " ", re.sub(r"^[\d\s-]+", "", str(v))).strip().upper()  # noqa: E731
    try:
        lgas = rows(get(PU_API + "lgas/1/Search?data%5BSearch%5D%5Bstate_id%5D=10")[2])   # 10 = Delta
        out = {}
        for lid, label in lgas.items():
            if name(label) in WARRI_OLD:
                out[name(label)] = len(rows(get(PU_API + f"wards/1/Search?data%5BSearch%5D%5Blocal_government_id%5D={lid}")[2]))
        return out if len(out) == len(WARRI_OLD) else None
    except Exception:           # noqa: BLE001 — a side check; the list comparison above still stands
        return None


def main():
    try:
        known = {}
        for ln in open(os.path.join(SRC, "sources.tsv"), encoding="utf-8"):
            name, size, _sha, url = ln.rstrip("\n").split("\t")
            known[url] = (name, int(size), _sha)
        pages_known = {ln.strip() for ln in open(os.path.join(SRC, "press.txt"), encoding="utf-8") if ln.strip()}
    except FileNotFoundError:
        print("no baseline: tmp/inec-2027/sources.tsv is missing — download and parse the lists first")
        return 2

    _, _, html = get(INDEX)
    pages = sorted(set(re.findall(r"/press/[a-z0-9-]+", html.decode("utf-8", "replace"))))
    if len(pages) < 10:
        print(f"the 2027 page lists only {len(pages)} press pages — the site may have changed shape; check it by hand: {INDEX}")
        return 3

    findings, now, digest = [], {}, {}
    for p in pages:
        if p not in pages_known:
            findings.append(f"PAGE     new page on the 2027 index: {BASE}{p}")
        _, _, body = get(BASE + p)
        for h in sorted(set(re.findall(r'href="(/documents/[^"]+)"', body.decode("utf-8", "replace")))):
            url = BASE + urllib.parse.quote(h, safe="/%()")
            _, _hdr, blob = get(url)
            now[url] = len(blob)
            digest[url] = hashlib.sha256(blob).hexdigest()
    for p in sorted(pages_known - set(pages)):
        findings.append(f"PAGE     no longer on the 2027 index: {BASE}{p}")
    for url, size in sorted(now.items()):
        name = urllib.parse.unquote(url.rsplit("/", 1)[1])
        if url not in known:
            findings.append(f"NEW      {name} ({size:,} bytes)  {url}")
        elif known[url][2] != digest[url]:
            findings.append(f"CHANGED  {name}: {known[url][1]:,} → {size:,} bytes, different content  {url}")
    for url, (name, _size, _d) in sorted(known.items()):
        if url not in now:
            findings.append(f"GONE     {name}  {url}")
    sha = [u for u in now if "ASSEMBLY" in u.upper()]
    borno = "unchanged — still the file we parsed, which has no Borno" if sha and all(u in known and known[u][2] == digest[u] for u in sha) \
        else "the State Assembly file is new or changed — parse it and look for Borno"
    print(f"INEC 2027 lists: {len(pages)} pages, {len(now)} documents on the site; {len(known)} in our baseline")
    print(f"Borno (State Assembly): {borno}")
    w = warri_wards()
    if w is None:
        print("Warri wards (polling-unit directory): could not be read this time")
    elif w == WARRI_OLD:
        print("Warri wards (polling-unit directory): unchanged — still the old 10 / 12 / 10")
    else:
        findings.append(f"WARDS    Warri now shows {w} in INEC's polling-unit directory: refresh those LGAs in the register, then apply tmp/inec-2027/warri")
    if findings:
        print(f"{len(findings)} difference(s):")
        print("\n".join("  " + f for f in findings))
        return 3
    print("no change since the lists were parsed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
