#!/bin/bash
# Copy the files GO54 keeps on its own disk to the election server's disk (cutover, hosting plan
# §4.2): incident media (storage/uploads/incidents) and the OCR training sheets (storage/training).
# Report photos are not here: GO54 has none on disk to move (14 Oct: 0 reports), and new ones go to
# the bucket. Run from the laptop (repo root); the SERVER downloads straight from GO54's file
# manager, the same route as backend/scripts/pull_backup.sh. GO54's login (backend/.env) travels
# over ssh into a root-only file on the server that is removed when the copy ends.
#
#   bash scripts/staging/oracle/go54-files.sh          safe to re-run: files already copied with the
#                                                      right size are skipped (the cutover top-up)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ENVF=backend/.env
U=$(grep '^GO54_USERNAME=' "$ENVF" | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' "$ENVF" | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
[ -n "$U" ] && [ -n "$P" ] || { echo "GO54 login not found in $ENVF" >&2; exit 1; }
. ~/.config/hawkeye/production-oracle.env
K="${STAGING_SSH_KEY/#\~/$HOME}"
{ printf 'machine da32.host-ww.net login %s password %s\n' "$U" "$P"; } \
  | ssh -i "$K" -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 "ubuntu@$STAGING_HOST" \
      'sudo install -m 0600 -o root -g root /dev/stdin /root/.go54-netrc'
ssh -i "$K" -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 "ubuntu@$STAGING_HOST" 'sudo python3 -' <<'PY'
import json, os, re, shutil, subprocess, urllib.parse
B = "https://da32.host-ww.net:2222"
NETRC = "/root/.go54-netrc"
DEST = {"/hawkeye/backend/storage/uploads/incidents": "/var/lib/hawkeye/storage/uploads/incidents",
        "/hawkeye/backend/storage/training": "/var/lib/hawkeye/storage/training"}
def curl(url, out):
    return subprocess.run(["curl", "-fsSk", "-m", "600", "--netrc-file", NETRC, url, "-o", out]).returncode
try:
    for src, dst in DEST.items():
        os.makedirs(dst, exist_ok=True)
        if curl(f"{B}/CMD_API_FILE_MANAGER?path={urllib.parse.quote(src)}&json=yes", "/root/.go54-ls.json"):
            print(f"{src}: listing FAILED"); continue
        listing = json.load(open("/root/.go54-ls.json"))
        files = {}
        for p, v in listing.items():
            if isinstance(v, str) and p.rsplit("/", 1)[0] == src and re.search(r"(?:^|&)type=file", v):
                m = re.search(r"(?:^|&)size=(\d+)", v); files[p.rsplit("/", 1)[1]] = int(m.group(1)) if m else -1
        got = skipped = failed = 0; size = 0
        for name, want in sorted(files.items()):
            if "/" in name or name.startswith("."): continue
            out = os.path.join(dst, name)
            if os.path.exists(out) and os.path.getsize(out) == want: skipped += 1; continue
            part = out + ".part"
            ok = curl(f"{B}/CMD_FILE_MANAGER{urllib.parse.quote(src + '/' + name)}?action=download", part) == 0
            if ok and os.path.getsize(part) == want:
                os.replace(part, out); got += 1; size += want
            else:
                failed += 1
                if os.path.exists(part): os.remove(part)
        subprocess.run(["chown", "-R", "hawkeye:hawkeye", dst])
        print(f"{src} -> {dst}: {len(files)} on GO54 | copied {got} ({size/1e6:.1f} MB) | already there {skipped} | FAILED {failed}")
finally:
    for f in (NETRC, "/root/.go54-ls.json"):
        if os.path.exists(f): os.remove(f)
    print("GO54 login removed from the server:", not os.path.exists(NETRC))
PY
