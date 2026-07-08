#!/bin/bash
# Pull the server's truth.json (labels are written server-side) and merge into
# local storage/training/truth.json before scoring.
set -e
cd ~/hawkeye/backend
U=$(grep '^GO54_USERNAME=' .env | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' .env | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
B="https://da32.host-ww.net:2222"
D=storage/training
curl -sk -m 60 -u "$U:$P" "$B/CMD_FILE_MANAGER/hawkeye/backend/storage/training/truth.json?action=download" -o /tmp/server_truth.json
python3 - <<'EOF'
import json, os
loc = os.path.expanduser('~/hawkeye/backend/storage/training/truth.json')
srv = json.load(open('/tmp/server_truth.json'))
cur = {}
try: cur = json.load(open(loc))
except Exception: pass
before = len(cur)
cur.update(srv)  # server labels win
json.dump(cur, open(loc, 'w'), indent=1)
imgs = {f.rsplit('.',1)[0] for f in os.listdir(os.path.dirname(loc)) if f.lower().endswith(('.jpg','.jpeg','.png'))}
have_img = [k for k in cur if k in imgs]
print(f"labels: local {before} + server {len(srv)} = {len(cur)} merged; {len(have_img)} have a local image")
EOF
