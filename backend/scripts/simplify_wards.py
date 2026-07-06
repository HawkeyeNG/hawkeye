# Dependency-free simplification of the 9,410-ward GeoJSON for the PWA:
# Ramer-Douglas-Peucker per ring + coordinate rounding, keeping only
# state/lga/ward names. Drops rings that collapse below a triangle.
import json, os, sys

EPS = 0.0009      # ~100 m simplification tolerance
DP = 4            # ~11 m coordinate precision
HOME = os.path.expanduser("~")
SRC = os.path.join(HOME, "hawkeye/backend/storage/raw/nga_wards.geojson")
OUT = os.path.join(HOME, "hawkeye/app/nga_wards.geojson")

def perp(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0, min(1, t))
    px, py = x1 + t * dx, y1 + t * dy
    return ((x - px) ** 2 + (y - py) ** 2) ** 0.5

def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = perp(pts[i], pts[0], pts[-1])
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

def ring(r):
    s = rdp(r, EPS)
    s = [[round(x, DP), round(y, DP)] for x, y in s]
    if len(s) >= 4 and s[0] != s[-1]:
        s.append(s[0])
    return s if len(s) >= 4 else None

def poly(coords):
    out = []
    for r in coords:
        rr = ring(r)
        if rr:
            out.append(rr)
    return out or None

sys.setrecursionlimit(100000)
d = json.load(open(SRC))
feats = []
for f in d["features"]:
    g = f.get("geometry") or {}
    t = g.get("type")
    if t == "Polygon":
        c = poly(g["coordinates"])
        geom = {"type": "Polygon", "coordinates": c} if c else None
    elif t == "MultiPolygon":
        ps = [p for p in (poly(pc) for pc in g["coordinates"]) if p]
        geom = {"type": "MultiPolygon", "coordinates": ps} if ps else None
    else:
        geom = None
    if not geom:
        continue
    p = f.get("properties", {})
    feats.append({"type": "Feature",
                  "properties": {"s": p.get("statename"), "l": p.get("lganame"), "w": p.get("wardname")},
                  "geometry": geom})

json.dump({"type": "FeatureCollection", "features": feats},
          open(OUT, "w"), separators=(",", ":"))
print(f"{len(feats)} wards -> {OUT} ({os.path.getsize(OUT)//1024} KB)")
