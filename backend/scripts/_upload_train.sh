#!/bin/bash
# Upload 100 unlabelled training sheets to the SERVER's storage/training/ so
# train.html can serve them for labelling. Also syncs the server truth.json
# first (so already-labelled keys are excluded and never clobbered).
set -e
cd ~/hawkeye/backend
U=$(grep '^GO54_USERNAME=' .env | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' .env | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
B="https://da32.host-ww.net:2222"
D="$HOME/hawkeye/backend/storage/training"
W=/tmp/traincp; rm -rf $W; mkdir -p $W

# what's already on the server (files + labels)?
curl -sk -u "$U:$P" "$B/CMD_API_FILE_MANAGER?path=/hawkeye/backend/storage/training" | tr '&' '\n' | grep -oE '^[^=]+' | sed 's/%2F/\//g' | awk -F/ '{print $NF}' | grep -iE '\.(jpe?g|png)$' > $W/server_files.txt || true
curl -sk -u "$U:$P" "$B/CMD_FILE_MANAGER/hawkeye/backend/storage/training/truth.json?action=download" -o $W/server_truth.json || true
echo "server already has: $(wc -l < $W/server_files.txt) sheets"

# candidate pool: local unlabelled (not in local truth.json, not already on server)
python3 - "$D" $W <<'EOF'
import json, os, random, sys
d, w = sys.argv[1], sys.argv[2]
truth = set()
for p in (os.path.join(d, 'truth.json'), os.path.join(w, 'server_truth.json')):
    try: truth |= set(json.load(open(p)).keys())
    except Exception: pass
server = set(open(os.path.join(w, 'server_files.txt')).read().split())
imgs = [f for f in os.listdir(d) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
pool = [f for f in imgs if f.rsplit('.', 1)[0] not in truth and f not in server]
random.seed(42)
random.shuffle(pool)
pick = pool[:100]
open(os.path.join(w, 'picks.txt'), 'w').write('\n'.join(pick))
print(f"pool={len(pool)} picked={len(pick)}")
EOF

# upload in batches of 10
i=0; batch=(); n=0
upload_batch() {
  [ ${#batch[@]} -eq 0 ] && return
  ARGS=(-F "action=upload" -F "path=/hawkeye/backend/storage/training")
  local k=1
  for f in "${batch[@]}"; do ARGS+=(-F "file$k=@$D/$f"); k=$((k+1)); done
  local out
  out=$(curl -sk -m 600 -u "$U:$P" "${ARGS[@]}" "$B/CMD_API_FILE_MANAGER" | grep -o 'error=[0-9]*')
  n=$((n+${#batch[@]}))
  echo "batch done ($n uploaded) $out"
  batch=()
}
while read -r f; do
  [ -z "$f" ] && continue
  batch+=("$f"); i=$((i+1))
  [ ${#batch[@]} -eq 10 ] && upload_batch
done < $W/picks.txt
upload_batch

echo "verify server count:"
curl -sk -m 30 https://hawkeye.com.ng/api/training/items | python3 -c "import json,sys;d=json.load(sys.stdin);print('items:',len(d['items']),'labelled:',d['labelled'])"
rm -rf $W
