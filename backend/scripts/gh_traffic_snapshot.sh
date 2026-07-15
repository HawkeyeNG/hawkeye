#!/bin/bash
# Weekly GitHub traffic snapshot (views/clones only persist 14 days on GitHub).
# Token: fine-grained PAT in ~/.config/hawkeye-gh-token (repo HawkeyeNG/hawkeye,
# permission "Administration: read-only" — or a classic PAT with `repo` scope).
# Appends JSON lines to ~/hawkeye-backups/gh-traffic/{views,clones}.jsonl
set -e
TOKEN_FILE="$HOME/.config/hawkeye-gh-token"
[ -f "$TOKEN_FILE" ] || { echo "[gh-traffic] no token at $TOKEN_FILE — skipping"; exit 0; }
TOKEN=$(tr -d ' \r\n' < "$TOKEN_FILE")
OUT="$HOME/hawkeye-backups/gh-traffic"
mkdir -p "$OUT"
STAMP=$(date -u +%FT%TZ)
for kind in views clones; do
  RESP=$(curl -sf -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/HawkeyeNG/hawkeye/traffic/$kind") || { echo "[gh-traffic] $kind fetch failed"; continue; }
  echo "{\"snapshot\":\"$STAMP\",\"data\":$RESP}" >> "$OUT/$kind.jsonl"
done
# referrers + popular paths (point-in-time, no date series)
for kind in popular/referrers popular/paths; do
  RESP=$(curl -sf -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/HawkeyeNG/hawkeye/traffic/$kind") || continue
  echo "{\"snapshot\":\"$STAMP\",\"data\":$RESP}" >> "$OUT/$(basename $kind).jsonl"
done
echo "[gh-traffic] $STAMP snapshot ok"
