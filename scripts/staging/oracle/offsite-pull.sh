#!/bin/bash
# GO54's nightly snapshot to two more places — an Oracle disk and R2 — by an hourly timer on an
# Oracle machine (the job: offsite-pull.job). Run from the laptop (repo root).
#
#   offsite-pull.sh push   [election|standby]  install the job + hawkeye-offsite-pull.timer
#   offsite-pull.sh keys   standby             copy the S3_* keys from the election server to the standby
#   offsite-pull.sh run    [election|standby]  one run now, then its log
#   offsite-pull.sh prove  [election|standby]  one FORCED run (does the work even if both places are current)
#   offsite-pull.sh status [election|standby]  the timer, the last runs, the copies on that disk
#   offsite-pull.sh stop   [election|standby]  disable the timer (the copies stay)
#
# WHY TWO MACHINES (28 Oct 2026). Once the Google Drive copies stopped (25 Oct), the election
# server's timer was the only thing making off-site copies, so stopping that idle box to save money
# would have stopped the backups with it. The always-on standby now runs the same job at :13 (the
# election server at :43): either one keeps both places current, and the second run of an hour
# finds them current and exits. The standby already holds production's secrets
# (/etc/hawkeye/secrets.env, for promotion); `keys` adds only the S3_* lines, piped machine to
# machine into a 0600 file, never printed and never written on the laptop. Its R2 tool is a copy of
# backend/scripts/r2cli.mjs + src/services/s3lite.js (node built-ins only), so the job does not
# depend on how the standby's app is laid out.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
CMD="${1:-}"; TARGET="${2:-election}"
case "$TARGET" in
  election)
    . ~/.config/hawkeye/production-oracle.env
    HOST=$STAGING_HOST; RUSER=${STAGING_USER:-ubuntu}; K="${STAGING_SSH_KEY/#\~/$HOME}"; MIN=43 ;;
  standby)
    . ~/.config/hawkeye/standby.env
    HOST=$STANDBY_HOST; RUSER=${STANDBY_USER:-ubuntu}; K="${STANDBY_SSH_KEY/#\~/$HOME}"; MIN=13 ;;
  *) echo "target must be election or standby"; exit 2 ;;
esac
SSH=(ssh -i "$K" -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 "$RUSER@$HOST")
SCP=(scp -q -i "$K" -o IdentitiesOnly=yes)
LIB=/usr/local/lib/hawkeye-offsite

case "$CMD" in
  push)
    T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
    cp scripts/staging/oracle/offsite-pull.job "$T/hawkeye-offsite-pull"
    cat > "$T/hawkeye-offsite-pull.service" <<'U'
[Unit]
Description=Hawkeye: GO54's nightly snapshot to this disk and R2 (scripts/staging/oracle/offsite-pull.sh)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/hawkeye/offsite-pull.env
ExecStart=/usr/local/sbin/hawkeye-offsite-pull
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
U
    cat > "$T/hawkeye-offsite-pull.timer" <<U
[Unit]
Description=Hourly: GO54's nightly snapshot to this disk and R2

[Timer]
OnCalendar=*-*-* *:$MIN:00
Persistent=true

[Install]
WantedBy=timers.target
U
    : > "$T/offsite-pull.env"
    if [ "$TARGET" = standby ]; then
      printf 'OFFSITE_ENV_FILES="/etc/hawkeye/offsite.env /etc/hawkeye/secrets.env"\nOFFSITE_R2CLI=%s/scripts/r2cli.mjs\n' "$LIB" > "$T/offsite-pull.env"
      cp backend/scripts/r2cli.mjs "$T/r2cli.mjs"; cp backend/src/services/s3lite.js "$T/s3lite.js"
    fi
    "${SCP[@]}" "$T"/* "$RUSER@$HOST:/tmp/"
    "${SSH[@]}" "sudo LIB=$LIB TARGET=$TARGET bash -s" <<'R'
set -euo pipefail
install -o root -g root -m 0755 /tmp/hawkeye-offsite-pull /usr/local/sbin/hawkeye-offsite-pull
install -o root -g root -m 0644 /tmp/hawkeye-offsite-pull.service /tmp/hawkeye-offsite-pull.timer /etc/systemd/system/
install -d -o root -g root -m 0755 /etc/hawkeye
if [ -s /tmp/offsite-pull.env ]; then install -o root -g root -m 0644 /tmp/offsite-pull.env /etc/hawkeye/offsite-pull.env; else rm -f /etc/hawkeye/offsite-pull.env; fi
if [ "$TARGET" = standby ]; then
  install -d -o root -g root -m 0755 "$LIB/scripts" "$LIB/src/services"
  install -o root -g root -m 0644 /tmp/r2cli.mjs "$LIB/scripts/r2cli.mjs"
  install -o root -g root -m 0644 /tmp/s3lite.js "$LIB/src/services/s3lite.js"
fi
rm -f /tmp/hawkeye-offsite-pull /tmp/hawkeye-offsite-pull.service /tmp/hawkeye-offsite-pull.timer /tmp/offsite-pull.env /tmp/r2cli.mjs /tmp/s3lite.js
systemctl daemon-reload
systemctl enable --now hawkeye-offsite-pull.timer
systemctl list-timers hawkeye-offsite-pull.timer --no-pager | sed -n 2p
R
    ;;
  keys)
    [ "$TARGET" = standby ] || { echo "keys: only the standby needs them (the election server reads its own app.env)"; exit 2; }
    . ~/.config/hawkeye/production-oracle.env
    PK="${STAGING_SSH_KEY/#\~/$HOME}"
    ssh -i "$PK" -o IdentitiesOnly=yes -o ConnectTimeout=20 "${STAGING_USER:-ubuntu}@$STAGING_HOST" \
      "sudo grep -E '^(S3_ENDPOINT|S3_BUCKET|BACKUP_S3_BUCKET|S3_REGION|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY)=' /run/hawkeye/app.env" \
      | "${SSH[@]}" 'sudo install -d -o root -g root -m 0755 /etc/hawkeye && sudo install -o root -g root -m 0600 /dev/stdin /etc/hawkeye/offsite.env && printf "offsite.env (0600) holds: " && sudo cut -d= -f1 /etc/hawkeye/offsite.env | tr "\n" " " && echo'
    ;;
  run)
    "${SSH[@]}" 'sudo systemctl start hawkeye-offsite-pull.service; sudo journalctl -u hawkeye-offsite-pull -n 4 --no-pager -o cat' ;;
  prove)
    "${SSH[@]}" 'sudo bash -c "set -a; [ -f /etc/hawkeye/offsite-pull.env ] && . /etc/hawkeye/offsite-pull.env; OFFSITE_FORCE=1 exec /usr/local/sbin/hawkeye-offsite-pull"' ;;
  status)
    "${SSH[@]}" 'systemctl list-timers hawkeye-offsite-pull.timer --no-pager | sed -n 2p
      sudo journalctl -u hawkeye-offsite-pull -n 6 --no-pager -o short-iso | cut -c1-200
      sudo ls -l /var/lib/hawkeye-offsite' ;;
  stop)
    "${SSH[@]}" 'sudo systemctl disable --now hawkeye-offsite-pull.timer' ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
