# Download full Nigeria ward boundary polygons (9,410) from GRID3's public
# ArcGIS FeatureServer as GeoJSON, paginated. Names only (state/lga/ward) — the
# service's codes are a non-INEC scheme, so register linkage is done later via
# PU-point containment (exact) or name-match. Output: storage/raw/nga_wards.geojson
import os, json, time, urllib.request
S = "https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/NGA_Ward_Boundaries/FeatureServer/0/query"
OUT = os.path.join(os.path.expanduser("~"), "hawkeye/backend/storage/raw/nga_wards.geojson")
feats = []
offset = 0
while True:
    q = (f"{S}?where=1%3D1&outFields=statename,lganame,wardname,statecode,lgacode,wardcode"
         f"&returnGeometry=true&outSR=4326&f=geojson&resultOffset={offset}&resultRecordCount=2000")
    for _ in range(3):
        try:
            d = json.loads(urllib.request.urlopen(urllib.request.Request(q, headers={"User-Agent": "Hawkeye/1.0"}), timeout=90).read())
            break
        except Exception:
            time.sleep(3); d = {}
    fs = d.get("features", [])
    if not fs:
        break
    feats.extend(fs)
    print(f"  {len(feats)} wards", flush=True)
    offset += 2000
    if not d.get("properties", {}).get("exceededTransferLimit") and len(fs) < 2000:
        break
    time.sleep(0.5)
json.dump({"type": "FeatureCollection", "features": feats}, open(OUT, "w"))
print(f"done: {len(feats)} ward polygons -> {OUT} ({os.path.getsize(OUT)//1024} KB)")
