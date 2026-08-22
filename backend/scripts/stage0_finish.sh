#!/usr/bin/env bash
# Finish Stage 0: merge the party pass, re-verify, report, rebuild the workbook.
#
#   bash scripts/stage0_finish.sh
#
# Safe to re-run: every step is file-to-file with no inference, so the
# resolution logic can be changed and this replayed without paying for GPU
# again. Refuses to run while the pass is still going, because merging a
# half-written file produces a real-looking workbook built on partial data.
set -e
cd ~/hawkeye/backend
DIR=storage/audit-osun2026

if pgrep -f '[v]lm_party_worker' > /dev/null; then
  echo "!! the party pass is still running — refusing to merge a partial file."
  python3 scripts/party_run_status.py | tail -3
  exit 1
fi

echo "=============================================="
echo " 1/4  merge the party pass and re-verify"
echo "=============================================="
node scripts/merge_party_pass.mjs \
  $DIR/vlm_full.jsonl \
  $DIR/boxes_full.jsonl \
  $DIR/party_full.jsonl \
  $DIR/vlm_stage0b.jsonl

echo
echo "=============================================="
echo " 2/4  what the pass bought, on the sheets it read"
echo "=============================================="
node scripts/party_pass_value.mjs $DIR/vlm_stage0.jsonl $DIR/vlm_stage0b.jsonl

echo
echo "=============================================="
echo " 3/4  Stage 0 overall"
echo "=============================================="
node scripts/stage0_report.mjs $DIR

echo
echo "=============================================="
echo " 4/4  rebuild the workbook"
echo "=============================================="
python3 scripts/build_audit_workbook.py \
  --state 29 --race "2026 Osun State Governorship Election" \
  --run $DIR/vlm_stage0b.jsonl \
  --out $DIR/osun-2026-governorship-audit.xlsx

echo
echo "done."
