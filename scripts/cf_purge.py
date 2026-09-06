#!/usr/bin/env python3
"""Purge exactly the URLs a deploy just replaced.

WHY THIS EXISTS. Since 2026-09-06 the zone has cache rules with an Edge TTL
override (docs/cloudflare-rules.md §4.2). `static-assets` holds js/css/fonts for
7 days and `data-json` holds .json/.geojson for 1 day. Static assets are safe
because they are cache-busted by query string — a new `?v=` is a new cache key.
The DATA FILES ARE NOT: `register-osun.json`, `nga_wards.geojson` and friends
are fetched at a fixed URL, so without a purge a deploy can serve yesterday's
offline register for a full day, and the site would look fine while doing it.

BY URL, NEVER "purge everything". A full purge throws away a warm edge cache
across the whole zone to fix a handful of objects, and on election night that
would push every asset back onto the origin at once — the exact failure the
cache rules exist to prevent.

Usage:  cf_purge.py https://hawkeye.com.ng/a.json https://hawkeye.com.ng/b.js
Exit 0 on success or when there is nothing to do. A missing token is NOT an
error: the purge is an optimisation, and a deploy must not fail because of it.
"""
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", ".env")
API = "https://api.cloudflare.com/client/v4"
BATCH = 30                       # Cloudflare caps files-per-purge-call
ctx = ssl.create_default_context()


def env(key):
    try:
        with open(ENV, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = re.match(r"^%s=(.*)$" % re.escape(key), line.rstrip("\r\n"))
                if m:
                    return re.sub(r"\s*#.*$", "", m.group(1)).strip().strip("'\"")
    except OSError:
        return None
    return None


urls = [u for u in sys.argv[1:] if u.startswith("http")]
if not urls:
    sys.exit(0)

token, zone = env("CLOUDFLARE_API_TOKEN"), env("CLOUDFLARE_ZONE_ID")
if not token or not zone:
    print("  purge:   skipped (no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID)")
    sys.exit(0)

failed = []
purged = 0
for i in range(0, len(urls), BATCH):
    chunk = urls[i:i + BATCH]
    req = urllib.request.Request(
        "%s/zones/%s/purge_cache" % (API, zone),
        method="POST",
        data=json.dumps({"files": chunk}).encode(),
    )
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
            doc = json.loads(r.read().decode())
        if doc.get("success"):
            purged += len(chunk)
        else:
            failed.append(json.dumps(doc.get("errors"))[:160])
    except urllib.error.HTTPError as e:
        try:
            failed.append(json.dumps(json.loads(e.read().decode()).get("errors"))[:160])
        except Exception:                                    # noqa: BLE001
            failed.append("http %d" % e.code)
    except Exception as exc:                                 # noqa: BLE001
        failed.append(str(exc)[:160])

if failed:
    # Loud, but not fatal. The files ARE deployed; they are just still cached,
    # and saying so is more useful than failing a deploy that worked.
    print("  purge:   %d/%d purged, PROBLEM: %s" % (purged, len(urls), "; ".join(failed)))
else:
    print("  purge:   %d URL(s) purged from the edge" % purged)
sys.exit(0)
