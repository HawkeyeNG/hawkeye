#!/bin/bash
# PHOTO MACHINES (option B): turn a fresh Ubuntu arm64 box into one that reads result sheets (OCR)
# and checks photos for the election server. Backend side: backend/src/routes/photoJobs.js; the
# program: backend/scripts/photo_worker.mjs. Work is claimed job by job, so machines can be added,
# stopped or lost at any time, and the election server keeps its own low-priority photos processes
# as well (writers-overlay.sh, REMOTE_PHOTOS=1), so the checks never stop.
#
# Run ON THE ELECTION SERVER, as the ssh user, with agent forwarding to reach the photo machine:
#
#   bash photo-machine.sh push <photo machine private IP> [processes, default: its core count]
#
# It copies, inside the private network and never through a laptop: the backend of the release
# that is live here, this server's node binary, and the PHOTO_WORKER_TOKEN from the app params.
# Then it runs `setup` there: a dedicated user, one systemd unit per process (restarts on failure),
# the token in a root-only env file. PHOTO_API (default https://staging.hawkeye.com.ng) is the
# public URL: the photo machine talks to the server through Cloudflare and fetches photos from the
# bucket by signed URL. OCR_WIDTH=1000 reads sheets at 1,000 px: the same figures found as at
# 1,600 on 100 Osun sheets (331 vs 329 of 531) for 20% less CPU. `status` on the photo machine
# shows the units and recent errors.
set -euo pipefail
MODE="${1:-}"
D=/opt/hawkeye-photos
ENVF=/etc/hawkeye/photo-worker.env
case "$MODE" in
  push)
    IP="${2:?usage: photo-machine.sh push <photo machine private IP> [processes]}"; PROCS="${3:-0}"
    API="${PHOTO_API:-https://staging.hawkeye.com.ng}"
    REL="$(readlink -f /opt/hawkeye/current)"
    TOK=/etc/hawkeye/params/env/PHOTO_WORKER_TOKEN
    sudo test -s "$TOK" || { echo "no PHOTO_WORKER_TOKEN in this server's params ($TOK)"; exit 1; }
    S="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 ubuntu@$IP"
    $S "sudo mkdir -p $D.new && sudo chmod 755 $D.new"
    sudo tar -C "$REL" -czf - backend | $S "sudo tar -C $D.new -xzf -"
    $S "sudo install -m 0755 /dev/stdin $D.new/node" < /usr/local/bin/node
    { echo "PHOTO_API=$API"; [ -z "${OCR_WIDTH:-}" ] || echo "OCR_WIDTH=$OCR_WIDTH"; printf 'PHOTO_WORKER_TOKEN='; sudo cat "$TOK"; } \
      | $S "sudo mkdir -p /etc/hawkeye && sudo install -m 0600 -o root -g root /dev/stdin $ENVF"
    $S "sudo bash -s setup $PROCS" < "$0"
    echo "photo machine $IP: release $(basename "$REL") pushed and started"
    ;;
  setup)
    PROCS="${2:-0}"; [ "$PROCS" -gt 0 ] 2>/dev/null || PROCS="$(nproc)"
    [ -x $D.new/node ] && [ -f $D.new/backend/scripts/photo_worker.mjs ] || { echo "nothing pushed to $D.new"; exit 1; }
    id hkphotos >/dev/null 2>&1 || useradd --system --home-dir $D --shell /usr/sbin/nologin hkphotos
    systemctl stop 'hawkeye-photo-worker@*.service' 2>/dev/null || true
    rm -rf $D.old; [ -d $D ] && mv $D $D.old; mv $D.new $D
    chown -R root:root $D; install -d -o hkphotos -g hkphotos $D/cache
    cat > /etc/systemd/system/hawkeye-photo-worker@.service <<EOF
[Unit]
Description=Hawkeye photo machine, process %i (OCR and photo checks for the election server)
After=network-online.target
Wants=network-online.target
[Service]
User=hkphotos
Group=hkphotos
EnvironmentFile=$ENVF
Environment=PHOTO_LABEL=%H-%i
WorkingDirectory=$D/backend
ExecStart=$D/node scripts/photo_worker.mjs
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$D/cache
[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    for u in $(systemctl list-units --all --plain --no-legend 'hawkeye-photo-worker@*.service' | awk '{print $1}'); do
      n="${u#hawkeye-photo-worker@}"; n="${n%.service}"
      [ "$n" -le "$PROCS" ] 2>/dev/null || systemctl disable --now "$u" >/dev/null 2>&1 || true
    done
    for n in $(seq 1 "$PROCS"); do systemctl enable --now "hawkeye-photo-worker@$n.service" >/dev/null 2>&1; done
    sleep 5
    echo "photo machine $(hostname): $(systemctl list-units --state=active --plain --no-legend 'hawkeye-photo-worker@*.service' | wc -l) of $PROCS processes running"
    ;;
  status)
    echo "running: $(systemctl list-units --state=active --plain --no-legend 'hawkeye-photo-worker@*.service' | wc -l)"
    journalctl -u 'hawkeye-photo-worker@*' --since "-10 min" -o cat | grep -v '"done"' | tail -5
    ;;
  *) echo "usage: photo-machine.sh push <ip> [processes] | setup [processes] | status" >&2; exit 2 ;;
esac
