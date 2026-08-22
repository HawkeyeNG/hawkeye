#!/usr/bin/env bash
# What of storage/training is readable WITHOUT authentication?
#   bash scripts/check_training_exposure.sh [base]
#
# `app.use('/training', express.static(trainRoot))` serves the whole directory,
# so anything written there is public by default. That is fine for the sheet
# images — they are INEC's own published documents — and not fine for an
# internal evidence base.
BASE="${1:-http://127.0.0.1:8430}"

for F in truth.json sets.json approved.json dropped.json boxes.json \
         label_meta.json streams.json illegible.json; do
  CODE=$(curl -s -m 8 -o /tmp/hk_exp.json -w '%{http_code}' "${BASE}/training/${F}")
  SIZE=$(wc -c < /tmp/hk_exp.json 2>/dev/null || echo 0)
  printf '  %-18s HTTP %s  %s bytes\n' "$F" "$CODE" "$SIZE"
done
