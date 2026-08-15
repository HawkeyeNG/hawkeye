#!/usr/bin/env python3
"""Can constituency polygons be built from the ward file?

Senatorial districts and federal constituencies are unions of LGAs, and the
register already maps every polling unit's LGA to both. nga_wards.geojson
carries {s: state, l: LGA, w: ward}. So constituency polygons =
dissolve wards -> LGA -> group by the register's constituency columns. Ward
NAMES never have to join, which is what blocked ward maps (225 of Osun's 332
unmatched).

The only question is whether the geojson's LGA names join to the register's.
"""
import json
import re
import sqlite3
import unicodedata

DB = "/home/elrio/hawkeye/backend/storage/hawkeye.db"
GJ = "/home/elrio/hawkeye/app/nga_wards.geojson"


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").upper()
    s = s.replace("&", " AND ").replace("'", "").replace("-", " ")
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


gj = json.load(open(GJ))
geo = {}
for f in gj["features"]:
    p = f["properties"]
    geo.setdefault((norm(p.get("s")), norm(p.get("l"))), 0)
    geo[(norm(p.get("s")), norm(p.get("l")))] += 1
print(f"geojson: {len(gj['features']):,} ward polygons, {len(geo)} distinct (state, LGA)")

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
reg = {}
for st, lga, n in con.execute(
        "SELECT state, lga, COUNT(*) FROM polling_units WHERE lga IS NOT NULL AND lga <> '' GROUP BY state, lga"):
    reg[(norm(st), norm(lga))] = n
con.close()
print(f"register: {len(reg)} distinct (state, LGA)   (Nigeria has 774 LGAs)")

hit = set(reg) & set(geo)
print(f"\nJOINED: {len(hit)} / {len(reg)} register LGAs ({100*len(hit)/len(reg):.1f}%)")
missing = sorted(set(reg) - set(geo))
print(f"register LGAs with no polygon: {len(missing)}")
for st, l in missing[:20]:
    print(f"    {st:<14} {l}")
extra = sorted(set(geo) - set(reg))
print(f"\npolygon LGAs not in the register: {len(extra)}")
for st, l in extra[:10]:
    print(f"    {st:<14} {l}")
