#!/usr/bin/env bash
# Wait for the party-table pass to finish, then merge, report and rebuild the
# workbook in one go.
#
#   bash scripts/wait_then_finish.sh [max-minutes]
#
# Chained rather than watched so the merge happens the moment the GPU work ends
# instead of whenever someone next looks. Every failure path exits non-zero and
# says why: a finisher that quietly does nothing is indistinguishable from one
# that worked, and this pipeline has already had three background jobs
# mis-reported as done.
cd ~/hawkeye/backend || exit 1
DIR=storage/audit-osun2026
MAX_MIN="${1:-120}"
DEADLINE=$(( $(date +%s) + MAX_MIN * 60 ))

echo "waiting for the party pass (deadline ${MAX_MIN} min)..."
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  pgrep -f '[v]lm_party_worker' > /dev/null || break
  sleep 60
done

if pgrep -f '[v]lm_party_worker' > /dev/null; then
  echo "!! TIMED OUT after ${MAX_MIN} min — worker still running, nothing merged."
  python3 scripts/party_run_status.py | tail -3
  exit 1
fi

echo
echo "worker has exited. Final state of the run:"
python3 scripts/party_run_status.py | tail -4
echo

# A worker that died early leaves a partial file that merges perfectly happily
# and produces a real-looking workbook built on a fraction of the data. Say so
# loudly, but still merge — a partial result that is LABELLED partial is useful,
# and re-running the pass resumes rather than restarting.
READ=$(python3 - <<'PY'
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
)
TARGETS=$(python3 -c "import json;print(len(json.load(open('$DIR/party_targets.json'))))")
if [ "$READ" -lt "$TARGETS" ]; then
  echo "!! PARTIAL: ${READ} of ${TARGETS} targeted sheets were read."
  echo "   Merging anyway; re-run scripts/launch_party_run.sh to resume the rest."
  echo
fi

bash scripts/stage0_finish.sh
