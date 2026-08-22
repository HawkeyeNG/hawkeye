#!/usr/bin/env bash
# Block until the party-table pass finishes, then report how it ended.
#
# Reports FAILURE on timeout and on a worker that vanished without finishing
# its target list — a watcher that cannot fail is a watcher that can lie, and
# this pipeline has already had three background jobs mis-reported as done.
cd ~/hawkeye/backend || exit 1
DIR=storage/audit-osun2026
MAX_MIN="${1:-150}"
DEADLINE=$(( $(date +%s) + MAX_MIN * 60 ))
TARGETS=$(python3 -c "import json;print(len(json.load(open('$DIR/party_targets.json'))))")

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! pgrep -f '[v]lm_party_worker' > /dev/null; then
    # Count sheets that HAVE A READING, not lines in the file. The output is
    # append-only and holds a record for every attempt, including the 400s and
    # 502s from a run that died — totalling lines would have called a run
    # complete on the strength of its own failures.
    DONE=$(python3 -c "
import json,os
ok=set()
for l in open('$DIR/party_full.jsonl',encoding='utf-8'):
    l=l.strip()
    if not l: continue
    try: r=json.loads(l)
    except Exception: continue
    if isinstance(r.get('parties'),list) and r['parties']:
        ok.add(os.path.basename(r.get('file','')))
print(len(ok))
" 2>/dev/null || echo 0)
    echo "worker exited with ${DONE}/${TARGETS} sheets READ"
    tail -6 "$DIR/party_run.log"
    if [ "$DONE" -lt "$TARGETS" ]; then
      echo "!! INCOMPLETE — ${TARGETS} targeted, ${DONE} written. Re-run to resume."
      exit 1
    fi
    echo "COMPLETE"
    exit 0
  fi
  sleep 60
done

echo "!! TIMED OUT after ${MAX_MIN} min; worker still running"
tail -4 "$DIR/party_run.log"
exit 1
