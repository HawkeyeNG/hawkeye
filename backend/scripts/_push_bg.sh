#!/bin/bash
# Persistent background push over ssh.github.com:443 with keepalives; retries a
# flaky uplink until the remote main matches local main.
cd ~/hawkeye
echo "pack: $(du -sh .git/objects | cut -f1)"
echo "largest blobs:"
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' 2>/dev/null \
  | grep '^blob' | sort -k2 -rn | head -5
export GIT_SSH_COMMAND='ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o ConnectTimeout=25 -p 443 -o HostName=ssh.github.com -o StrictHostKeyChecking=accept-new'
LOCAL=$(git rev-parse main)
for i in $(seq 1 40); do
  echo "=== attempt $i $(date +%H:%M:%S) ==="
  git push -u origin main 2>&1 | tail -3
  REMOTE=$(git ls-remote --heads origin main 2>/dev/null | awk '{print $1}')
  if [ "$REMOTE" = "$LOCAL" ]; then
    echo "PUSH OK: main=$LOCAL now on origin"
    exit 0
  fi
  pkill -f 'git-receive-pack' 2>/dev/null
  sleep $((i<10 ? 15 : 45))
done
echo "PUSH FAILED after 40 attempts (local $LOCAL, remote ${REMOTE:-none})"
exit 1
