#!/usr/bin/env bash
# Hawkeye WARM STANDBY — on-host setup. Idempotent: run it again after editing.
#
# Runs ON the standby as root. Normally invoked by `scripts/standby_sync.sh --setup`
# from the laptop, which copies this directory to the host first.
#
# What it does (README.md beside it has the why):
#   1. hardening: key-only SSH (no passwords, no root), fail2ban (sshd),
#      unattended security upgrades, swap, UTC + NTP check
#   2. host firewall (iptables, persisted with netfilter-persistent like the
#      Oracle image): 80/443 from Cloudflare's published ranges only, and the
#      service user may not open ANY outbound connection except loopback
#      (HAWKEYE-EGRESS; opened only by `hawkeye-standby-mode promote-full`)
#   3. runtime: Node 20 (production's major) and Caddy, both pinned by hash,
#      plus the build tools better-sqlite3/sharp need on arm64
#   4. users, directories, env files, the systemd units, the hourly DB pull timer
#
# It never writes a production secret. The env it creates is the minimal
# non-secret one (throwaway session keys generated here, never production's).
# Production's env arrives only through scripts/standby_env_sync.sh, which the
# owner must approve.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"

NODE_VERSION="v20.20.2"   # production runs Node 20 (GO54 Node.js Selector venv .../backend/20/); 20.20.2 is the last 20.x
NODE_SHA256="73093db209e4e9e09dd7d15a47aeaab1b74833830df03efa5f942a1122c5fa71"   # node-v20.20.2-linux-arm64.tar.xz (nodejs.org SHASUMS256.txt)
CADDY_VERSION="2.11.4"
CADDY_SHA512="d5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c"   # caddy_2.11.4_linux_arm64.tar.gz (release checksums file; same pin as scripts/staging)
DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
SWAP_GB=4

# Cloudflare's published ranges (www.cloudflare.com/ips-v4, ips-v6), pinned
# 27 Sep 2026 as in scripts/staging/lib.sh. `hawkeye-standby-cfips` refreshes them weekly.
CF_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

