#!/bin/bash
# Persistent GitHub push over ssh.github.com:443 — retries a flaky uplink.
cd ~/hawkeye
pkill -f 'git-receive-pack' 2>/dev/null
git -c pack.compression=9 repack -adq
du -sh .git/objects | awk '{print "pack size:", $1}'
export GIT_SSH_COMMAND='ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o ConnectTimeout=20 -p 443 -o HostName=ssh.github.com -o StrictHostKeyChecking=accept-new'
for i in $(seq 1 12); do
  echo "attempt $i $(date +%H:%M:%S)"
  if git push -u origin main 2>&1 | tail -2; then
    if git ls-remote --heads origin main 2>/dev/null | grep -q "$(git rev-parse main)"; then
      echo "PUSH OK: $(git rev-parse --short main)"
      exit 0
    fi
  fi
  sleep $((i * 5))
done
echo "PUSH FAILED after 12 attempts"
exit 1
