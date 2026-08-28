#!/usr/bin/env bash
# Put the new iOS capture frame into BOTH apps' sets, at all three display sizes.
#
# The compositor builds whatever it finds in --in and skips the rest, so a
# directory holding only 1-capture.png rebuilds just that shot. Native's raw
# frames are long gone from /tmp; this is how one shot gets replaced without
# re-capturing the other five.
set -u
cd "$HOME/hawkeye/backend" || exit 1
D=/mnt/c/Users/HP/Downloads/hawkeye-screenshots

RAW=/tmp/cap-raw
rm -rf "$RAW" && mkdir -p "$RAW"
cp "/tmp/1-capture.ios.png" "$RAW/1-capture.png"

for s in 6.5:1242:2688 6.7:1290:2796 6.9:1320:2868; do
  IFS=: read -r name w h <<< "$s"
  OUT=/tmp/cap-out-$name
  rm -rf "$OUT"
  node scripts/make_store_screenshots.mjs --in "$RAW" --out "$OUT" --w "$w" --h "$h" >/dev/null 2>&1
  [ -f "$OUT/1-capture.png" ] || { echo "FAIL: nothing built for $name"; exit 1; }
  for app in ios lite-ios; do
    cp "$OUT/1-capture.png" "$D/$app-$name/1-capture.png"
  done
  echo "  $name -> ios-$name and lite-ios-$name"
done

echo
python3 - <<'PY'
import struct, glob, os
root = '/mnt/c/Users/HP/Downloads/hawkeye-screenshots/'
def dims(p):
    with open(p, 'rb') as f:
        return struct.unpack('>II', f.read(24)[16:24])
bad = 0
for d in ['ios-6.5','ios-6.7','ios-6.9','lite-ios-6.5','lite-ios-6.7','lite-ios-6.9']:
    fs = sorted(glob.glob(root + d + '/*.png'))
    sizes = {dims(f) for f in fs}
    ok = len(sizes) == 1
    if not ok: bad += 1
    print('  %-14s %d files  %s' % (d, len(fs),
          'x'.join(map(str, sizes.pop())) if ok else 'MIXED CANVAS %r' % sizes))
raise SystemExit(1 if bad else 0)
PY