log() { echo "setup: $*"; }
fail() { echo "setup: FAILED: $*" >&2; exit 1; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

# ---- 1. packages ------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
echo "iptables-persistent iptables-persistent/autosave_v4 boolean false" | debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean false" | debconf-set-selections
NEED=""
for p in build-essential python3 sqlite3 rsync fail2ban iptables-persistent netfilter-persistent unattended-upgrades curl ca-certificates xz-utils jq openssl; do
  dpkg -s "$p" >/dev/null 2>&1 || NEED="$NEED $p"
done
if [ -n "$NEED" ]; then
  log "apt install:$NEED"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends $NEED >/dev/null
fi

# ---- 2. SSH: keys only, no root ---------------------------------------------
# 01- sorts before the image's 60-cloudimg-settings.conf; sshd keeps the FIRST value.
cat > /etc/ssh/sshd_config.d/01-hawkeye.conf <<EOF
# Hawkeye standby hardening (scripts/standby/setup_host.sh)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowUsers $DEPLOY_USER
EOF
sshd -t || fail "sshd config does not validate"
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
SSHD_T="$(sshd -T)"   # captured: `sshd -T | grep -q` dies of SIGPIPE under pipefail
grep -qx 'passwordauthentication no' <<<"$SSHD_T" || fail "password auth still on"
grep -qx 'permitrootlogin no' <<<"$SSHD_T" || fail "root login still allowed"
grep -qx 'kbdinteractiveauthentication no' <<<"$SSHD_T" || fail "keyboard-interactive auth still on"
log "ssh: key-only, root login off, AllowUsers $DEPLOY_USER"

# ---- 3. fail2ban ------------------------------------------------------------
cat > /etc/fail2ban/jail.d/hawkeye.local <<'EOF'
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
banaction = iptables-multiport

[sshd]
enabled = true
EOF
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban
sleep 1; fail2ban-client status sshd >/dev/null || fail "fail2ban sshd jail not running"
log "fail2ban: sshd jail on"

# ---- 4. unattended security upgrades (no automatic reboot) --------------------
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52hawkeye-unattended <<'EOF'
// A promoted standby may be serving the election: never reboot by itself.
// Kernel updates wait for a planned `sudo reboot` (check /var/run/reboot-required).
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1
log "unattended-upgrades: on (security pocket, no auto-reboot)"

# ---- 5. swap, time ------------------------------------------------------------
if ! grep -qx /swapfile <<<"$(swapon --show=NAME --noheadings)"; then
  [ -f /swapfile ] || { fallocate -l "${SWAP_GB}G" /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/60-hawkeye-swap.conf; sysctl -q -p /etc/sysctl.d/60-hawkeye-swap.conf
timedatectl set-timezone UTC
timedatectl set-ntp true
[ "$(timedatectl show -p NTPSynchronized --value)" = yes ] || log "WARNING: clock not NTP-synchronised yet"
log "swap ${SWAP_GB}G (swappiness 10), timezone UTC, NTP $(timedatectl show -p NTPSynchronized --value)"

# ---- 6. runtime: Node 20, Caddy -------------------------------------------------
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  log "node $NODE_VERSION"
  curl -fsSL --retry 3 -o "$W/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz"
  echo "$NODE_SHA256  $W/node.tar.xz" | sha256sum -c - >/dev/null || fail "node checksum mismatch"
  rm -rf "/opt/node-$NODE_VERSION"; mkdir -p "/opt/node-$NODE_VERSION"
  tar -xJf "$W/node.tar.xz" -C "/opt/node-$NODE_VERSION" --strip-components=1
  for b in node npm npx; do ln -sfn "/opt/node-$NODE_VERSION/bin/$b" "/usr/local/bin/$b"; done
fi
if ! grep -q "v$CADDY_VERSION" <<<"$(/usr/local/bin/caddy version 2>/dev/null || true)"; then
  log "caddy $CADDY_VERSION"
  curl -fsSL --retry 3 -o "$W/caddy.tgz" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
  echo "$CADDY_SHA512  $W/caddy.tgz" | sha512sum -c - >/dev/null || fail "caddy checksum mismatch"
  tar -xzf "$W/caddy.tgz" -C "$W" caddy && install -m 0755 "$W/caddy" /usr/local/bin/caddy
fi
log "node $(/usr/local/bin/node --version), npm $(/usr/local/bin/npm --version), $(/usr/local/bin/caddy version | cut -d' ' -f1)"

# ---- 7. users and directories ------------------------------------------------------
id hawkeye >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hawkeye --shell /usr/sbin/nologin hawkeye
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 /srv/hawkeye /srv/hawkeye/app /srv/hawkeye/backend
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 /srv/hawkeye-inbox          # snapshots pushed from the laptop
install -d -o hawkeye -g hawkeye -m 0750 /var/lib/hawkeye /var/lib/hawkeye/storage /var/lib/hawkeye/storage/uploads
install -d -o root -g root -m 0700 /var/lib/hawkeye-snapshots                      # verified copies, root-only
install -d -o root -g hawkeye -m 0751 /etc/hawkeye   # o+x: Caddy may traverse to tls/; every file inside is 0640/0600
install -d -o root -g caddy -m 0750 /etc/hawkeye/tls
install -d -o root -g root -m 0755 /etc/caddy /usr/local/libexec/hawkeye

# Production's .env is read by config.js from backend/.env with Node's own
# parser (the same one production uses). Point it at /etc, outside the deploy
# tree; rsync never touches it (.env is excluded). Dangling until env sync runs.
ln -sfn /etc/hawkeye/secrets.env /srv/hawkeye/backend/.env
chown -h "$DEPLOY_USER:$DEPLOY_USER" /srv/hawkeye/backend/.env

# ---- 8. env files (no production secret here) ----------------------------------------
# standby.env: the role. Loaded by systemd AFTER nothing else, so it beats any
# value in production's .env (real environment variables win over the file).
cat > /etc/hawkeye/standby.env <<'EOF'
# Hawkeye warm standby (scripts/standby/setup_host.sh). Real environment
# variables beat backend/.env, so these hold even after production's env lands.
STANDBY=1
ROLE=all
NODE_ENV=production
PORT=8430
HOST_ID=oci-standby
DB_PATH=/var/lib/hawkeye/storage/hawkeye.db
UPLOAD_DIR=/var/lib/hawkeye/storage/uploads
OPS_SWITCHES_FILE=/var/lib/hawkeye/ops-switches.json
UV_THREADPOOL_SIZE=8
EOF
chmod 0640 /etc/hawkeye/standby.env; chgrp hawkeye /etc/hawkeye/standby.env
# local.env: used ONLY while production's env is absent (see hawkeye-standby-run).
# Throwaway keys generated here: production behaviour (APP_ENV=production) without
# a single production secret. Never copied anywhere.
if [ ! -s /etc/hawkeye/local.env ]; then
  umask 027
  {
    echo "# Throwaway, generated on this host $(date -u +%FT%TZ). Not production's. Used only while /etc/hawkeye/secrets.env is absent."
    echo "APP_ENV=production"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "ORACLE_SECRET=$(openssl rand -hex 32)"
    echo "PHONE_SALT=$(openssl rand -hex 32)"
    echo "SMS_PROVIDER=sendchamp"
    echo "SMS_OTP_ENABLED=false"
  } > /etc/hawkeye/local.env
  umask 022
fi
chown root:hawkeye /etc/hawkeye/local.env; chmod 0640 /etc/hawkeye/local.env
[ -f /etc/hawkeye/secrets.env ] && { chown root:hawkeye /etc/hawkeye/secrets.env; chmod 0640 /etc/hawkeye/secrets.env; }
[ -f /etc/hawkeye/pull.env ] && { chown root:root /etc/hawkeye/pull.env; chmod 0600 /etc/hawkeye/pull.env; }

# ---- 9. origin TLS: self-signed until an Origin CA cert is installed --------------------
# Works behind Cloudflare in Flexible (port 80) and Full; Full (strict) needs a
# Cloudflare Origin CA cert, which `hawkeye-standby-mode install-origin-cert` puts
# in place from the CSR below (the key never leaves this host).
if [ ! -s /etc/hawkeye/tls/origin.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=hawkeye.com.ng" \
    -addext "subjectAltName=DNS:hawkeye.com.ng,DNS:*.hawkeye.com.ng" \
    -keyout /etc/hawkeye/tls/origin.key -out /etc/hawkeye/tls/origin.crt 2>/dev/null
  openssl req -new -key /etc/hawkeye/tls/origin.key -subj "/CN=hawkeye.com.ng" \
    -addext "subjectAltName=DNS:hawkeye.com.ng,DNS:*.hawkeye.com.ng" -out /etc/hawkeye/tls/origin.csr 2>/dev/null
fi
chown root:caddy /etc/hawkeye/tls/origin.key /etc/hawkeye/tls/origin.crt; chmod 0640 /etc/hawkeye/tls/origin.key; chmod 0644 /etc/hawkeye/tls/origin.crt
[ -f /etc/hawkeye/tls/origin.csr ] && chmod 0644 /etc/hawkeye/tls/origin.csr

# ---- 10. helpers, Caddy, systemd units ---------------------------------------------------
for f in hawkeye-standby-run hawkeye-standby-pull hawkeye-standby-mode hawkeye-standby-cfips; do
  install -m 0755 -o root -g root "$HERE/$f" "/usr/local/sbin/$f"
done
install -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>"$W/caddy.err" \
  || { cat "$W/caddy.err"; fail "Caddyfile does not validate"; }

cat > /etc/systemd/system/hawkeye-standby.service <<'EOF'
[Unit]
Description=Hawkeye backend — warm standby (STANDBY=1 unless promoted)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hawkeye
Group=hawkeye
WorkingDirectory=/srv/hawkeye/backend
EnvironmentFile=/etc/hawkeye/standby.env
# Exists only after `hawkeye-standby-mode promote-full` (STANDBY=0).
EnvironmentFile=-/etc/hawkeye/promoted.env
# Paths for key files brought by standby_env_sync.sh --with-key-files.
EnvironmentFile=-/etc/hawkeye/paths.env
ExecStart=/usr/local/sbin/hawkeye-standby-run
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/hawkeye
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/hawkeye-caddy.service <<'EOF'
[Unit]
Description=Caddy for the Hawkeye standby (origin TLS behind Cloudflare)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/hawkeye-standby-pull.service <<'EOF'
[Unit]
Description=Hawkeye standby: pull, verify and install the newest production DB snapshot
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hawkeye-standby-pull
Nice=10
IOSchedulingClass=idle
EOF
cat > /etc/systemd/system/hawkeye-standby-pull.timer <<'EOF'
[Unit]
Description=Hourly Hawkeye standby DB pull

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/hawkeye-standby-cfips.service <<'EOF'
[Unit]
Description=Refresh the Cloudflare source ranges allowed to reach 80/443
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hawkeye-standby-cfips
EOF
cat > /etc/systemd/system/hawkeye-standby-cfips.timer <<'EOF'
[Unit]
Description=Weekly Cloudflare range refresh for the Hawkeye standby firewall

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload

# ---- 11. firewall ---------------------------------------------------------------------
# INPUT: the Oracle image ends INPUT with a REJECT; insert our web chain before it.
# OUTPUT: the service user may reach loopback only, unless promote-full opened it.
ipt() { iptables "$@"; }
ip6() { ip6tables "$@"; }
for T in ipt ip6; do
  $T -N HAWKEYE-WEB 2>/dev/null || true
  $T -N HAWKEYE-EGRESS 2>/dev/null || true
done
# web: Cloudflare sources only (+ any temporary ops allowances, which live in HAWKEYE-OPS)
ipt -N HAWKEYE-OPS 2>/dev/null || true
ipt -F HAWKEYE-WEB
for c in $CF_V4; do ipt -A HAWKEYE-WEB -s "$c" -j ACCEPT; done
ipt -A HAWKEYE-WEB -j HAWKEYE-OPS
ipt -A HAWKEYE-WEB -j RETURN
ip6 -F HAWKEYE-WEB
for c in $CF_V6; do ip6 -A HAWKEYE-WEB -s "$c" -j ACCEPT; done
ip6 -A HAWKEYE-WEB -j RETURN
if ! ipt -C INPUT -p tcp -m multiport --dports 80,443 -j HAWKEYE-WEB 2>/dev/null; then
  # before the image's final REJECT (or at the end if there is none)
  pos="$(ipt -L INPUT --line-numbers -n | awk '$2=="REJECT" && $0 ~ /0\.0\.0\.0\/0 +0\.0\.0\.0\/0/ {print $1; exit}')"
  if [ -n "$pos" ]; then ipt -I INPUT "$pos" -p tcp -m multiport --dports 80,443 -j HAWKEYE-WEB
  else ipt -A INPUT -p tcp -m multiport --dports 80,443 -j HAWKEYE-WEB; fi
fi
ip6 -C INPUT -p tcp -m multiport --dports 80,443 -j HAWKEYE-WEB 2>/dev/null \
  || ip6 -A INPUT -p tcp -m multiport --dports 80,443 -j HAWKEYE-WEB
# egress: the service's uid. promote-full flushes HAWKEYE-EGRESS to a bare RETURN.
if [ ! -f /etc/hawkeye/promoted.env ]; then
  for T in ipt ip6; do
    $T -F HAWKEYE-EGRESS
    $T -A HAWKEYE-EGRESS -o lo -j RETURN
    $T -A HAWKEYE-EGRESS -j REJECT
  done
fi
HUID="$(id -u hawkeye)"
for T in ipt ip6; do
  $T -C OUTPUT -m owner --uid-owner "$HUID" -j HAWKEYE-EGRESS 2>/dev/null \
    || $T -A OUTPUT -m owner --uid-owner "$HUID" -j HAWKEYE-EGRESS
done
netfilter-persistent save >/dev/null 2>&1 || fail "netfilter-persistent save"
log "firewall: 80/443 from Cloudflare only (v4+v6), service egress $( [ -f /etc/hawkeye/promoted.env ] && echo OPEN '(promoted)' || echo 'loopback-only' ), saved"

# ---- 12. enable -----------------------------------------------------------------------
systemctl enable hawkeye-standby.service hawkeye-caddy.service >/dev/null 2>&1
systemctl enable --now hawkeye-standby-cfips.timer >/dev/null 2>&1
if [ ! -f /etc/hawkeye/promoted.env ]; then systemctl enable --now hawkeye-standby-pull.timer >/dev/null 2>&1; fi
systemctl restart hawkeye-caddy.service
if [ -f /srv/hawkeye/backend/src/server.js ] && [ -d /srv/hawkeye/backend/node_modules ]; then
  systemctl restart hawkeye-standby.service
  log "hawkeye-standby restarted"
else
  log "code not deployed yet: run scripts/standby_sync.sh --code from the laptop"
fi
log "done"
