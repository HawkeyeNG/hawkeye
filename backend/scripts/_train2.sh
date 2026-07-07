#!/bin/bash
# Build train2.html (set-2 clone), upload 100 NEW sheets tagged set 2, deploy.
set -e
cd ~/hawkeye/backend
U=$(grep '^GO54_USERNAME=' .env | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' .env | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
B="https://da32.host-ww.net:2222"
D="$HOME/hawkeye/backend/storage/training"
A="$HOME/hawkeye/app"
W=/tmp/train2; rm -rf $W; mkdir -p $W

# 1) train pages: train.html -> set=1; clone train2.html -> set=2
sed -i "s|/api/training/items'|/api/training/items?set=1'|" "$A/train.html"
sed -e "s|/api/training/items?set=1'|/api/training/items?set=2'|" \
    -e 's|<title>[^<]*</title>|<title>Hawkeye — OCR Training (Set 2)</title>|' \
    -e 's|OCR Training|OCR Training — Set 2|g' "$A/train.html" > "$A/train2.html"

# robots: keep internal pages out of indexes
grep -q 'train2.html' "$A/robots.txt" || sed -i 's|Disallow: /train.html|Disallow: /train.html\nDisallow: /train2.html|' "$A/robots.txt"

# 2) what's on the server already (never re-upload / never tag set-1 files)
curl -sk -u "$U:$P" "$B/CMD_API_FILE_MANAGER?path=/hawkeye/backend/storage/training" | tr '&' '\n' | grep -oE '^[^=]+' | sed 's/%2F/\//g' | awk -F/ '{print $NF}' | grep -iE '\.(jpe?g|png)$' > $W/server_files.txt || true
curl -sk -u "$U:$P" "$B/CMD_FILE_MANAGER/hawkeye/backend/storage/training/truth.json?action=download" -o $W/server_truth.json || true
echo "server sheets before: $(wc -l < $W/server_files.txt)"

# 3) pick 100 fresh unlabelled sheets, build sets.json (server files -> 1, new -> 2)
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
random.seed(7)
random.shuffle(pool)
pick = pool[:100]
open(os.path.join(w, 'picks.txt'), 'w').write('\n'.join(pick))
sets = {f: 2 for f in pick}          # existing server files default to set 1
json.dump(sets, open(os.path.join(w, 'sets.json'), 'w'), indent=1)
print(f"pool={len(pool)} picked={len(pick)}")
EOF

# 4) upload sheets in batches of 10 + sets.json + pages + route
n=0; batch=()
flush() {
  [ ${#batch[@]} -eq 0 ] && return
  ARGS=(-F "action=upload" -F "path=/hawkeye/backend/storage/training")
  local k=1
  for f in "${batch[@]}"; do ARGS+=(-F "file$k=@$D/$f"); k=$((k+1)); done
  curl -sk -m 600 -u "$U:$P" "${ARGS[@]}" "$B/CMD_API_FILE_MANAGER" | grep -o 'error=[0-9]*' | head -1
  n=$((n+${#batch[@]})); echo "uploaded $n"
  batch=()
}
while read -r f; do [ -n "$f" ] && { batch+=("$f"); [ ${#batch[@]} -eq 10 ] && flush; }; done < $W/picks.txt
flush
curl -sk -u "$U:$P" -F "action=upload" -F "path=/hawkeye/backend/storage/training" -F "file1=@$W/sets.json" "$B/CMD_API_FILE_MANAGER" | grep -o 'error=[0-9]*'
curl -sk -u "$U:$P" -F "action=upload" -F "path=/hawkeye/app" -F "file1=@$A/train.html" -F "file2=@$A/train2.html" -F "file3=@$A/robots.txt" "$B/CMD_API_FILE_MANAGER" | grep -o 'error=[0-9]*'
curl -sk -u "$U:$P" -F "action=upload" -F "path=/hawkeye/backend/src/routes" -F "file1=@src/routes/training.js" "$B/CMD_API_FILE_MANAGER" | grep -o 'error=[0-9]*'

date > /tmp/restart.txt
curl -sk -u "$U:$P" -F "action=upload" -F "path=/hawkeye/backend/tmp" -F "file1=@/tmp/restart.txt;filename=restart.txt" "$B/CMD_API_FILE_MANAGER" >/dev/null
sleep 10

echo "== verify =="
curl -sk -m 30 'https://hawkeye.com.ng/api/training/items?set=1' | python3 -c "import json,sys;d=json.load(sys.stdin);print('set1 items:',len(d['items']))"
curl -sk -m 30 'https://hawkeye.com.ng/api/training/items?set=2' | python3 -c "import json,sys;d=json.load(sys.stdin);print('set2 items:',len(d['items']))"
echo "train2 page: $(curl -sk -o /dev/null -w '%{http_code}' -m 30 https://hawkeye.com.ng/train2.html)"
rm -rf $W
