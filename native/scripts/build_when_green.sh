#!/bin/bash
# Build the dev APK, but only once the tree actually typechecks.
#
# A workflow is mid-edit on the map files: unit-map.tsx's envelope contract has
# changed and its two callers are being updated to match. Metro strips types, so
# gradle would happily bundle a half-applied change and produce an APK whose map
# screens are broken at runtime — the exact thing this batch exists to fix.
# So: wait for tsc to come back clean TWICE, 45s apart, before touching gradle.
# Two passes because a single green moment can happen between two edits.
exec > /tmp/build_when_green.log 2>&1
cd "$HOME/hawkeye/native" || exit 1

green=0
for i in $(seq 1 80); do          # 80 * 45s ≈ 60 min ceiling
  if npx tsc --noEmit > /tmp/tsc_gate.txt 2>&1; then
    green=$((green + 1))
    echo "$(date -u +%H:%M:%S) tsc clean ($green/2)"
  else
    green=0
    echo "$(date -u +%H:%M:%S) tsc errors:"
    head -3 /tmp/tsc_gate.txt
  fi
  [ "$green" -ge 2 ] && break
  sleep 45
done

if [ "$green" -lt 2 ]; then
  echo "GATE_TIMEOUT — tsc never settled clean, NOT building"
  exit 1
fi

echo "=== gate passed, building $(date -u +%FT%TZ) ==="
# The Datadog APM injector in /etc/ld.so.preload attaches a java agent to every
# JVM; its -Xshare warning lands on AGP's CMake stderr and AGP fails any task
# that writes there. Env vars do not stop it — the preload attaches first.
if false; then
  sudo -n cp /etc/ld.so.preload /etc/ld.so.preload.hawkeye-bak 2>/dev/null \
    && sudo -n truncate -s 0 /etc/ld.so.preload 2>/dev/null \
    && echo "datadog preload paused" || echo "WARN could not pause preload (may fail on CMake)"
fi

bash scripts/build_dev_apk.sh
rc=$?

if false; then
  sudo -n cp /etc/ld.so.preload.hawkeye-bak /etc/ld.so.preload 2>/dev/null \
    && sudo -n rm -f /etc/ld.so.preload.hawkeye-bak 2>/dev/null \
    && echo "datadog preload restored"
fi

echo "--- build log tail ---"
tail -25 /tmp/native_apk.log
exit $rc
