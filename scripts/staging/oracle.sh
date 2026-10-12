#!/usr/bin/env bash
# Hawkeye staging on an Oracle Cloud VM instead of AWS: the same on-host setup
# (bootstrap.sh --on-host), carried over SSH.
#
#   oracle.sh --check                        reach the host and print what it is; change nothing
#   oracle.sh [--seed-db FILE] [--readers N] [--allow-dirty]
#
# The VM is created by hand in the Oracle console (README, "Staging on Oracle"):
# display name hawkeye-staging, Ubuntu 24.04 aarch64, VM.Standard.A1.Flex. Its
# address is never written in this repository; it is read from
# ~/.config/hawkeye/staging-oracle.env:
#     STAGING_HOST=...   STAGING_USER=ubuntu   STAGING_SSH_KEY=~/.ssh/hawkeye_oracle
#
# What differs from AWS, and why it is acceptable for a load-test host only:
#   - no SSM: the four secrets are generated ON THE HOST (openssl) into
#     /etc/hawkeye/params (root only) and never leave it;
#   - no S3: an `aws` stand-in (oracle/aws-shim.py) keeps the deploy bundle and
#     the hourly DB backup on the host's own disk, so that copy protects nothing;
#   - Litestream replicates to the same disk until R2 keys are put in
#     /etc/hawkeye/params/litestream/ (R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID,
#     R2_SECRET_ACCESS_KEY);
#   - port 22 is open for this script; 80/443 accept Cloudflare's ranges only
#     (host iptables here; the subnet's security list is set in the console).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
OBJ_BUCKET="hawkeye-staging-local"   # a directory name on the host, not a cloud bucket

CHECK=""; SEED_DB=""; READERS="auto"; DIRTY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --seed-db) SEED_DB="${2:-}"; shift 2 ;;
    --readers) READERS="${2:-}"; shift 2 ;;
    --allow-dirty) DIRTY="--allow-dirty"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done
CONF="${HAWKEYE_STAGING_ORACLE_ENV:-$HOME/.config/hawkeye/staging-oracle.env}"
[ -f "$CONF" ] || die "$CONF not found (STAGING_HOST, STAGING_USER, STAGING_SSH_KEY)"
# shellcheck disable=SC1090
. "$CONF"
: "${STAGING_HOST:?STAGING_HOST missing in $CONF}"
USER_="${STAGING_USER:-ubuntu}"; KEY="${STAGING_SSH_KEY:-$HOME/.ssh/hawkeye_oracle}"; KEY="${KEY/#\~/$HOME}"
[ -f "$KEY" ] || die "SSH key $KEY not found"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 "$USER_@$STAGING_HOST")
SCP=(scp -q -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

# The host must say it is staging before anything is sent to it.
INFO="$("${SSH[@]}" 'n="$(curl -fsS -m 5 -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/displayName || true)"; s="$(curl -fsS -m 5 -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/shape || true)"; echo "$n|$s|$(uname -m)|$(nproc)|$(awk "/MemTotal/{printf \"%.0f\", \$2/1048576}" /proc/meminfo)|$(. /etc/os-release; echo "$PRETTY_NAME")|$(df -BG --output=avail / | tail -1 | tr -d " ")"')"
IFS='|' read -r H_NAME H_SHAPE H_ARCH H_CPU H_MEM H_OS H_DISK <<<"$INFO"
say "host: name '$H_NAME', $H_SHAPE, $H_ARCH, $H_CPU cores, ${H_MEM} GB, $H_OS, $H_DISK free"
[ "$H_NAME" = hawkeye-staging ] || die "the host is not named hawkeye-staging (got '$H_NAME'); refusing"
[ "$H_ARCH" = aarch64 ] || die "expected an arm64 host, got $H_ARCH"
if [ -n "$CHECK" ]; then say "check only: nothing sent, nothing changed"; exit 0; fi

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
# shellcheck disable=SC2086
bash "$HERE/bootstrap.sh" --bundle-only "$W" $DIRTY
STAMP="$(cat "$W/STAMP")"
say "sending release $STAMP"
"${SSH[@]}" 'rm -rf /tmp/hk-deploy && mkdir -m 700 /tmp/hk-deploy'
"${SCP[@]}" "$W/bundle.tgz" "$HERE/bootstrap.sh" "$HERE/oracle/aws-shim.py" "$USER_@$STAGING_HOST:/tmp/hk-deploy/"
EXTRA="--readers $READERS"
if [ -n "$SEED_DB" ]; then
  [ "$(head -c 15 "$SEED_DB")" = "SQLite format 3" ] || die "--seed-db: $SEED_DB is not a SQLite database"
  "${SCP[@]}" "$SEED_DB" "$USER_@$STAGING_HOST:/tmp/hk-deploy/seed.db"; EXTRA="$EXTRA --seed-db"
fi

"${SSH[@]}" "sudo STAMP='$STAMP' BUCKET='$OBJ_BUCKET' EXTRA='$EXTRA' CF_V4='$CF_V4_PINNED' CF_V6='$CF_V6_PINNED' bash -s" <<'REMOTE'
set -euo pipefail
D=/tmp/hk-deploy
install -m 0755 "$D/aws-shim.py" /usr/local/bin/aws
[ -e /usr/bin/aws ] || ln -s /usr/local/bin/aws /usr/bin/aws
# Secrets: made here, kept here. Never printed, never overwritten.
install -d -m 0700 /etc/hawkeye /etc/hawkeye/params /etc/hawkeye/params/env
for p in JWT_SECRET ORACLE_SECRET PHONE_SALT ORIGIN_AUTH_SECRET; do
  if [ -s "/etc/hawkeye/params/env/$p" ]; then echo "secret $p exists, kept"
  else (umask 077; openssl rand -hex 32 > "/etc/hawkeye/params/env/$p"); echo "secret $p created"; fi
done
chmod 0755 /etc/hawkeye   # bootstrap.sh keeps world-readable, non-secret files beside the root-only params
# Firewall: web ports from Cloudflare only. Oracle's Ubuntu image ends INPUT with a REJECT, so insert above it.
for c in $CF_V4; do iptables -C INPUT -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT; done
for c in $CF_V6; do ip6tables -C INPUT -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || ip6tables -I INPUT 1 -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT; done
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || echo "NOTE: netfilter-persistent missing; firewall rules will not survive a reboot"
# The stand-in's object store: where bootstrap.sh expects to download its bundle from.
O="/var/lib/hawkeye/objstore/$BUCKET/deploy/$STAMP"
install -d -m 0755 /var/lib/hawkeye /var/lib/hawkeye/objstore "/var/lib/hawkeye/objstore/$BUCKET"
mkdir -p "$O"; mv "$D/bundle.tgz" "$O/bundle.tgz"; [ ! -f "$D/seed.db" ] || mv "$D/seed.db" "$O/seed.db"
install -m 0700 "$D/bootstrap.sh" /root/hawkeye-bootstrap.sh
rm -rf "$D"
# shellcheck disable=SC2086
HK_PROVIDER=oracle bash /root/hawkeye-bootstrap.sh --on-host --bucket "$BUCKET" --stamp "$STAMP" $EXTRA
REMOTE
say "staging bootstrapped on Oracle: release $STAMP. Log on the host: /var/log/hawkeye-bootstrap.log"
