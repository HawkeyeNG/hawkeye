#!/usr/bin/env bash
# Measure the party pass's ACTUAL throughput over a fixed window.
#
#   bash scripts/party_rate.sh [seconds]
#
# The worker prints a rate, but that rate is averaged over its whole life
# including a burst of instant failures at the start, which made it read
# 2.67 s/sheet while genuinely completing about six a minute. Two counts and a
# clock are harder to mislead.
cd ~/hawkeye/backend || exit 1
WINDOW="${1:-120}"

count_read() {
  python3 - <<'PY'
import json, os
ok = set()
p = 'storage/audit-osun2026/party_full.jsonl'
if os.path.exists(p):
    for l in open(p, encoding='utf-8'):
        l = l.strip()
        if not l:
            continue
        try:
            r = json.loads(l)
        except Exception:
            continue
        if isinstance(r.get('parties'), list) and r['parties']:
            ok.add(os.path.basename(r.get('file', '')))
print(len(ok))
PY
}

A=$(count_read)
sleep "$WINDOW"
B=$(count_read)

TARGETS=$(python3 -c "import json;print(len(json.load(open('storage/audit-osun2026/party_targets.json'))))")
python3 - "$A" "$B" "$WINDOW" "$TARGETS" <<'PY'
import sys
a, b, w, t = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
rate = (b - a) / (w / 60.0)
print("%d -> %d in %.0fs  =  %.1f sheets/min" % (a, b, w, rate))
rem = t - b
if rate > 0:
    print("%d remaining -> about %.0f min" % (rem, rem / rate))
else:
    print("!! no progress in the window — the run may be stalled")
PY
