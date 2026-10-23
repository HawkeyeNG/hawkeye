#!/usr/bin/env bash
# Hawkeye staging on an Oracle Cloud VM instead of AWS: the same on-host setup
# (bootstrap.sh --on-host), carried over SSH.
#
#   oracle.sh --check                        reach the host and print what it is; change nothing
#   oracle.sh [--seed-db FILE] [--readers N] [--allow-dirty]
#   oracle.sh --reuse-release [--readers N]  re-run the host's setup from the release it already
#                                            holds; nothing uploaded (the cutover's `live` step)
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

CHECK=""; SEED_DB=""; READERS="auto"; DIRTY=""; SITE="staging"; REUSE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    # Re-run the host's setup from the release it already holds: NOTHING is uploaded. For the
    # cutover's `live` step (a T-0 write freeze must not wait on the laptop's uplink).
    --reuse-release) REUSE=1; shift ;;
    --site) SITE="${2:-}"; shift 2 ;;
    --seed-db) SEED_DB="${2:-}"; shift 2 ;;
    --readers) READERS="${2:-}"; shift 2 ;;
    --allow-dirty) DIRTY="--allow-dirty"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done
case "$SITE" in staging|production) ;; *) die "--site must be staging or production" ;; esac
# production: the ELECTION server. Its address and key live in production-oracle.env (same three
# names: STAGING_HOST, STAGING_USER, STAGING_SSH_KEY), never in this repository.
CONF="${HAWKEYE_ORACLE_ENV:-$HOME/.config/hawkeye/$SITE-oracle.env}"
[ "$SITE" = staging ] && CONF="${HAWKEYE_STAGING_ORACLE_ENV:-$CONF}"
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
[ "$H_NAME" = "hawkeye-$SITE" ] || die "the host is not named hawkeye-$SITE (got '$H_NAME'); refusing"
[ "$H_ARCH" = aarch64 ] || die "expected an arm64 host, got $H_ARCH"
if [ -n "$CHECK" ]; then say "check only: nothing sent, nothing changed"; exit 0; fi

EXTRA="--readers $READERS --site $SITE"
if [ -n "$REUSE" ]; then
  [ -z "$SEED_DB" ] || die "--reuse-release cannot seed a database (it sends nothing)"
  STAMP="$("${SSH[@]}" 'cat /etc/hawkeye/release 2>/dev/null')"
  [ -n "$STAMP" ] || die "--reuse-release: the host has no release to reuse (/etc/hawkeye/release)"
  "${SSH[@]}" "sudo test -s /var/lib/hawkeye/objstore/$OBJ_BUCKET/deploy/$STAMP/bundle.tgz -a -s /root/hawkeye-bootstrap.sh" \
    || die "--reuse-release: release $STAMP's bundle or bootstrap is missing on the host"
  say "reusing release $STAMP already on the host (nothing uploaded)"
  "${SSH[@]}" 'rm -rf /tmp/hk-deploy && mkdir -m 700 /tmp/hk-deploy'
else
  W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
  # shellcheck disable=SC2086
  bash "$HERE/bootstrap.sh" --bundle-only "$W" $DIRTY
  STAMP="$(cat "$W/STAMP")"
  say "sending release $STAMP"
  "${SSH[@]}" 'mkdir -p -m 700 /tmp/hk-deploy'
  cp "$HERE/bootstrap.sh" "$HERE/oracle/aws-shim.py" "$W/"
  # RESUMABLE (22 Oct 2026: a 9 MB scp stalled for 25 min on a 0.03 MB/s uplink and was cut off
  # before the host did anything). rsync --partial keeps what arrived; each retry continues it.
  sent=""
  for try in 1 2 3 4 5 6; do
    if rsync -q --partial --timeout=90 -e "ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20" \
         "$W/bundle.tgz" "$W/bootstrap.sh" "$W/aws-shim.py" "$USER_@$STAGING_HOST:/tmp/hk-deploy/"; then sent=1; break; fi
    say "upload interrupted (try $try of 6); resuming"
  done
  [ -n "$sent" ] || die "could not upload release $STAMP (uplink too slow); nothing was installed"
  "${SSH[@]}" "test \"\$(sha256sum /tmp/hk-deploy/bundle.tgz | cut -d' ' -f1)\" = '$(sha256sum "$W/bundle.tgz" | cut -d' ' -f1)'" \
    || die "the uploaded bundle does not match ($STAMP); nothing was installed"
