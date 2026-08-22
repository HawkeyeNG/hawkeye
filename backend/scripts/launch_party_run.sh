#!/usr/bin/env bash
# Launch the archive party-table pass detached, and prove it actually started.
#
#   bash scripts/launch_party_run.sh [concurrency]
#
# Detached because the run is over an hour. Verified because a launcher that
# reports success without checking is how a dead job gets mistaken for a
# running one — this pipeline has already produced one zero-byte log that
# looked exactly like a job still warming up.
set -e
cd ~/hawkeye/backend
source scripts/pod_env.sh

CONC="${1:-14}"
DIR=storage/audit-osun2026
LOG=$DIR/party_run.log

setsid nohup node scripts/vlm_party_worker.mjs \
  --dir $DIR/sheets \
  --out $DIR/party_full.jsonl \
  --only $DIR/party_targets.json \
  --concurrency "$CONC" \
  > "$LOG" 2>&1 < /dev/null &

PID=$!
echo "launched pid $PID (concurrency $CONC)"
sleep 60

if kill -0 "$PID" 2>/dev/null; then
  echo "STILL RUNNING after 60s"
else
  echo "!! PROCESS EXITED WITHIN 60s — read the log below"
fi
echo "--- log ---"
tail -12 "$LOG"
echo "--- rows written so far ---"
wc -l < "$DIR/party_full.jsonl" 2>/dev/null || echo 0
