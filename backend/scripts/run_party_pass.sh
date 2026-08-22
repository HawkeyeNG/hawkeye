#!/usr/bin/env bash
# Stage 0b: calibrate the party-table pass, then run it on the targets.
#
#   bash scripts/run_party_pass.sh
#
# The order is the whole point. The 20 hand-labelled sheets go first and the
# archive run does not start unless the calibration gate passes. This project
# has twice paid for a full archive run before checking a five-minute
# assumption — a schema that truncated "05" to 0 and deleted votes, and a
# `guided_json` parameter the server silently ignored for two entire runs.
set -e
cd ~/hawkeye/backend
source scripts/pod_env.sh

DIR=storage/audit-osun2026
SHEETS=$DIR/sheets

echo "=============================================="
echo " STEP 1/3  calibrate on the 20 hand-labelled sheets"
echo "=============================================="
# The labelled sheets are the first 20 by unit code.
node -e '
const fs=require("fs");
const labels=JSON.parse(fs.readFileSync("storage/audit-osun2026/hand_labels.json","utf8"));
const units=Object.keys(labels).filter(k=>!k.startsWith("_")).map(u=>({file:u+".jpg"}));
fs.writeFileSync("storage/audit-osun2026/labelled_20.json", JSON.stringify(units,null,2));
console.log("calibration set:", units.length, "sheets");
'

rm -f $DIR/party_20.jsonl
node scripts/vlm_party_worker.mjs \
  --dir $SHEETS \
  --out $DIR/party_20.jsonl \
  --only $DIR/labelled_20.json \
  --concurrency 6

echo
echo "=============================================="
echo " STEP 2/3  the gate"
echo "=============================================="
if ! node scripts/calibrate_party_pass.mjs $DIR/party_20.jsonl $DIR/hand_labels.json $DIR/vlm_full.jsonl; then
  echo
  echo "!! GATE FAILED — archive run NOT started."
  exit 1
fi

echo
echo "=============================================="
echo " STEP 3/3  the archive run"
echo "=============================================="
node scripts/vlm_party_worker.mjs \
  --dir $SHEETS \
  --out $DIR/party_full.jsonl \
  --only $DIR/party_targets.json \
  --concurrency 16

echo
echo "done. merge with:"
echo "  node scripts/merge_party_pass.mjs $DIR/vlm_full.jsonl $DIR/boxes_full.jsonl $DIR/party_full.jsonl $DIR/vlm_stage0b.jsonl"
