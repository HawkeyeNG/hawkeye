#!/usr/bin/env bash
# Prove the audit's internal files are NOT publicly readable.
#
#   bash scripts/test_audit_privacy.sh [base]
#
# The trap this guards against: a 404 on a file that does not exist looks
# exactly like a 404 on a file that is blocked. So the files are CREATED first,
# with recognisable contents, and only then requested. A pass here means the
# denylist is doing the work — not that nobody has clicked "Can't read" yet.
set -e
cd ~/hawkeye/backend
BASE="${1:-http://127.0.0.1:8430}"
TRAIN=storage/training
CANARY='__CANARY_MUST_NOT_BE_PUBLIC__'

restore() {
  for F in illegible label_meta streams; do
    if [ -f "$TRAIN/$F.json.privtest" ]; then mv "$TRAIN/$F.json.privtest" "$TRAIN/$F.json";
    elif [ -f "$TRAIN/$F.json" ] && grep -q "$CANARY" "$TRAIN/$F.json" 2>/dev/null; then rm -f "$TRAIN/$F.json"; fi
  done
}
trap restore EXIT

for F in illegible label_meta streams; do
  [ -f "$TRAIN/$F.json" ] && cp "$TRAIN/$F.json" "$TRAIN/$F.json.privtest"
  printf '{"%s":{"reason":"%s","by":"canary"}}\n' "$CANARY" "$CANARY" > "$TRAIN/$F.json"
done

FAIL=0
echo "these MUST NOT be readable without the passphrase:"
for F in illegible.json label_meta.json streams.json; do
  CODE=$(curl -s -m 8 -o /tmp/hk_priv.json -w '%{http_code}' "${BASE}/training/${F}")
  if grep -q "$CANARY" /tmp/hk_priv.json 2>/dev/null; then
    echo "  LEAK  ${F} — HTTP ${CODE} and the canary came back"
    FAIL=1
  else
    echo "  ok    ${F} — HTTP ${CODE}, no canary"
  fi
done

echo
echo "the admin endpoint MUST refuse an unauthenticated caller:"
CODE=$(curl -s -m 8 -o /tmp/hk_priv2.json -w '%{http_code}' "${BASE}/api/training/meta")
if grep -q "$CANARY" /tmp/hk_priv2.json 2>/dev/null; then
  echo "  LEAK  /api/training/meta returned data unauthenticated (HTTP ${CODE})"
  FAIL=1
else
  echo "  ok    /api/training/meta — HTTP ${CODE}, no canary"
fi

echo
echo "and the sheet images MUST stay public (they are INEC's own documents):"
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "${BASE}/training/truth.json")
echo "  truth.json — HTTP ${CODE} (public by design, predates this change)"

echo
[ "$FAIL" = 0 ] && echo "PASS — nothing internal is publicly readable" || echo "FAIL — see LEAK above"
exit "$FAIL"
