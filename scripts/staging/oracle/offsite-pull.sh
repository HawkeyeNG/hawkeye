#!/bin/bash
# GO54's nightly snapshot to two more places — the election server's disk and R2 — by an hourly
# timer on the Oracle election server (the job: offsite-pull.job). Run from the laptop (repo root).
#
#   offsite-pull.sh push     install the job + hawkeye-offsite-pull.timer (hourly at :43)
#   offsite-pull.sh run      one run now, then its log
#   offsite-pull.sh status   the timer, the last runs, the copies on this disk and in R2
#   offsite-pull.sh stop     disable the timer (the copies stay)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
. ~/.config/hawkeye/production-oracle.env
K="${STAGING_SSH_KEY/#\~/$HOME}"
SSH=(ssh -i "$K" -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 "ubuntu@$STAGING_HOST")
case "${1:-}" in
  push)
    scp -q -i "$K" -o IdentitiesOnly=yes scripts/staging/oracle/offsite-pull.job "ubuntu@$STAGING_HOST:/tmp/hawkeye-offsite-pull"
    "${SSH[@]}" 'sudo bash -s' <<'R'
set -euo pipefail
install -o root -g root -m 0755 /tmp/hawkeye-offsite-pull /usr/local/sbin/hawkeye-offsite-pull
rm -f /tmp/hawkeye-offsite-pull
cat > /etc/systemd/system/hawkeye-offsite-pull.service <<'U'
[Unit]
Description=Hawkeye: GO54's nightly snapshot to this disk and R2 (scripts/staging/oracle/offsite-pull.sh)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hawkeye-offsite-pull
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
U
cat > /etc/systemd/system/hawkeye-offsite-pull.timer <<'U'
[Unit]
Description=Hourly: GO54's nightly snapshot to this disk and R2

[Timer]
OnCalendar=*-*-* *:43:00
Persistent=true

[Install]
WantedBy=timers.target
U
systemctl daemon-reload
systemctl enable --now hawkeye-offsite-pull.timer
systemctl list-timers hawkeye-offsite-pull.timer --no-pager | sed -n 2p
R
    ;;
  run)
    "${SSH[@]}" 'sudo systemctl start hawkeye-offsite-pull.service; sudo journalctl -u hawkeye-offsite-pull -n 4 --no-pager -o cat' ;;
  status)
    "${SSH[@]}" 'systemctl list-timers hawkeye-offsite-pull.timer --no-pager | sed -n 2p
      sudo journalctl -u hawkeye-offsite-pull -n 6 --no-pager -o short-iso | cut -c1-200
      sudo ls -l /var/lib/hawkeye-offsite' ;;
  stop)
    "${SSH[@]}" 'sudo systemctl disable --now hawkeye-offsite-pull.timer' ;;
  *) sed -n 2,8p "$0"; exit 2 ;;
esac
