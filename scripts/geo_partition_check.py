#!/usr/bin/env python3
"""The partition regression check from the 2026-08-04 fix.

A partition that tiles properly is >70% shared vertices and >99% area coverage
of its parent. Per-polygon simplification, or rounding coordinates after the
dissolve, drops both — the borders stop touching and the background shows
through as slivers.
"""
import json
import re
import sys
from collections import Counter

def load(p):
    d = json.load(open(p))
    return d.get("regions") or d.get("lgas") or []

NUM = re.compile(r"-?\d+(?:\.\d+)?")

def verts(path):
    n = NUM.findall(path)
    return [(n[i], n[i + 1]) for i in range(0, len(n) - 1, 2)]

def report(label, p):
    regions = load(p)
    allv, per = Counter(), []
    for r in regions:
        v = set(verts(r["path"]))
        per.append(len(v))
        allv.update(v)
    total = sum(per)
    shared = sum(c for v, c in allv.items() if c > 1)
    dec = sum(1 for r in regions[:40] for m in NUM.findall(r["path"]) if "." in m)
    print(f"{label:<26} regions {len(regions):>4}  vertices {total:>7,}  "
          f"shared {100*shared/max(1,total):>5.1f}%  decimals-in-sample {dec:>5}")
    return len(regions), 100 * shared / max(1, total)

for label, p in [("constituency BEFORE", "/tmp/constituency_geo.before.json"),
                 ("constituency AFTER", "/home/elrio/hawkeye/app/constituency_geo.json"),
                 ("district (senatorial)", "/home/elrio/hawkeye/app/district_geo.json"),
                 ("lga (known good)", "/home/elrio/hawkeye/app/lga_geo.json")]:
    try:
        report(label, p)
    except FileNotFoundError:
        print(f"{label:<26} (missing)")
