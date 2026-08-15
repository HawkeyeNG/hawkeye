#!/usr/bin/env python3
"""Join test, v4 — component-window matching for multi-LGA constituencies.

v3's "reordered" tier scored zero because it sorted MAXIMAL slash-runs out of
one big blob, and those runs spill past the constituency into neighbouring
cells, so the sorted string never aligned with a constituency boundary.

v4 asks the question directly: do all of a constituency's components occur
close together anywhere in the document? That is order-independent and
tolerant of separator noise, which is what the two sources actually differ on
(INEC "EKET/ONNA/ESIT EKET/IBENO" vs register "Eket/Esit Eket/Onna/Ibeno").
"""
import re
import sqlite3
import zlib

DB = "/home/elrio/hawkeye/backend/storage/hawkeye.db"
PDF = "/tmp/inec_national-2022.pdf"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
fed = [r[0] for r in con.execute(
    "SELECT DISTINCT federal_constituency FROM polling_units WHERE federal_constituency IS NOT NULL AND federal_constituency <> ''")]
sen = [r[0] for r in con.execute(
    "SELECT DISTINCT senatorial FROM polling_units WHERE senatorial IS NOT NULL AND senatorial <> ''")]
con.close()

OCTAL = re.compile(rb"\\([0-7]{1,3})")
TOKEN = re.compile(rb"\((?:[^()\\]|\\.)*\)|T[dDmJj*]|TD")


def decode(b):
    b = re.sub(rb"\\([()\\])", rb"\1", b)
    b = OCTAL.sub(lambda m: bytes([int(m.group(1), 8) & 0xFF]), b)
    s = b.decode("latin-1", "replace")
    for ch, rep in (("\x1f", "fi"), ("\x0c", "fi"), ("\x92", "'")):
        s = s.replace(ch, rep)
    return s


raw = open(PDF, "rb").read()
lines = []
for m in re.finditer(rb"stream\r?\n(.*?)endstream", raw, re.S):
    try:
        d = zlib.decompress(m.group(1))
    except Exception:
        continue
    run = []
    for t in TOKEN.finditer(d):
        tok = t.group(0)
        if tok.startswith(b"("):
            run.append(decode(tok[1:-1]))
        elif tok in (b"Td", b"TD", b"Tm", b"T*"):
            if run:
                lines.append("".join(run)); run = []
    if run:
        lines.append("".join(run))


def norm(s):
    s = s.upper().replace("&", " AND ").replace("'", "").replace("\\", "/")
    s = re.sub(r"\b(FEDERAL\s+)?CONSTITUENCY\b", " ", s)
    s = re.sub(r"\bSENATORIAL(\s+DISTRICT)?\b", " ", s)
    s = re.sub(r"\bDISTRICT\b", " ", s)
    s = re.sub(r"[^A-Z0-9/]+", " ", s)
    s = re.sub(r"\s*/\s*", "/", s)
    return re.sub(r"\s+", " ", s).strip()


DOC = norm(" ".join(lines))
# Index every component's occurrences once, so the window scan is cheap.
def comps(v):
    return [c for c in (p.strip() for p in norm(v).split("/")) if c]


def classify(v):
    n = norm(v)
    if n in DOC:
        return "exact"
    cs = comps(v)
    if len(cs) < 2:
        return None
    # All components inside one window a little wider than the name itself.
    win = len(n) + 60
    starts = [m.start() for m in re.finditer(re.escape(cs[0]), DOC)]
    for s in starts:
        seg = DOC[max(0, s - win): s + win]
        if all(c in seg for c in cs[1:]):
            return "reordered"
    return None


def report(label, values, seats):
    res = {v: classify(v) for v in values}
    ex = [v for v, r in res.items() if r == "exact"]
    ro = [v for v, r in res.items() if r == "reordered"]
    miss = [v for v, r in res.items() if r is None]
    ok = len(ex) + len(ro)
    print(f"\n=== {label} ===")
    print(f"  register distinct : {len(values)}  (real seats {seats}; excess = register dirt)")
    print(f"  exact string      : {len(ex)}")
    print(f"  same parts, different order/spacing : {len(ro)}")
    print(f"  genuinely unmatched : {len(miss)}   -> {100*ok/len(values):.1f}% joined")
    print(f"  joined as % of REAL seats: {min(100.0, 100*ok/seats):.1f}%")
    if miss:
        print("  unmatched (these are the ones a human would have to look at):")
        for v in sorted(miss)[:25]:
            print(f"      {v}")
    return ok, miss


print(f"lines {len(lines):,}  doc {len(DOC):,} chars")
s_ok, s_miss = report("SENATORIAL", sen, 109)
f_ok, f_miss = report("FEDERAL CONSTITUENCY", fed, 360)