fi
if [ -n "$SEED_DB" ]; then
  [ "$(head -c 15 "$SEED_DB")" = "SQLite format 3" ] || die "--seed-db: $SEED_DB is not a SQLite database"
  "${SCP[@]}" "$SEED_DB" "$USER_@$STAGING_HOST:/tmp/hk-deploy/seed.db"; EXTRA="$EXTRA --seed-db"
fi

"${SSH[@]}" "sudo SITE='$SITE' STAMP='$STAMP' BUCKET='$OBJ_BUCKET' EXTRA='$EXTRA' CF_V4='$CF_V4_PINNED' CF_V6='$CF_V6_PINNED' bash -s" <<'REMOTE'
set -euo pipefail
D=/tmp/hk-deploy
# A --reuse-release run sends nothing: the host's own copies (from the last full run) are used.
[ ! -f "$D/aws-shim.py" ] || install -m 0755 "$D/aws-shim.py" /usr/local/bin/aws
[ -e /usr/bin/aws ] || ln -s /usr/local/bin/aws /usr/bin/aws
install -d -m 0700 /etc/hawkeye /etc/hawkeye/params /etc/hawkeye/params/env
if [ "$SITE" = staging ]; then
  # Secrets: made here, kept here. Never printed, never overwritten.
  for p in JWT_SECRET ORACLE_SECRET PHONE_SALT ORIGIN_AUTH_SECRET; do
    if [ -s "/etc/hawkeye/params/env/$p" ]; then echo "secret $p exists, kept"
    else (umask 077; openssl rand -hex 32 > "/etc/hawkeye/params/env/$p"); echo "secret $p created"; fi
  done
else
  # PRODUCTION: NEVER generated. They must be the live site's own, placed by the owner; a new
  # PHONE_SALT or JWT_SECRET would lock every observer out. Stop before anything is installed.
  miss=""
  for p in JWT_SECRET ORACLE_SECRET PHONE_SALT ORIGIN_AUTH_SECRET S3_BUCKET S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    [ -s "/etc/hawkeye/params/env/$p" ] || miss="$miss $p"
  done
  [ -z "$miss" ] || { echo "REFUSED: production needs these in /etc/hawkeye/params/env/ (owner places them):$miss" >&2; exit 1; }
fi
chmod 0755 /etc/hawkeye   # bootstrap.sh keeps world-readable, non-secret files beside the root-only params
# Firewall: web ports from Cloudflare only. Oracle's Ubuntu image ends INPUT with a REJECT, so insert above it.
for c in $CF_V4; do iptables -C INPUT -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT; done
for c in $CF_V6; do ip6tables -C INPUT -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || ip6tables -I INPUT 1 -p tcp -s "$c" -m multiport --dports 80,443 -j ACCEPT; done
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || echo "NOTE: netfilter-persistent missing; firewall rules will not survive a reboot"
# The stand-in's object store: where bootstrap.sh expects to download its bundle from.
O="/var/lib/hawkeye/objstore/$BUCKET/deploy/$STAMP"
install -d -m 0755 /var/lib/hawkeye /var/lib/hawkeye/objstore "/var/lib/hawkeye/objstore/$BUCKET"
mkdir -p "$O"; [ ! -f "$D/bundle.tgz" ] || mv "$D/bundle.tgz" "$O/bundle.tgz"; [ ! -f "$D/seed.db" ] || mv "$D/seed.db" "$O/seed.db"
[ -s "$O/bundle.tgz" ] || { echo "no bundle for release $STAMP on this host" >&2; exit 1; }
[ ! -f "$D/bootstrap.sh" ] || install -m 0700 "$D/bootstrap.sh" /root/hawkeye-bootstrap.sh
rm -rf "$D"
# shellcheck disable=SC2086
HK_PROVIDER=oracle bash /root/hawkeye-bootstrap.sh --on-host --bucket "$BUCKET" --stamp "$STAMP" $EXTRA
REMOTE
say "$SITE bootstrapped on Oracle: release $STAMP. Log on the host: /var/log/hawkeye-bootstrap.log"
