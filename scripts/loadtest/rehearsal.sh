#!/usr/bin/env bash
# REHEARSAL DRIVER: load test #1 at the election design point, one checked phase at a time, from
# the laptop. The checklist it follows is docs/private/REHEARSAL-1-PLAN.md. It CALLS the existing
# tools instead of copying them:
#   scripts/loadtest/run.sh (the k6 scenarios and their three production locks)
#   scripts/staging/oracle.sh --check (the host must say it is hawkeye-staging)
#   on the host: hk-reset-staging, hawkeye-peak-mode, hawkeye-restore-test (installed by bootstrap.sh)
#   backend/scripts/seed_staging.mjs, journal_fetch.mjs, journal_restore.mjs, services/ledger.js
#   scripts/staging/oracle/photo-machine.sh (photo machines, pushed from the target)
#
#   rehearsal.sh [--config FILE] [--scale S] [--time-scale T] [--run-id ID] [--dry-run] [--force] COMMAND
#
#   print-config   a config template (put it at ~/.config/hawkeye/rehearsal.env and fill it in)
#   check          target, generators and photo machines reachable, named and sized as configured;
#                  k6, fixtures, reset snapshot, rates and cost of the planned run. Changes nothing.
#   seed           test observers + fixtures ON THE TARGET, a new reset snapshot, then the load
#                  generators loaded inside Oracle's network (scripts, fixtures, origin secret)
#   warm           reset, contest dates, every role answers, a peak-mode round trip, and a short read
#                  through the whole pipeline (generators, sampler, collect)
#   run PHASE      read | upload | auth | ramp | photos-start | photos | restore | all
#   collect        every phase's files to scripts/loadtest/results/rehearsal-<run id>/ (gitignored)
#   report         numbers and gates -> report.md in that directory
#   teardown       undo what this driver set up, reset the target, estimate the cost
#
# --scale multiplies the design point (k6 profile "origin": 400 public + 1,500 signed-in GET/s,
# 250 reports/s, 20 sign-ins/s; ELECTION-NIGHT-HOSTING.md §1.2). 0.05 = today's smoke, 1 = the
# rehearsal, 1.5 = the stress profile (REHEARSAL_SCALE in the config sets the default). --time-scale stretches the ~31-minute ramp shape
# (default 0.1 below scale 0.2, 0.5 below 0.5, else 1).
#
# REFUSES: hawkeye.com.ng and every subdomain but staging; the election server (the address in
# ~/.config/hawkeye/production-oracle.env, any host named hawkeye-production, any host with
# /etc/hawkeye/live); the GO54 origin; any host whose Oracle name is not the configured
# hawkeye-staging*. Addresses come only from ~/.config/hawkeye/*.env, never from this repository.
# No secret is read or printed here: the origin secret and the photo token travel from the target
# to the generators and photo machines inside Oracle's network.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASE_NAME=staging.hawkeye.com.ng          # the only name the load is ever sent to
PROD_ENV="$HOME/.config/hawkeye/production-oracle.env"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac

die() { echo "rehearsal.sh: $*" >&2; exit 2; }
say() { echo "rehearsal.sh: $*" >&2; }
proved() { echo "PROVED: $*"; }
note() { echo "NOTE:   $*"; }

CONFIG="${HAWKEYE_REHEARSAL_ENV:-$HOME/.config/hawkeye/rehearsal.env}"
SCALE=""; TS=""; RUN_ID=""; DRY=""; FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?}"; shift 2 ;;
    --scale) SCALE="${2:?}"; shift 2 ;;
    --time-scale) TS="${2:?}"; shift 2 ;;
    --run-id) RUN_ID="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    --*) die "unknown option '$1' (see --help)" ;;
    *) break ;;
  esac
done
CMD="${1:-}"; [ $# -gt 0 ] && shift
[ -n "$CMD" ] || { sed -n '2,35p' "$0"; exit 2; }

print_config() {
  cat <<'CFG'
# Hawkeye rehearsal driver (scripts/loadtest/rehearsal.sh). PRIVATE: never in the repository.
# Addresses live only in the *-oracle.env files named here.
TARGET_ENV=~/.config/hawkeye/staging-oracle.env   # STAGING_HOST, STAGING_USER, STAGING_SSH_KEY
TARGET_NAME=hawkeye-staging                       # the Oracle display name the target must have
REHEARSAL_SCALE=0.05    # used when --scale is not given: 1 on the rehearsal day
EXPECT_CORES=6          # 16 on the rehearsal day
EXPECT_MEM_GB=12        # 64 on the rehearsal day
EXPECT_ARCH=aarch64
# Load generators: "self" = k6 on the target itself (smoke only; repeat it for several k6
# processes), or one env file per generator (LOADGEN_HOST, LOADGEN_USER, LOADGEN_SSH_KEY).
GENERATORS="self self"
# GENERATORS="~/.config/hawkeye/loadgen-1-oracle.env ~/.config/hawkeye/loadgen-2-oracle.env"
GEN_NAME_PREFIX=hawkeye-loadgen
EXPECT_GEN_CORES=0      # 8 on the day (0 = not checked)
EXPECT_GEN_MEM_GB=0     # 32 on the day
K6_VERSION=v2.3.0       # installed on generators that lack it (checksum-verified)
# Photo machines: "<private address>:<processes>" each, pushed FROM the target. Empty = dry run.
PHOTO_MACHINES=""
PHOTO_NAME_PREFIX=hawkeye-photos
OCR_WIDTH=1000
PHOTO_CORES_PLANNED=76  # election-night photo-machine cores, for the 12-hour projection
# PHOTO_WINDOW_S=1800   # how long `run photos` measures the drain (default 120 below scale 0.5)
LEGACY_READS=1          # the read storm also hits the shapes shipped clients poll
# Cost check: name:family:ocpu:gb for every machine the rehearsal runs (A1 or E5).
COST_MACHINES="hawkeye-staging:A1:6:12"
PLAN_HOURS=1            # how long those machines are up, for the estimate in `check`
BUDGET_USD=30
CFG
}
[ "$CMD" = print-config ] && { print_config; exit 0; }

# ---- configuration ------------------------------------------------------------------------------
[ -f "$CONFIG" ] || die "no config at $CONFIG. Make one: rehearsal.sh print-config > $CONFIG"
# shellcheck disable=SC1090
. "$CONFIG"
exp() { local p="$1"; echo "${p/#\~/$HOME}"; }
TARGET_ENV="$(exp "${TARGET_ENV:-$HOME/.config/hawkeye/staging-oracle.env}")"
TARGET_NAME="${TARGET_NAME:-hawkeye-staging}"
EXPECT_CORES="${EXPECT_CORES:-0}"; EXPECT_MEM_GB="${EXPECT_MEM_GB:-0}"; EXPECT_ARCH="${EXPECT_ARCH:-aarch64}"
GENERATORS="${GENERATORS:-self}"; GEN_NAME_PREFIX="${GEN_NAME_PREFIX:-hawkeye-loadgen}"
EXPECT_GEN_CORES="${EXPECT_GEN_CORES:-0}"; EXPECT_GEN_MEM_GB="${EXPECT_GEN_MEM_GB:-0}"
K6_VERSION="${K6_VERSION:-v2.3.0}"
PHOTO_MACHINES="${PHOTO_MACHINES:-}"; PHOTO_NAME_PREFIX="${PHOTO_NAME_PREFIX:-hawkeye-photos}"
OCR_WIDTH="${OCR_WIDTH:-1000}"; PHOTO_CORES_PLANNED="${PHOTO_CORES_PLANNED:-76}"
LEGACY_READS="${LEGACY_READS:-1}"
COST_MACHINES="${COST_MACHINES:-$TARGET_NAME:A1:$EXPECT_CORES:$EXPECT_MEM_GB}"
PLAN_HOURS="${PLAN_HOURS:-6}"; BUDGET_USD="${BUDGET_USD:-30}"
GO54_HOSTS="${GO54_HOSTS:-da32.host-ww.net}"   # GO54's DirectAdmin server (public in cutover.sh)

num() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]; }
SCALE="${SCALE:-${REHEARSAL_SCALE:-0.05}}"; num "$SCALE" || die "--scale must be a number"
awk "BEGIN{exit !($SCALE > 0 && $SCALE <= 2)}" || die "--scale must be in (0, 2]"
if [ -z "$TS" ]; then TS="$(awk "BEGIN{print ($SCALE < 0.2) ? 0.1 : (($SCALE < 0.5) ? 0.5 : 1)}")"; fi
num "$TS" || die "--time-scale must be a number"
awk "BEGIN{exit !($TS >= 0.05 && $TS <= 3)}" || die "--time-scale must be in [0.05, 3]"
PHOTO_WINDOW_S="${PHOTO_WINDOW_S:-$(awk "BEGIN{print ($SCALE < 0.5) ? 120 : 1800}")}"
# The run id `seed` pinned (a rehearsal day crosses midnight UTC at 01:00 WAT), else date + scale.
CUR="$REPO/scripts/loadtest/results/rehearsal.current"
if [ -z "$RUN_ID" ] && [ -f "$CUR" ] && [ "$CMD" != seed ]; then c="$(cat "$CUR")"; case "$c" in *-x"$SCALE") RUN_ID="$c" ;; esac; fi
RUN_ID="${RUN_ID:-$(date -u +%Y%m%d)-x$SCALE}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "--run-id: letters, digits, . _ - only"
LRES="$REPO/scripts/loadtest/results/rehearsal-$RUN_ID"
SAMPLES=0; awk "BEGIN{exit !($SCALE <= 0.1)}" && SAMPLES=1   # per-request samples only when small
for v in EXPECT_CORES EXPECT_MEM_GB EXPECT_GEN_CORES EXPECT_GEN_MEM_GB OCR_WIDTH PHOTO_CORES_PLANNED PHOTO_WINDOW_S PLAN_HOURS BUDGET_USD; do
  num "${!v}" || die "$v must be a number (config)"
done

# ---- the production refusals (before anything is sent anywhere) -------------------------------
is_prod_name() { case "$1" in staging.hawkeye.com.ng) return 1 ;; hawkeye.com.ng|*.hawkeye.com.ng) return 0 ;; *) return 1 ;; esac; }
is_prod_name "$BASE_NAME" && die "REFUSED: $BASE_NAME is the public production site"
addrs() {  # the IPv4 addresses a host name (or literal) stands for, one per line
  if [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then echo "$1"; else getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u; fi
}
same_addr() { [ -n "$1" ] && [ -n "$2" ] && [ -n "$(comm -12 <(addrs "$1" | sort -u) <(addrs "$2" | sort -u))" ]; }
PROD_HOST=""; if [ -f "$PROD_ENV" ]; then PROD_HOST="$(. "$PROD_ENV" >/dev/null 2>&1; echo "${STAGING_HOST:-}")"; fi
refuse_forbidden() {  # LABEL HOST ENVFILE: never the election server, never GO54, never a production name
  local label="$1" host="$2" envf="${3:-}" g
  [ -n "$host" ] || die "$label: no address in ${envf:-its config}"
  is_prod_name "$host" && die "REFUSED: $label is the production site ($host)"
  if [ -n "$envf" ] && [ -f "$PROD_ENV" ] && [ "$(readlink -f "$envf")" = "$(readlink -f "$PROD_ENV")" ]; then
    die "REFUSED: $label points at production-oracle.env, the ELECTION SERVER"
  fi
  same_addr "$host" "$PROD_HOST" && die "REFUSED: $label has the election server's address"
  for g in $GO54_HOSTS; do same_addr "$host" "$g" && die "REFUSED: $label is the GO54 origin"; done
  return 0
}

[ -f "$TARGET_ENV" ] || die "TARGET_ENV $TARGET_ENV not found"
T_HOST="$(. "$TARGET_ENV"; echo "${STAGING_HOST:-}")"
T_USER="$(. "$TARGET_ENV"; echo "${STAGING_USER:-ubuntu}")"
T_KEY="$(exp "$(. "$TARGET_ENV"; echo "${STAGING_SSH_KEY:-$HOME/.ssh/hawkeye_oracle}")")"
refuse_forbidden target "$T_HOST" "$TARGET_ENV"
[ -f "$T_KEY" ] || die "SSH key $T_KEY not found"
case "$TARGET_NAME" in hawkeye-staging*) ;; *) die "TARGET_NAME must start with hawkeye-staging (got $TARGET_NAME)" ;; esac

SSHO=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 -o BatchMode=yes)
# SSH_TMO=N bounds a call: keepalive alone lets a stalled connection hang ~10 minutes (seen 22 Oct).
tssh() { ${SSH_TMO:+timeout "$SSH_TMO"} ssh "${SSHO[@]}" -i "$T_KEY" "$T_USER@$T_HOST" "$@"; }
tssh_a() { ssh -A "${SSHO[@]}" -i "$T_KEY" "$T_USER@$T_HOST" "$@"; }
troot() { local a="" x; for x in "$@"; do a="$a $(printf '%q' "$x")"; done; tssh "sudo$a bash -s"; }
scrub() { sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g; s/(X-Amz-[A-Za-z]+=)[^&"[:space:]]*/\1<redacted>/g'; }
AGENT=""
agent_up() {  # agent forwarding: the target reaches generators and photo machines with our key
  [ -n "$AGENT" ] && return 0
  eval "$(ssh-agent -s)" >/dev/null; AGENT=1; trap 'ssh-agent -k >/dev/null 2>&1 || true' EXIT
  ssh-add -q "$T_KEY" 2>/dev/null || die "ssh-add $T_KEY failed"
}
testday() { TZ=Africa/Lagos date -d '-9 hours' +%F; }   # the latest date whose 08:30 WAT has passed

# The target must say what it is before anything is changed on it.
TARGET_OK=""; T_CORES=""; T_MEM=""
target_ident() {
  [ -n "$TARGET_OK" ] && return 0
  local info
  info="$(troot <<'R'
md() { curl -fsS -m 5 -H 'Authorization: Bearer Oracle' "http://169.254.169.254/opc/v2/instance/$1" 2>/dev/null || true; }
h="$(curl -fsS --max-time 5 -H @/run/hawkeye/origin-auth.hdr http://127.0.0.1:8430/api/health 2>/dev/null || true)"
he="$(printf '%s' "$h" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d.get("env"), str(d.get("smsOtp")).lower(), str(d.get("waCloud")).lower())
except Exception: print("unreachable - -")' 2>/dev/null)"
echo "$(md displayName)|$(md shape)|$(uname -m)|$(nproc)|$(awk '/MemTotal/{printf "%.0f", $2/1048576}' /proc/meminfo)|$(cat /etc/hawkeye/site 2>/dev/null)|$(grep -c '^APP_ENV=staging$' /etc/hawkeye/staging.env 2>/dev/null || echo 0)|$([ -e /etc/hawkeye/live ] && echo LIVE || echo dormant)|$he"
R
)" || die "cannot reach the target over SSH"
  local name shape arch cores mem site appenv live env sms wa
  IFS='|' read -r name shape arch cores mem site appenv live henv <<<"$info"
  read -r env sms wa <<<"$henv"
  [ "$name" = "$TARGET_NAME" ] || die "REFUSED: the target is named '$name', not $TARGET_NAME"
  case "$name" in *production*) die "REFUSED: the target is named $name" ;; esac
  [ "$site" = staging ] || die "REFUSED: /etc/hawkeye/site on the target says '$site', not staging"
  [ "$appenv" = 1 ] || die "REFUSED: /etc/hawkeye/staging.env does not say APP_ENV=staging"
  [ "$live" = dormant ] || die "REFUSED: /etc/hawkeye/live exists on the target (an election server)"
  [ "$env" = staging ] || die "REFUSED: /api/health on the target says env=$env"
  [ "$sms" = false ] && [ "$wa" = false ] || die "REFUSED: the target reports smsOtp=$sms waCloud=$wa (a real message could be sent)"
  [ "$arch" = "$EXPECT_ARCH" ] || die "the target is $arch, the config expects $EXPECT_ARCH"
  T_CORES="$cores"; T_MEM="$mem"; TARGET_OK=1
  say "target: $name, $shape, $arch, $cores cores, $mem GB, site staging, dormant, health env staging, smsOtp/waCloud false"
}

# ---- the numbers of a run at this scale ---------------------------------------------------------
plan_numbers() {  # SCALE TS -> shell assignments (the origin profile of lib/common.js, the ramp of rampStages)
  python3 - "$1" "$2" <<'PY'
import math, sys
S, T = float(sys.argv[1]), float(sys.argv[2])
jsr = lambda x: math.floor(x + 0.5)                     # JS Math.round
p = {k: jsr(v * S) for k, v in dict(PUB=400, AUTHED=1500, UPLOAD=250, AUTH=20).items()}
st = [(0, .1, 2), (.1, .1, 3), (.1, 1, 10), (1, 1, 10), (1, 1.5, 1), (1.5, 1.5, 2), (1.5, 1, 1), (1, 0, 2)]
secs = [max(10, jsr(m * 60 * T)) for _, _, m in st]
frac = sum(s * (a + b) / 2 for s, (a, b, _) in zip(secs, st))
rep = math.ceil(frac * p['UPLOAD'])
for k, v in p.items(): print(f"R_{k}={v}")
print(f"R_DUR={sum(secs)}"); print(f"R_REPORTS={rep}"); print(f"R_SIGNINS={math.ceil(frac * p['AUTH'])}")
print(f"R_SEED={max(60000, math.ceil(rep / 3 * 1.15))}")
print(f"R_PEAKREQ={jsr(1.5 * (p['PUB'] + p['AUTHED'] + p['AUTH'] + 4 * p['UPLOAD']))}")
PY
}

# ---- load generators ----------------------------------------------------------------------------
G_N=0; declare -a G_SELF G_HOST G_USER G_KEY G_LABEL
load_generators() {
  local g i=0 f
  for g in $GENERATORS; do
    i=$((i + 1))
    if [ "$g" = self ]; then
      G_SELF[$i]=1; G_HOST[$i]="$T_HOST"; G_USER[$i]="$T_USER"; G_KEY[$i]="$T_KEY"; G_LABEL[$i]="self$i"
    else
      f="$(exp "$g")"; [ -f "$f" ] || die "generator config $f not found"
      G_SELF[$i]=""; G_HOST[$i]="$(. "$f"; echo "${LOADGEN_HOST:-}")"; G_USER[$i]="$(. "$f"; echo "${LOADGEN_USER:-ubuntu}")"
      G_KEY[$i]="$(exp "$(. "$f"; echo "${LOADGEN_SSH_KEY:-$HOME/.ssh/hawkeye_oracle}")")"; G_LABEL[$i]="gen$i"
      refuse_forbidden "generator $i" "${G_HOST[$i]}" "$f"
      same_addr "${G_HOST[$i]}" "$T_HOST" && die "generator $i is the target itself: write 'self' instead"
    fi
  done
  G_N=$i; [ "$G_N" -ge 1 ] && [ "$G_N" -le 8 ] || die "GENERATORS: 1 to 8 entries"
}
gssh() { local i="$1"; shift; ${SSH_TMO:+timeout "$SSH_TMO"} ssh "${SSHO[@]}" -i "${G_KEY[$i]}" "${G_USER[$i]}@${G_HOST[$i]}" "$@"; }
gen_ident() {  # I -> "name|arch|cores|memGB|k6 version|privateIP"
  gssh "$1" 'md() { curl -fsS -m 5 -H "Authorization: Bearer Oracle" "http://169.254.169.254/opc/v2/instance/$1" 2>/dev/null || true; }
    echo "$(md displayName)|$(uname -m)|$(nproc)|$(awk "/MemTotal/{printf \"%.0f\", \$2/1048576}" /proc/meminfo)|$( (/usr/local/bin/k6 version 2>/dev/null || echo none) | head -1 | cut -d" " -f2)|$(hostname -I | cut -d" " -f1)"'
}
seg_of() {  # I N -> "a/N:b/N" (k6 execution segment; iterations stay disjoint across generators)
  local i="$1" n="$2"; [ "$n" = 1 ] && { echo -; return; }
  local a="$(( i - 1 ))/$n" b="$i/$n"; [ "$i" = 1 ] && a=0; [ "$i" = "$n" ] && b=1; echo "$a:$b"
}
seq_of() { local n="$1" s=0 k; [ "$n" = 1 ] && { echo -; return; }; for k in $(seq 1 $((n - 1))); do s="$s,$k/$n"; done; echo "$s,1"; }

# The runner each generator keeps in ~/lt: one k6 run of one phase, its exit code in a .done file.
K6_RUNNER='#!/bin/bash
# written by scripts/loadtest/rehearsal.sh: one k6 run of one rehearsal phase on this generator
set -u
RUN=$1 PHASE=$2 I=$3 SCN=$4 SCALE=$5 TS=$6 SEG=$7 SEQ=$8 SAMPLES=$9 LEGACY=${10} BASE=${11} NICE=${12}
D="$HOME/lt/results/$RUN"; O="$D/$PHASE-$I"; mkdir -p "$O"
date +%s > "$O.start"
ulimit -n "$(ulimit -Hn)" 2>/dev/null || ulimit -n 65536 2>/dev/null || true
export ORIGIN_AUTH="$(cat "$HOME/lt/.origin-auth")"
export K6_SUMMARY_MODE=full
export K6_SYSTEM_TAGS=proto,status,method,name,group,check,error_code,scenario,expected_response
[ "$SAMPLES" = 1 ] && export K6_OUT="json=$O/samples.json.gz"
L=(); [ "$LEGACY" = 1 ] && L=(--legacy)
# k6 takes its execution segment from the command line only (K6_EXECUTION_SEGMENT is ignored).
[ "$SEG" = - ] || L+=(--execution-segment "$SEG" --execution-segment-sequence "$SEQ")
cd "$HOME/lt/loadtest" || { echo 2 > "$O.done"; exit 2; }
nice -n "$NICE" bash ./run.sh "$SCN" --base-url "https://$BASE" --profile origin --scale "$SCALE" --time-scale "$TS" \
  --direct-origin "${L[@]}" --fixtures .fixtures/staging.json --out "$O" > "$O.log" 2>&1
echo $? > "$O.done"
'

push_scripts() {  # I: this checkout's scripts/loadtest (public code; never .fixtures or results) and the runner
  tar -C "$REPO/scripts" -cz --exclude=loadtest/.fixtures --exclude=loadtest/results loadtest \
    | gssh "$1" 'mkdir -p -m 700 ~/lt && tar -C ~/lt -xz && chmod 700 ~/lt/loadtest'
  printf '%s' "$K6_RUNNER" | gssh "$1" 'cat > ~/lt/k6-run.sh && chmod 700 ~/lt/k6-run.sh'
}

prepare_generators() {
  local i info name arch cores mem k6v priv tpriv
  tpriv="$(tssh "hostname -I | cut -d' ' -f1")"
  for i in $(seq 1 "$G_N"); do
    if [ -n "${G_SELF[$i]}" ]; then
      [ "$i" -gt 1 ] && [ -n "${G_SELF[1]}" ] && { say "generator $i: self (shares self1's ~/lt)"; continue; }
      push_scripts "$i"
      troot <<'R'
set -euo pipefail
H=/home/ubuntu/lt; F=/var/lib/hawkeye/loadtest/fixtures
rm -rf "$H/loadtest/.fixtures"; install -d -o ubuntu -g ubuntu -m 0700 "$H/loadtest/.fixtures"
cp -p "$F/staging.json" "$F/sheet.jpg" "$F/venue.jpg" "$H/loadtest/.fixtures/"
chown -R ubuntu:ubuntu "$H/loadtest/.fixtures"; chmod -R go-rwx "$H/loadtest/.fixtures"
install -m 0600 -o ubuntu -g ubuntu /etc/hawkeye/params/env/ORIGIN_AUTH_SECRET "$H/.origin-auth"
echo "self: scripts, fixtures ($(du -sh "$H/loadtest/.fixtures" | cut -f1)) and the origin secret in ~ubuntu/lt (mode 700/600)"
R
      continue
    fi
    info="$(gen_ident "$i")" || die "generator $i unreachable"
    IFS='|' read -r name arch cores mem k6v priv <<<"$info"
    case "$name" in "$GEN_NAME_PREFIX"*) ;; *) die "REFUSED: generator $i is named '$name', not $GEN_NAME_PREFIX*" ;; esac
    if [ -n "$DRY" ]; then
      echo "DRY RUN generator $i ($name, $arch, $cores cores, ${mem} GB, k6 $k6v): would install k6 $K6_VERSION if missing, raise nofile and the port range,"
      echo "  push scripts/loadtest, copy fixtures + origin secret target->generator inside the VCN, admit its private address on the target's 80/443"
      continue
    fi
    if [ "$k6v" != "$K6_VERSION" ]; then
      say "generator $i: installing k6 $K6_VERSION (was $k6v), checksum-verified"
      gssh "$i" "sudo V=$K6_VERSION bash -s" <<'R'
set -euo pipefail
case "$(uname -m)" in aarch64) A=arm64 ;; x86_64) A=amd64 ;; *) echo "no k6 build for $(uname -m)"; exit 1 ;; esac
W="$(mktemp -d)"; cd "$W"; N="k6-$V-linux-$A"
curl -fsSL --retry 3 --max-time 300 -o "$N.tar.gz" "https://github.com/grafana/k6/releases/download/$V/$N.tar.gz"
curl -fsSL --retry 3 --max-time 60 -o sums.txt "https://github.com/grafana/k6/releases/download/$V/k6-$V-checksums.txt"
grep " $N.tar.gz\$" sums.txt | sha256sum -c - >/dev/null || { echo "k6 checksum MISMATCH"; exit 1; }
tar -xzf "$N.tar.gz"; install -m 0755 "$N/k6" /usr/local/bin/k6; cd /; rm -rf "$W"
R
    fi
    gssh "$i" 'sudo bash -c "printf \"* soft nofile 200000\n* hard nofile 200000\n\" > /etc/security/limits.d/90-loadtest.conf; sysctl -q -w net.ipv4.ip_local_port_range=\"1024 65535\" net.ipv4.tcp_tw_reuse=1"'
    push_scripts "$i"
    agent_up
    tssh_a "S='ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 ${G_USER[$i]}@$priv'
      sudo tar -C /var/lib/hawkeye/loadtest/fixtures -cz staging.json sheet.jpg venue.jpg | \$S 'rm -rf ~/lt/loadtest/.fixtures && mkdir -m 700 ~/lt/loadtest/.fixtures && tar -C ~/lt/loadtest/.fixtures -xz && chmod -R go-rwx ~/lt/loadtest/.fixtures' &&
      sudo cat /etc/hawkeye/params/env/ORIGIN_AUTH_SECRET | \$S 'umask 077; cat > ~/lt/.origin-auth' &&
      { sudo iptables -C INPUT -p tcp -s $priv -m multiport --dports 80,443 -m comment --comment hawkeye-rehearsal -j ACCEPT 2>/dev/null ||
        sudo iptables -I INPUT 1 -p tcp -s $priv -m multiport --dports 80,443 -m comment --comment hawkeye-rehearsal -j ACCEPT; } &&
      echo 'generator $i: fixtures and origin secret copied inside the network; admitted on the target (temporary rule, not saved)'" | scrub
  done
  [ -n "$tpriv" ] || die "cannot read the target's private address"
}

hosts_map() {  # on|off: each generator resolves staging.hawkeye.com.ng to the TARGET (never Cloudflare)
  local i ip tpriv=""
  [ "$1" = on ] && tpriv="$(tssh "hostname -I | cut -d' ' -f1")"
  for i in $(seq 1 "$G_N"); do
    if [ -n "${G_SELF[$i]}" ]; then ip=127.0.0.1; [ "$i" -gt 1 ] && [ -n "${G_SELF[1]}" ] && continue; else ip="$tpriv"; fi
    if [ "$1" = on ]; then
      gssh "$i" "sudo sed -i '/# hawkeye-rehearsal\$/d' /etc/hosts && echo '$ip $BASE_NAME # hawkeye-rehearsal' | sudo tee -a /etc/hosts >/dev/null"
    else
      gssh "$i" "sudo sed -i '/# hawkeye-rehearsal\$/d' /etc/hosts" || true
    fi
  done
}

# ---- phase bookkeeping ----------------------------------------------------------------------------
mark() { mkdir -p "$LRES"; echo "$(date +%s) $1 $2 scale=$SCALE ts=$TS gens=$G_N" >> "$LRES/phases.log"; }

remote_phase_start() {  # PHASE PEAK(on|off|keep) RESET(1|0)
  troot RUN="$RUN_ID" PHASE="$1" PEAK="$2" RESET="$3" TESTDAY="$(testday)" <<'R'
set -euo pipefail
B=/var/lib/hawkeye/loadtest/rehearsal; RD="$B/$RUN/$PHASE"
TR="$(date +%s)"   # before the reset: the writers restarted by it name their journal files after it
install -d -o hawkeye -g hawkeye -m 0750 "$B" "$B/$RUN"
if [ -f "$RD/sampler.pid" ]; then p="$(cat "$RD/sampler.pid")"; grep -qs rehearsal-sampler "/proc/$p/cmdline" && kill "$p" || true; fi
rm -rf "$RD"; install -d -o hawkeye -g hawkeye -m 0750 "$RD"
REL="$(readlink -f /opt/hawkeye/current)"; C="$REL/backend/src/data/contests.json"
if [ "$RESET" = 1 ]; then
  [ -f "$C.pre-rehearsal" ] || cp -p "$C" "$C.pre-rehearsal"
  python3 - "$C" "$TESTDAY" <<'PY'
import json, sys
p, day = sys.argv[1], sys.argv[2]
d = json.load(open(p)); items = d if isinstance(d, list) else d.get('contests', d)
for c in items:
    if c.get('code') in ('PRES', 'SEN', 'REP'): c['date'] = day
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
PY
  echo "  contest dates PRES/SEN/REP = $TESTDAY (this release only; reporting opens 08:30 WAT that day)"
  if [ "$PEAK" != on ] && [ -f /etc/hawkeye/peak-mode ]; then /usr/local/sbin/hawkeye-peak-mode off | sed 's/^/  /'; fi
  /usr/local/sbin/hk-reset-staging | tail -1 | sed 's/^/  /'
fi
wports() { for u in $(systemctl list-units 'hawkeye-writer*.service' --plain --no-legend | awk '{print $1}'); do systemctl show -p Environment --value "$u" | tr ' ' '\n' | sed -n 's/^PORT=//p'; done; }
for _ in $(seq 1 60); do
  bad=0; for p in $(wports); do curl -fsS --max-time 2 -o /dev/null -H @/run/hawkeye/origin-auth.hdr "http://127.0.0.1:$p/api/health" || bad=1; done
  [ "$bad" = 0 ] && break; sleep 1
done
[ "$bad" = 0 ] || { echo "  a writer does not answer after the reset"; exit 1; }
if [ "$PEAK" = on ] && [ ! -f /etc/hawkeye/peak-mode ]; then /usr/local/sbin/hawkeye-peak-mode on | tail -1 | sed 's/^/  /'
elif [ "$PEAK" = on ] && [ "$RESET" = 1 ]; then
  # Peak mode was already on, so switching it on took no snapshot: take this lineage's base copy now
  # (the journal drill restores from it; every reset starts a new chain with the same ids).
  systemctl start hawkeye-db-backup.service && echo "  peak mode already on: base snapshot of this phase taken"
fi
q() { sqlite3 -readonly "file:/var/lib/hawkeye/storage/hawkeye.db?mode=ro" "$1"; }
drops() { awk '/^TcpExt:/{if(!h){split($0,k);h=1}else{split($0,v);for(i in k)if(k[i]=="ListenDrops")print v[i]}}' /proc/net/netstat; }
printf 'T_RESET=%s\nT0=%s\nCOUNT0=%s\nMAXID0=%s\nDROPS0=%s\nPEAK=%s\nCORES=%s\nOCRDONE0=%s\nANDONE0=%s\n' "$TR" "$(date +%s)" "$(q 'SELECT COUNT(*) FROM submissions')" \
  "$(q 'SELECT COALESCE(MAX(id),0) FROM submissions')" "$(drops)" "$([ -f /etc/hawkeye/peak-mode ] && echo on || echo off)" "$(nproc)" \
  "$(q "SELECT COUNT(*) FROM ocr_jobs WHERE status IN ('done','failed')")" "$(q "SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('done','failed')")" > "$RD/start.env"
cat > "$RD/rehearsal-sampler.sh" <<'S'
#!/bin/bash
# One JSON line every IV seconds: CPU per role, /api/health latency per process (the event-loop
# proxy), box CPU, memory, WAL, disk, listen drops, ledger head. Started and stopped by rehearsal.sh.
OUT="$1"; IV="${2:-2}"; DB=/var/lib/hawkeye/storage/hawkeye.db; HDR=/run/hawkeye/origin-auth.hdr
declare -A PORT=() UNIT=(); NAMES=()
for u in $(systemctl list-units 'hawkeye-*.service' --all --plain --no-legend | awk '{print $1}'); do
  case "$u" in
    hawkeye-writer.service) n=writer1 ;;
    hawkeye-writer[0-9]*.service) n="${u#hawkeye-}"; n="${n%.service}" ;;
    hawkeye-reader@*.service) n="${u#hawkeye-reader@}"; n="reader${n%.service}" ;;
    hawkeye-worker.service) n=worker ;;
    hawkeye-photos[0-9]*.service) n="${u#hawkeye-}"; n="${n%.service}" ;;
    hawkeye-caddy.service) n=caddy ;;
    hawkeye-litestream.service) n=litestream ;;
    hawkeye-peak-checkpoint.service) n=checkpoint ;;
    *) continue ;;
  esac
  NAMES+=("$n"); UNIT[$n]="$u"
  p="$(systemctl show -p Environment --value "$u" | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"; [ -n "$p" ] && PORT[$n]="$p"
done
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
while :; do
  s0="$(date +%s%N)"
  for n in "${!PORT[@]}"; do
    ( curl -s -o /dev/null -w '%{time_total}' --max-time 2 -H @"$HDR" "http://127.0.0.1:${PORT[$n]}/api/health" > "$T/$n" 2>/dev/null || echo -1 > "$T/$n" ) &
  done
  wait
  cpu=""; for n in "${NAMES[@]}"; do v="$(systemctl show -p CPUUsageNSec --value "${UNIT[$n]}" | tr -cd '0-9')"; cpu="$cpu\"$n\":${v:-0},"; done
  pr=""; for n in "${!PORT[@]}"; do v="$(cat "$T/$n" 2>/dev/null)"; pr="$pr\"$n\":$(awk -v v="${v:--1}" 'BEGIN{ if (v < 0) print -1; else printf "%.1f", v*1000 }'),"; done
  read -r busy idle < <(awk '/^cpu /{print $2+$3+$4+$7+$8, $5+$6}' /proc/stat)
  printf '{"t":%s,"load":%s,"mem":%s,"wal":%s,"disk":%s,"drops":%s,"maxid":%s,"busy":%s,"idle":%s,"cpu":{%s},"probe":{%s}}\n' \
    "$(date +%s.%N | cut -c1-14)" "$(cut -d' ' -f1 /proc/loadavg)" "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" \
    "$(stat -c %s "$DB-wal" 2>/dev/null || echo 0)" "$(df -Pm / | awk 'NR==2{print $4}')" \
    "$(awk '/^TcpExt:/{if(!h){split($0,k);h=1}else{split($0,v);for(i in k)if(k[i]=="ListenDrops")print v[i]}}' /proc/net/netstat)" \
    "$(sqlite3 -readonly "file:$DB?mode=ro" 'SELECT COALESCE(MAX(id),0) FROM submissions;' 2>/dev/null || echo -1)" \
    "$busy" "$idle" "${cpu%,}" "${pr%,}" >> "$OUT"
  left=$(( IV * 1000 - ( $(date +%s%N) - s0 ) / 1000000 )); [ "$left" -gt 0 ] && sleep "$(awk -v m="$left" 'BEGIN{printf "%.3f", m/1000}')"
done
S
setsid nohup bash "$RD/rehearsal-sampler.sh" "$RD/monitor.log" 2 > /dev/null 2>&1 < /dev/null &
echo $! > "$RD/sampler.pid"
echo "  sampler running (every 2 s: CPU per role, health latency per process, WAL, listen drops, ledger head)"
R
}

remote_phase_end() {  # PHASE -> stop the sampler; ledger, journal and queue numbers into post.env
  troot RUN="$RUN_ID" PHASE="$1" <<'R'
set -uo pipefail
RD="/var/lib/hawkeye/loadtest/rehearsal/$RUN/$PHASE"; [ -d "$RD" ] || { echo "  no $RD"; exit 1; }
if [ -f "$RD/sampler.pid" ]; then p="$(cat "$RD/sampler.pid")"; grep -qs rehearsal-sampler "/proc/$p/cmdline" && kill "$p"; rm -f "$RD/sampler.pid"; fi
REL="$(readlink -f /opt/hawkeye/current)"
P=(); for f in $(systemctl cat hawkeye-writer.service | sed -n 's/^EnvironmentFile=-\{0,1\}//p'); do P+=(-p "EnvironmentFile=$f"); done
cat > "$RD/ledger.mjs" <<'JS'
// The whole chain re-hashed from genesis by services/ledger.js, on a READ-ONLY connection, plus forks.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const REL = process.env.REL;
const Database = createRequire(`${REL}/backend/package.json`)('better-sqlite3');
const { verifyChainAsync } = await import(pathToFileURL(`${REL}/backend/src/services/ledger.js`).href);
const db = new Database(process.env.DBF, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 10000');
const t0 = Date.now();
const r = await verifyChainAsync(db);
const forks = db.prepare('SELECT COUNT(*) AS c FROM (SELECT prev_hash FROM submissions GROUP BY prev_hash HAVING COUNT(*) > 1)').get().c;
const n = db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM submissions').get();
console.log(JSON.stringify({ chainOk: r.chainOk, columnsOk: r.columnsOk ?? null, mismatched: r.columns?.mismatched ?? null,
  entries: r.entries, count: n.c, maxId: n.m, forks, brokenAtId: r.brokenAtId ?? null, head: String(r.head || '').slice(0, 16), ms: Date.now() - t0 }));
JS
chown hawkeye:hawkeye "$RD/ledger.mjs"
systemd-run --quiet --wait --collect -u "hkreh-ledger-$RANDOM" -p User=hawkeye -p Group=hawkeye -p WorkingDirectory="$REL/backend" "${P[@]}" \
  -E REL="$REL" -E DBF=/var/lib/hawkeye/storage/hawkeye.db -p StandardOutput=truncate:"$RD/ledger.json" -p StandardError=truncate:"$RD/ledger.err" \
  /usr/local/bin/node "$RD/ledger.mjs" || echo "  the ledger check exited non-zero (see ledger.err)"
jl=0; jp=0
for u in $(systemctl list-units 'hawkeye-writer*.service' --plain --no-legend | awk '{print $1}'); do
  p="$(systemctl show -p Environment --value "$u" | tr ' ' '\n' | sed -n 's/^PORT=//p')"
  read -r a b < <(curl -fsS --max-time 5 -H @/run/hawkeye/origin-auth.hdr "http://127.0.0.1:$p/api/health" | python3 -c 'import json,sys
j=json.load(sys.stdin).get("journal") or {}; print(j.get("lines", 0), j.get("pendingBytes", 0))' 2>/dev/null || echo "0 0")
  jl=$((jl + a)); jp=$((jp + b))
done
q() { sqlite3 -readonly "file:/var/lib/hawkeye/storage/hawkeye.db?mode=ro" "$1"; }
printf 'T1=%s\nCOUNT1=%s\nJOURNAL_LINES=%s\nJOURNAL_PENDING=%s\nDROPS1=%s\nFAILED_UNITS=%s\nOCR_QUEUED=%s\nAN_QUEUED=%s\nOCRDONE1=%s\nANDONE1=%s\nPEAK1=%s\n' \
  "$(date +%s)" "$(q 'SELECT COUNT(*) FROM submissions')" "$jl" "$jp" \
  "$(awk '/^TcpExt:/{if(!h){split($0,k);h=1}else{split($0,v);for(i in k)if(k[i]=="ListenDrops")print v[i]}}' /proc/net/netstat)" \
  "$(systemctl list-units 'hawkeye-*' --state=failed --plain --no-legend | awk '{print $1}' | tr '\n' ',' )" \
  "$(q "SELECT COUNT(*) FROM ocr_jobs WHERE status IN ('queued','running')")" "$(q "SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('queued','running')")" \
  "$(q "SELECT COUNT(*) FROM ocr_jobs WHERE status IN ('done','failed')")" "$(q "SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('done','failed')")" \
  "$([ -f /etc/hawkeye/peak-mode ] && echo on || echo off)" > "$RD/post.env"
chown -R hawkeye:hawkeye "$RD"
echo "  ledger: $(cat "$RD/ledger.json" 2>/dev/null || echo none) | journal lines $jl, unshipped bytes $jp"
R
}

target_status() {  # one progress line while k6 runs; exit 3 = an abort criterion
  troot <<'R'
f="$(systemctl list-units 'hawkeye-*' --state=failed --plain --no-legend | awk '{print $1}' | grep -v -E 'db-backup|litestream-interval' | tr '\n' ' ')"
m="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"; d="$(df -Pm / | awk 'NR==2{print int($4/1024)}')"
w="$(( $(stat -c %s /var/lib/hawkeye/storage/hawkeye.db-wal 2>/dev/null || echo 0) / 1048576 ))"
n="$(sqlite3 -readonly 'file:/var/lib/hawkeye/storage/hawkeye.db?mode=ro' 'SELECT COALESCE(MAX(id),0) FROM submissions;' 2>/dev/null)"
echo "target: ledger head #$n | load $(cut -d' ' -f1 /proc/loadavg) of $(nproc) | free memory ${m} MB | disk ${d} GB | WAL ${w} MB | failed units: ${f:-none}"
[ -z "$f" ] && [ "$m" -gt 400 ] && [ "$d" -gt 5 ] && [ "$w" -lt 4096 ] || exit 3
R
}

stop_k6() {  # PHASE: SIGTERM to each k6 process group (k6 stops gracefully and still writes its summary)
  local i
  for i in $(seq 1 "$G_N"); do
    gssh "$i" "f=~/lt/results/$RUN_ID/$1-$i.pid; [ -f \$f ] && kill -TERM -- -\$(cat \$f) 2>/dev/null; true" || true
  done
}

run_k6_phase() {  # PHASE SCENARIO PEAK
  local phase="$1" scn="$2" peak="$3" i maxwait t done_all codes leg=0 nicev
  eval "$(plan_numbers "$SCALE" "$TS")"
  case "$scn" in read) [ "$LEGACY_READS" = 1 ] && leg=1 ;; esac
  maxwait=$(( R_DUR * 13 / 10 + 300 ))
  say "phase $phase: $scn at x$SCALE (public $R_PUB/s, signed-in $R_AUTHED/s, reports $R_UPLOAD/s, sign-ins $R_AUTH/s at 100%; +50% spike), time-scale $TS (~$(( R_DUR / 60 )) min), $G_N k6 process(es), peak mode $peak"
  mark "$phase" start
  for i in $(seq 1 "$G_N"); do   # every generator runs this checkout's scenarios (fixtures stay)
    [ -n "${G_SELF[$i]}" ] && [ "$i" -gt 1 ] && [ -n "${G_SELF[1]}" ] && continue
    gssh "$i" 'test -s ~/lt/loadtest/.fixtures/staging.json && test -s ~/lt/.origin-auth' || die "generator $i is not loaded: run seed"
    push_scripts "$i"
  done
  remote_phase_start "$phase" "$peak" 1
  hosts_map on
  trap 'say "interrupted: stopping k6, the sampler and the hosts mapping"; stop_k6 "$phase"; hosts_map off; remote_phase_end "$phase" >/dev/null 2>&1 || true; mark "$phase" interrupted; exit 130' INT TERM
  for i in $(seq 1 "$G_N"); do
    nicev=0; [ -n "${G_SELF[$i]}" ] && nicev=5
    gssh "$i" "rm -f ~/lt/results/$RUN_ID/$phase-$i.done; mkdir -p ~/lt/results/$RUN_ID; setsid nohup bash ~/lt/k6-run.sh $RUN_ID $phase $i $scn $SCALE $TS $(seg_of "$i" "$G_N") $(seq_of "$G_N") $SAMPLES $leg $BASE_NAME $nicev > /dev/null 2>&1 < /dev/null & echo \$! > ~/lt/results/$RUN_ID/$phase-$i.pid"
  done
  say "k6 started on $G_N process(es); polling every 15 s (abort criteria checked every minute)"
  t=0; codes=""
  while :; do
    sleep 15; t=$((t + 15)); done_all=1; codes=""; [ $((t % 30)) = 0 ] && say "k6 running: ${t}s of ~${R_DUR}s"
    for i in $(seq 1 "$G_N"); do
      c="$(SSH_TMO=40 gssh "$i" "cat ~/lt/results/$RUN_ID/$phase-$i.done 2>/dev/null" || true)"; [ -n "$c" ] || done_all=""; codes="$codes ${c:--}"
    done
    [ -n "$done_all" ] && break
    if [ $((t % 60)) = 0 ]; then
      set +e; SSH_TMO=60 target_status 2>&1 | scrub; rc="${PIPESTATUS[0]}"; set -e
      if [ "$rc" = 3 ]; then say "ABORT: an abort criterion is met on the target; stopping k6"; stop_k6 "$phase"; sleep 40; mark "$phase" aborted; break
      elif [ "$rc" != 0 ]; then say "status check did not answer (exit $rc); k6 keeps running"; fi
    fi
    if [ "$t" -ge "$maxwait" ]; then say "k6 still running after ${maxwait}s: stopping it"; stop_k6 "$phase"; sleep 40; break; fi
  done
  trap - INT TERM
  hosts_map off
  remote_phase_end "$phase" | scrub
  mark "$phase" "end k6=${codes# }"
  say "k6 exit codes:${codes} (0 = all thresholds met, 99 = a threshold crossed, other = error)"
  i=0; for c in $codes; do
    i=$((i + 1)); case "$c" in 0|99) ;; *) say "generator $i did not complete (exit $c); the end of its log:"
      gssh "$i" "tail -8 ~/lt/results/$RUN_ID/$phase-$i.log" 2>&1 | scrub | sed 's/^/    /' ;; esac
  done
  collect_all >/dev/null
  report_cmd "$phase"
}

# ---- commands -------------------------------------------------------------------------------------
check_cmd() {
  local fails=0 i info name arch cores mem k6v priv ok
  bad() { echo "FAIL:   $*"; fails=$((fails + 1)); }
  echo "== target"
  HAWKEYE_STAGING_ORACLE_ENV="$TARGET_ENV" bash "$REPO/scripts/staging/oracle.sh" --check 2>&1 | scrub
  target_ident
  [ "$EXPECT_CORES" = 0 ] || [ "$T_CORES" = "$EXPECT_CORES" ] && proved "target has $T_CORES cores (config: $EXPECT_CORES)" || bad "target has $T_CORES cores, the config expects $EXPECT_CORES"
  awk "BEGIN{exit !($EXPECT_MEM_GB == 0 || ($T_MEM >= $EXPECT_MEM_GB - 1 && $T_MEM <= $EXPECT_MEM_GB + 1))}" && proved "target has $T_MEM GB (config: $EXPECT_MEM_GB)" || bad "target has $T_MEM GB, the config expects $EXPECT_MEM_GB"
  eval "$(plan_numbers "$SCALE" "$TS")"
  local rout
  rout="$(troot NEED="$R_SEED" <<'R' | scrub
F=/var/lib/hawkeye/loadtest/fixtures; SD=/var/lib/hawkeye/snapshots; REL="$(readlink -f /opt/hawkeye/current)"
echo "release $(basename "$REL") | writers.conf: $(tr '\n' ' ' < /etc/hawkeye/writers.conf 2>/dev/null || echo none)"
/usr/local/sbin/hawkeye-peak-mode status | head -1
echo "params present (names only): $(ls /etc/hawkeye/params/env/ | tr '\n' ' ')"
python3 - "$F/staging.json" "$NEED" <<'PY'
import json, os, sys, time
p, need = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(p)); a = d['attest']; age = (time.time() * 1000 - a['checkedAt']) / 3.6e6
    ok = a.get('otpStub') and age < 23 and len(d.get('upload', [])) >= need
    print(('PROVED: ' if ok else 'NOTE:   ') + 'fixtures on the target: %d upload + %d auth observers (need %d), %d units, %d parties, made for %s, OTP stub %s, %.1f h old%s'
          % (len(d.get('upload', [])), len(d.get('auth', [])), need, len(d.get('pus', [])), len(d.get('parties', [])), a.get('host'), a.get('otpStub'), age,
             '' if ok else ' -> run `seed` (k6 refuses fixtures over 24 h; the pool must cover the reports)'))
except Exception as e:
    print('NOTE:   no usable fixtures on the target (%s) -> run `seed`' % e)
for f in ('sheet.jpg', 'venue.jpg'):
    q = os.path.join(os.path.dirname(p), f)
    print(('PROVED: ' if os.path.exists(q) else 'NOTE:   ') + 'synthetic %s %s' % (f, ('%d KB' % (os.path.getsize(q) // 1024)) if os.path.exists(q) else 'missing -> `seed` makes it'))
PY
s="$(ls -1t $SD/pre-test-*.db 2>/dev/null | head -1)"
[ -n "$s" ] && echo "PROVED: reset snapshot $(basename "$s") ($(du -h "$s" | cut -f1), $(sqlite3 "file:$s?mode=ro" 'SELECT COUNT(*) FROM submissions;') reports)" || echo "FAIL:   no pre-test snapshot: hk-reset-staging has nothing to restore"
python3 - "$REL/backend/src/data/contests.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); items = d if isinstance(d, list) else d.get('contests', d)
print('NOTE:   contest dates now', ', '.join('%s %s' % (c.get('code'), c.get('date')) for c in items if c.get('code') in ('PRES', 'SEN', 'REP')), '(each run sets them to the test day)')
PY
echo "NOTE:   seed_staging.mjs in this release: $([ -f "$REL/backend/scripts/seed_staging.mjs" ] && echo yes || echo 'no (seed copies it in)')"
echo "NOTE:   disk $(df -h / | awk 'NR==2{print $4}') free, memory $(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo) GB available, failed units: $(systemctl list-units 'hawkeye-*' --state=failed --plain --no-legend | wc -l)"
R
)"
  echo "$rout"; fails=$((fails + $(grep -c '^FAIL' <<<"$rout" || true)))
  echo "== generators ($GENERATORS)"
  for i in $(seq 1 "$G_N"); do
    info="$(gen_ident "$i" 2>/dev/null)" || { bad "generator $i unreachable"; continue; }
    IFS='|' read -r name arch cores mem k6v priv <<<"$info"
    if [ -n "${G_SELF[$i]}" ]; then
      [ "$name" = "$TARGET_NAME" ] || bad "self generator $i is '$name'"
      ok="$(gssh "$i" "test -s ~/lt/loadtest/.fixtures/staging.json && test -s ~/lt/.origin-auth && test -x ~/lt/k6-run.sh && echo yes || echo no")"
      echo "generator $i: self (k6 on the target, nice 5), k6 $k6v, loaded: $ok"
      [ "$ok" = yes ] || note "generator $i not loaded yet -> run seed"
    else
      case "$name" in "$GEN_NAME_PREFIX"*) ;; *) bad "generator $i is named '$name', not $GEN_NAME_PREFIX*" ;; esac
      ok="$(gssh "$i" "test -s ~/lt/loadtest/.fixtures/staging.json && test -s ~/lt/.origin-auth && test -x ~/lt/k6-run.sh && echo yes || echo no")"
      echo "generator $i: $name, $arch, $cores cores, ${mem} GB, k6 $k6v, loaded: $ok"
      [ "$EXPECT_GEN_CORES" = 0 ] || [ "$cores" -ge "$EXPECT_GEN_CORES" ] || bad "generator $i has $cores cores (config: $EXPECT_GEN_CORES)"
      [ "$EXPECT_GEN_MEM_GB" = 0 ] || [ "$mem" -ge $((EXPECT_GEN_MEM_GB - 1)) ] || bad "generator $i has $mem GB (config: $EXPECT_GEN_MEM_GB)"
      [ "$k6v" = "$K6_VERSION" ] || note "generator $i has k6 $k6v; seed installs $K6_VERSION"
    fi
    case "$k6v" in v0.*|none) [ -n "${G_SELF[$i]}" ] && bad "k6 >= 1.0 is required on the target for self mode" ;; esac
  done
  echo "== photo machines"
  if [ -z "$PHOTO_MACHINES" ]; then
    note "none configured: run photos-start / photos are DRY RUNS (the target's own 2 low-priority photos processes are measured instead)"
  else
    agent_up
    for pm in $PHOTO_MACHINES; do
      ip="${pm%%:*}"
      r="$(tssh_a "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 ubuntu@$ip 'echo \$(curl -fsS -m 5 -H \"Authorization: Bearer Oracle\" http://169.254.169.254/opc/v2/instance/displayName)\|\$(uname -m)\|\$(nproc)'" 2>/dev/null || echo "unreachable||")"
      IFS='|' read -r name arch cores <<<"$r"
      case "$name" in "$PHOTO_NAME_PREFIX"*) proved "photo machine $name ($arch, $cores cores) reachable from the target, ${pm##*:} processes planned" ;; *) bad "photo machine at <private address> is '$name', not $PHOTO_NAME_PREFIX*" ;; esac
      [ "$arch" = "$EXPECT_ARCH" ] || bad "photo machine $name is $arch: photo-machine.sh copies the target's $EXPECT_ARCH node and node_modules"
    done
  fi
  echo "== the run at x$SCALE, time-scale $TS"
  echo "rates at 100% of the shape: public reads $R_PUB/s, signed-in reads $R_AUTHED/s, reports $R_UPLOAD/s (4 requests each), sign-ins $R_AUTH/s; spike peak ~$R_PEAKREQ requests/s"
  echo "each k6 phase ~$(( R_DUR / 60 )) min; reports per upload/ramp phase ~$R_REPORTS (needs $R_SEED upload observers); sign-in flows per auth/ramp phase ~$R_SIGNINS"
  cost_estimate "$PLAN_HOURS" "planned"
  echo
  [ "$fails" = 0 ] && echo "check: everything required is in place (NOTE lines are for seed/run to handle)" || { echo "check: $fails FAILED"; return 1; }
}

cost_estimate() {  # HOURS LABEL
  python3 - "$COST_MACHINES" "$1" "$2" "$BUDGET_USD" <<'PY'
import sys
machines, hours, label, budget = sys.argv[1].split(), float(sys.argv[2]), sys.argv[3], float(sys.argv[4])
price = {'A1': (0.010, 0.0015), 'E5': (0.030, 0.002)}   # list $/OCPU-h, $/GB-h; E5 (verify)
tot = 0; parts = []
for m in machines:
    name, fam, ocpu, gb = m.split(':'); po, pg = price.get(fam, price['A1'])
    c = (float(ocpu) * po + float(gb) * pg) * hours; tot += c; parts.append('%s %s %s/%s $%.2f' % (name, fam, ocpu, gb, c))
print('cost (%s, %.1f h at Oracle list price): %s = $%.2f of a $%.0f budget%s' % (label, hours, '; '.join(parts), tot, budget, '' if tot <= budget else '  OVER BUDGET'))
print('  plus R2: 2 PUTs per report (1M Class A free a month, then $4.50 per million); Oracle egress free to 10 TB/month')
PY
}

seed_cmd() {
  target_ident
  eval "$(plan_numbers "$SCALE" "$TS")"
  local seedf="$REPO/backend/scripts/seed_staging.mjs"
  [ -f "$seedf" ] || die "$seedf not found (the private backend repo)"
  say "seed: $R_SEED upload + 2,000 auth test observers (covers ~$R_REPORTS reports a phase at x$SCALE, time-scale $TS)"
  tssh "cat > /tmp/rehearsal-seed_staging.mjs" < "$seedf"
  troot NEED="$R_SEED" FORCE="$FORCE" TESTDAY="$(testday)" <<'R' | scrub
set -uo pipefail
F=/var/lib/hawkeye/loadtest/fixtures; SD=/var/lib/hawkeye/snapshots; DB=/var/lib/hawkeye/storage/hawkeye.db
REL="$(readlink -f /opt/hawkeye/current)"; C="$REL/backend/src/data/contests.json"
fresh="$(python3 - "$F/staging.json" "$NEED" "$SD" <<'PY'
import glob, json, os, sys, time
p, need, sd = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    d = json.load(open(p)); a = d['attest']; age = (time.time() * 1000 - a['checkedAt']) / 3.6e6
    snaps = sorted(glob.glob(sd + '/pre-test-*.db'), key=os.path.getmtime)
    ok = a.get('otpStub') and age < 20 and len(d['upload']) >= need and snaps and os.path.getmtime(snaps[-1]) >= os.path.getmtime(p)
    print('yes %.1f %d' % (age, len(d['upload'])) if ok else 'no')
except Exception: print('no')
PY
)"
if [ "${fresh%% *}" = yes ] && [ -z "$FORCE" ]; then
  echo "PROVED: seed already done (fixtures hours old, upload observers: ${fresh#yes }) and the reset snapshot was made after them. --force re-seeds."
  rm -f /tmp/rehearsal-seed_staging.mjs; exit 0
fi
# 0. Keep a copy of staging as it was before the first rehearsal seed (never restored automatically).
if ! ls "$SD"/before-rehearsal-*.db >/dev/null 2>&1; then
  b="$SD/before-rehearsal-$(date -u +%Y%m%dT%H%MZ).db"
  sudo -u hawkeye sqlite3 "$DB" ".timeout 30000" "VACUUM INTO '$b'" && echo "PROVED: staging as it was kept in $(basename "$b") ($(du -h "$b" | cut -f1), $(sqlite3 "file:$b?mode=ro" 'SELECT COUNT(*) FROM submissions;') reports)"
fi
# 1. Contest dates for the test day, then back to the clean reset point (0 reports).
[ -f "$C.pre-rehearsal" ] || cp -p "$C" "$C.pre-rehearsal"
python3 - "$C" "$TESTDAY" <<'PY'
import json, sys
p, day = sys.argv[1], sys.argv[2]
d = json.load(open(p)); items = d if isinstance(d, list) else d.get('contests', d)
for c in items:
    if c.get('code') in ('PRES', 'SEN', 'REP'): c['date'] = day
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
PY
[ -f /etc/hawkeye/peak-mode ] && /usr/local/sbin/hawkeye-peak-mode off | tail -1
/usr/local/sbin/hk-reset-staging | tail -1
# 2. The seed script is not in the deploy bundle: put it into this release.
install -d -m 0755 "$REL/backend/scripts"; install -m 0644 /tmp/rehearsal-seed_staging.mjs "$REL/backend/scripts/seed_staging.mjs"; rm -f /tmp/rehearsal-seed_staging.mjs
P=(); for f in $(systemctl cat hawkeye-writer.service | sed -n 's/^EnvironmentFile=-\{0,1\}//p'); do P+=(-p "EnvironmentFile=$f"); done
install -d -o hawkeye -g hawkeye -m 0700 "$F"
if [ ! -s "$F/sheet.jpg" ] || [ ! -s "$F/venue.jpg" ]; then
  systemd-run --quiet --wait --collect -u "hkreh-jpeg-$RANDOM" -p User=hawkeye -p Group=hawkeye -p WorkingDirectory="$REL" \
    /usr/local/bin/node scripts/loadtest/seed/make_sample_jpegs.mjs "$F" && echo "PROVED: synthetic sheet and venue JPEGs made"
fi
# 3. Seed (refuses unless the host has the console OTP stub and no messaging keys).
[ -s "$F/staging.json" ] && mv "$F/staging.json" "$F/staging.json.old"
t0=$(date +%s); rm -f /var/lib/hawkeye/loadtest/seed.out
systemd-run --quiet --wait --collect -u "hkreh-seed-$RANDOM" -p User=hawkeye -p Group=hawkeye -p WorkingDirectory="$REL" "${P[@]}" -E APP_ENV=staging \
  -p StandardOutput=append:/var/lib/hawkeye/loadtest/seed.out -p StandardError=append:/var/lib/hawkeye/loadtest/seed.out \
  /usr/local/bin/node backend/scripts/seed_staging.mjs --i-am-on-staging --host staging.hawkeye.com.ng --count "$NEED" --auth 2000 --out "$F/staging.json"
rc=$?
echo "seed exit $rc in $(( $(date +%s) - t0 )) s: $(tail -2 /var/lib/hawkeye/loadtest/seed.out | tr '\n' ' ' | cut -c1-200)"
if [ ! -s "$F/staging.json" ]; then echo "FAIL:   no fixtures written; the old file is back"; [ -f "$F/staging.json.old" ] && mv "$F/staging.json.old" "$F/staging.json"; exit 1; fi
rm -f "$F/staging.json.old"; chown hawkeye:hawkeye "$F/staging.json"; chmod 0600 "$F/staging.json"
python3 -c "import json,time; d=json.load(open('$F/staging.json')); a=d['attest']; print('PROVED: fixtures: %d upload + %d auth observers, attested %d min ago for %s, OTP stub %s' % (len(d['upload']), len(d['auth']), (time.time()*1000-a['checkedAt'])/60000, a['host'], a['otpStub']))"
# 4. The new reset point.
SNAP="$SD/pre-test-$(date -u +%Y%m%dT%H%MZ).db"
sudo -u hawkeye sqlite3 "$DB" ".timeout 30000" "VACUUM INTO '$SNAP'"
echo "PROVED: reset snapshot $(basename "$SNAP") ($(du -h "$SNAP" | cut -f1)): quick_check $(sqlite3 "file:$SNAP?mode=ro" 'PRAGMA quick_check;' | head -1), observers $(sqlite3 "file:$SNAP?mode=ro" 'SELECT COUNT(*) FROM observers;'), reports $(sqlite3 "file:$SNAP?mode=ro" 'SELECT COUNT(*) FROM submissions;')"
R
  say "seed: loading the generators"
  prepare_generators
  mkdir -p "$(dirname "$CUR")"; echo "$RUN_ID" > "$CUR"; say "seed: run id $RUN_ID pinned for later commands at x$SCALE (teardown unpins it)"
}

warm_cmd() {
  target_ident
  say "warm: reset, contest dates, every role, a peak-mode round trip, then a short read through the pipeline"
  troot TESTDAY="$(testday)" <<'R' | scrub
set -uo pipefail
for u in $(systemctl list-units 'hawkeye-*.service' --plain --no-legend | awk '{print $1}'); do
  p="$(systemctl show -p Environment --value "$u" | tr ' ' '\n' | sed -n 's/^PORT=//p')"; [ -n "$p" ] || continue
  c="$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' --max-time 5 -H @/run/hawkeye/origin-auth.hdr "http://127.0.0.1:$p/api/health")"
  n="${u#hawkeye-}"; printf '%s %s | ' "${n%.service}" "$c"
done; echo
echo "via the proxy: $(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve staging.hawkeye.com.ng:443:127.0.0.1 -H @/run/hawkeye/origin-auth.hdr https://staging.hawkeye.com.ng/api/national/PRES) (with the origin lock), $(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve staging.hawkeye.com.ng:443:127.0.0.1 https://staging.hawkeye.com.ng/api/health) (without: want 403)"
if [ -f /etc/hawkeye/peak-mode ]; then echo "peak mode was ON: leaving it"; else
  /usr/local/sbin/hawkeye-peak-mode on | tail -1; /usr/local/sbin/hawkeye-peak-mode status | sed -n 2p; /usr/local/sbin/hawkeye-peak-mode off | tail -1
fi
R
  local keep_s="$SCALE" keep_t="$TS"
  SCALE="$(awk "BEGIN{print ($SCALE < 0.05) ? $SCALE : 0.05}")"; TS=0.05
  run_k6_phase warm read off
  SCALE="$keep_s"; TS="$keep_t"
}

photos_start_cmd() {
  target_ident
  mark photos-start start
  if [ -z "$PHOTO_MACHINES" ] || [ -n "$DRY" ]; then
    echo "DRY RUN (no photo machines configured${DRY:+, --dry-run}). On the day, for each PHOTO_MACHINES entry <private address>:<processes>, this runs ON THE TARGET:"
    echo "  ssh <private address> displayName  -> must start with $PHOTO_NAME_PREFIX, and be $EXPECT_ARCH like the target"
    echo "  OCR_WIDTH=$OCR_WIDTH PHOTO_API=https://$BASE_NAME bash /opt/hawkeye/current/scripts/staging/oracle/photo-machine.sh push <private address> <processes>"
    echo "  (backend, node and PHOTO_WORKER_TOKEN go target -> photo machine inside the VCN; one hawkeye-photo-worker@N unit per process)"
    troot <<'R'
echo "today: the target's own photos processes: $(systemctl list-units 'hawkeye-photos*.service' --state=active --plain --no-legend | wc -l) active (low priority; writers.conf: $(grep -E '^(PHOTOS|REMOTE_PHOTOS)=' /etc/hawkeye/writers.conf | tr '\n' ' '))"
R
    mark photos-start "end dry-run"; return 0
  fi
  agent_up
  local pm ip procs name
  for pm in $PHOTO_MACHINES; do
    ip="${pm%%:*}"; procs="${pm##*:}"; [[ "$procs" =~ ^[0-9]+$ ]] || die "PHOTO_MACHINES entry needs :<processes>"
    name="$(tssh_a "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 ubuntu@$ip 'curl -fsS -m 5 -H \"Authorization: Bearer Oracle\" http://169.254.169.254/opc/v2/instance/displayName'" 2>/dev/null || true)"
    case "$name" in "$PHOTO_NAME_PREFIX"*) ;; *) die "REFUSED: the photo machine at <private address> is named '$name'" ;; esac
    tssh_a "OCR_WIDTH=$OCR_WIDTH PHOTO_API=https://$BASE_NAME bash /opt/hawkeye/current/scripts/staging/oracle/photo-machine.sh push $ip $procs" 2>&1 | tail -2 | scrub
  done
  mark photos-start end
}

photos_cmd() {  # measure the OCR / photo-check backlog drain; stop the photo machines afterwards
  target_ident
  local phase=photos
  say "photos: measuring the OCR + photo-analysis drain for ${PHOTO_WINDOW_S}s (no reset: it works on what the last write phase left)"
  mark "$phase" start
  remote_phase_start "$phase" keep 0 | scrub
  agent_up
  # As the ssh user, not root: reaching the photo machines needs the forwarded agent, which sudo drops.
  tssh_a "RUN=$RUN_ID W=$PHOTO_WINDOW_S PMS='$PHOTO_MACHINES' bash -s" <<'R' | scrub
set -uo pipefail
RD="/var/lib/hawkeye/loadtest/rehearsal/$RUN/photos"; DB=/var/lib/hawkeye/storage/hawkeye.db
q() { sudo sqlite3 -readonly "file:$DB?mode=ro" "$1"; }
put() { sudo tee -a "$RD/$1" > /dev/null; }
lcpu() { t=0; for u in $(systemctl list-units 'hawkeye-photos*.service' --plain --no-legend | awk '{print $1}'); do t=$((t + $(systemctl show -p CPUUsageNSec --value "$u" | tr -cd '0-9'))); done; echo $t; }
rcpu() { t=0; for pm in $PMS; do n="$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "ubuntu@${pm%%:*}" 't=0; for u in $(systemctl list-units --plain --no-legend "hawkeye-photo-worker@*.service" | awk "{print \$1}"); do t=$((t + $(systemctl show $u -p CPUUsageNSec --value | tr -cd 0-9))); done; echo $t' 2>/dev/null || echo 0)"; t=$((t + ${n:-0})); done; echo $t; }
snap() { echo "$(date +%s) $(q "SELECT COUNT(*) FROM ocr_jobs WHERE status IN ('done','failed')") $(q "SELECT COUNT(*) FROM ocr_jobs WHERE status IN ('queued','running')") $(q "SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('done','failed')") $(q "SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('queued','running')") $(lcpu) $(rcpu)"; }
a=($(snap)); echo "${a[*]}" | put photos.log
echo "  start: OCR done ${a[1]}, waiting ${a[2]} | photo checks done ${a[3]}, waiting ${a[4]} | local photos processes $(systemctl list-units 'hawkeye-photos*.service' --state=active --plain --no-legend | wc -l), photo machines: $(echo $PMS | wc -w)"
end=$(( $(date +%s) + W ))
while [ "$(date +%s)" -lt "$end" ]; do sleep 10; b=($(snap)); echo "${b[*]}" | put photos.log; [ "${b[2]}" = 0 ] && [ "${b[4]}" = 0 ] && break; done
b=($(snap)); echo "${b[*]}" | put photos.log
dt=$(( b[0] - a[0] )); [ "$dt" -gt 0 ] || dt=1
printf 'W=%s\nDT=%s\nOCR_DONE=%s\nOCR_LEFT=%s\nAN_DONE=%s\nAN_LEFT=%s\nLOCAL_CPU_S=%s\nREMOTE_CPU_S=%s\nLOCAL_PROCS=%s\nPMS="%s"\n' "$W" "$dt" $(( b[1] - a[1] )) "${b[2]}" $(( b[3] - a[3] )) "${b[4]}" \
  "$(awk -v x=$(( b[5] - a[5] )) 'BEGIN{printf "%.1f", x/1e9}')" "$(awk -v x=$(( b[6] - a[6] )) 'BEGIN{printf "%.1f", x/1e9}')" \
  "$(systemctl list-units 'hawkeye-photos*.service' --state=active --plain --no-legend | wc -l)" "$(echo $PMS | sed -E 's/[0-9.]+:/m:/g')" | put photos.env
echo "  after ${dt}s: OCR +$(( b[1] - a[1] )) (left ${b[2]}), photo checks +$(( b[3] - a[3] )) (left ${b[4]}); CPU: local photos $(awk -v x=$(( b[5] - a[5] )) 'BEGIN{printf "%.1f", x/1e9}') s, photo machines $(awk -v x=$(( b[6] - a[6] )) 'BEGIN{printf "%.1f", x/1e9}') s"
R
  if [ -n "$PHOTO_MACHINES" ] && [ -z "$DRY" ]; then
    local pm
    for pm in $PHOTO_MACHINES; do
      tssh_a "ssh -o ConnectTimeout=15 ubuntu@${pm%%:*} 'sudo bash -s stop' < /opt/hawkeye/current/scripts/staging/oracle/photo-machine.sh" 2>&1 | tail -1 | sed 's/^/  photo machine: /'
    done
  else
    note "no photo machines to stop (dry run)"
  fi
  remote_phase_end "$phase" | scrub
  mark "$phase" end
  collect_all >/dev/null
  report_cmd "$phase"
}

restore_cmd() {  # peak mode off -> restore test of both copies; then the journal drill against the last write phase
  target_ident
  local phase=restore
  mark "$phase" start
  troot RUN="$RUN_ID" <<'R' | scrub
set -uo pipefail
B="/var/lib/hawkeye/loadtest/rehearsal/$RUN"; RD="$B/restore"; rm -rf "$RD"; install -d -o hawkeye -g hawkeye -m 0750 "$RD"
DB=/var/lib/hawkeye/storage/hawkeye.db; REL="$(readlink -f /opt/hawkeye/current)"; BUCKET="$(cat /etc/hawkeye/replica-bucket)"
[ -f /etc/hawkeye/peak-mode ] && /usr/local/sbin/hawkeye-peak-mode off | tail -1
# A fresh hourly copy first: the newest one may belong to an earlier phase's chain (each reset starts a new one).
systemctl start hawkeye-db-backup.service && echo "fresh hourly copy of the live chain taken ($(cat /var/lib/hawkeye/backup/last-ok))"
echo "== A. hawkeye-restore-test (the Litestream replica and the newest hourly copy, each against the live ledger)"
t_off=$(date +%s)
for try in 1 2 3 4 5; do
  /usr/local/sbin/hawkeye-restore-test 180 > "$RD/restore-test.txt" 2>&1; rc=$?
  [ "$rc" = 0 ] && break
  grep -q "^FAIL  hourly\|^FAIL  no hourly" "$RD/restore-test.txt" && break   # only the Litestream copy is worth waiting for
  echo "  attempt $try: the Litestream replica is not at the live head yet (after peak mode it starts again from a full copy); again in 45 s"
  sleep 45
done
echo "RC=$rc ATTEMPTS=$try LITESTREAM_CAUGHT_UP_AFTER_S=$(( $(date +%s) - t_off ))" >> "$RD/restore-test.txt"
sed 's/^/  /' "$RD/restore-test.txt"
echo "== B. journal drill: the OLDEST snapshot of this chain in the bucket + the journal shipped since, rebuilt and compared with the live database"
last="$(ls -1t "$B"/ramp/start.env "$B"/upload/start.env 2>/dev/null | head -1)"
if [ -z "$last" ]; then echo "  no upload or ramp phase in this run: nothing to drill"; echo "DRILL=skipped" > "$RD/drill.env"; exit 0; fi
T0="$(sed -n 's/^T_RESET=//p' "$last")"; T0Z="$(date -u -d "@$T0" +%Y%m%dT%H%M%SZ)"; W="$RD/drill"; install -d -o hawkeye -g hawkeye -m 0700 "$W"
echo "  lineage: $(basename "$(dirname "$last")") phase, started $T0Z"
key="$(aws --region eu-west-1 s3api list-objects-v2 --bucket "$BUCKET" --prefix backup/hourly/ --query 'Contents[].Key' --output text 2>/dev/null \
  | tr '\t' '\n' | grep -E '^backup/hourly/hawkeye-[0-9]{8}T[0-9]{6}Z\.db\.gz$' | sort | awk -v t="$T0Z" '{k=$0; sub(/.*hawkeye-/,"",k); sub(/\.db\.gz$/,"",k); if (k >= t) print $0}' | head -1)"
if [ -z "$key" ]; then echo "  FAIL: no snapshot taken in the bucket since $T0Z (peak mode takes one when it is switched on)"; echo "DRILL=nosnapshot" > "$RD/drill.env"; exit 0; fi
want="$(aws --region eu-west-1 s3api head-object --bucket "$BUCKET" --key "$key" --query 'Metadata.sha256' --output text 2>/dev/null)"
aws --region eu-west-1 s3 cp --only-show-errors "s3://$BUCKET/$key" "$W/snap.db.gz"
got="$(sha256sum "$W/snap.db.gz" | cut -d' ' -f1)"
[ "$got" = "$want" ] || { echo "  FAIL: snapshot checksum differs from its metadata"; echo "DRILL=checksum" > "$RD/drill.env"; exit 0; }
gunzip "$W/snap.db.gz"; chown -R hawkeye:hawkeye "$W"
echo "  snapshot ${key#backup/hourly/}: checksum matches; $(sqlite3 "file:$W/snap.db?mode=ro" 'SELECT COUNT(*) FROM submissions;') reports in it"
P=(); for f in $(systemctl cat hawkeye-writer.service | sed -n 's/^EnvironmentFile=-\{0,1\}//p'); do P+=(-p "EnvironmentFile=$f"); done
hk() { rm -f "$W/$1.out"; systemd-run --quiet --wait --collect -u "hkreh-drill-$RANDOM" -p User=hawkeye -p Group=hawkeye -p WorkingDirectory="$REL/backend" "${P[@]}" \
  -p StandardOutput=append:"$W/$1.out" -p StandardError=append:"$W/$1.out" /usr/local/bin/node "${@:2}"; }
for day in $(python3 -c "import datetime as d,sys; u=d.timezone.utc; a=d.datetime.fromtimestamp(int(sys.argv[1]), u).date(); b=d.datetime.now(u).date(); print(' '.join((a+d.timedelta(n)).strftime('%Y%m%d') for n in range((b-a).days+1)))" "$T0"); do
  hk "fetch-$day" scripts/journal_fetch.mjs --to "$W/journal" --day "$day"; echo "  journal_fetch $day: $(tail -1 "$W/fetch-$day.out" | cut -c1-120)"
done
kept=0; dropped=0
while IFS= read -r f; do
  ms="$(basename "$f" | sed -nE 's/.*-([0-9]{13})\.[0-9]{8}\.ndjson$/\1/p')"
  if [ -n "$ms" ] && [ "$ms" -ge "$(( T0 * 1000 ))" ]; then kept=$((kept + 1)); else rm -f "$f"; dropped=$((dropped + 1)); fi
done < <(find "$W/journal" -name '*.ndjson' 2>/dev/null)
echo "  journal objects of this lineage: $kept (left out, from earlier runs today: $dropped)"
hk restore scripts/journal_restore.mjs --db "$W/snap.db" --from "$W/journal"; rc=$?
sed 's/^/  journal_restore: /' "$W/restore.out" | cut -c1-200
python3 - "$W/snap.db" "$DB" "$rc" "$RD/drill.env" <<'PY'
import hashlib, sqlite3, sys
def facts(p):
    c = sqlite3.connect('file:%s?mode=ro' % p, uri=True); c.execute('PRAGMA busy_timeout=10000')
    n, m = c.execute('SELECT COUNT(*), COALESCE(MAX(id),0) FROM submissions').fetchone()
    head = (c.execute('SELECT entry_hash FROM submissions ORDER BY id DESC LIMIT 1').fetchone() or [''])[0]
    h = hashlib.sha256(); [h.update(r[0].encode()) for r in c.execute('SELECT entry_hash FROM submissions ORDER BY id')]
    obs = c.execute('SELECT COUNT(DISTINCT observer_id) FROM submissions').fetchone()[0]
    allobs = c.execute('SELECT COUNT(*) FROM observers').fetchone()[0]
    return dict(reports=n, maxId=m, head=head[:16], hashOfHashes=h.hexdigest()[:16], reporters=obs, observers=allobs)
r, l = facts(sys.argv[1]), facts(sys.argv[2])
same = all(r[k] == l[k] for k in ('reports', 'maxId', 'head', 'hashOfHashes', 'reporters'))
for k in r: print('  %-13s rebuilt %-18s live %-18s %s' % (k, r[k], l[k], 'SAME' if r[k] == l[k] else ('DIFFERENT' if k != 'observers' else 'differs: sign-ups that never reported are not in the journal (RPO 10 min for accounts)')))
print('  journal drill: %s' % ('PASS' if same and sys.argv[3] == '0' else 'FAIL'))
open(sys.argv[4], 'w').write('DRILL=%s\nRESTORE_RC=%s\n' % ('pass' if same and sys.argv[3] == '0' else 'fail', sys.argv[3]) + ''.join('R_%s=%s\nL_%s=%s\n' % (k, r[k], k, l[k]) for k in r))
PY
cp "$W"/*.out "$RD/" 2>/dev/null; rm -rf "$W"; chown -R hawkeye:hawkeye "$RD"
R
  mark "$phase" end
  collect_all >/dev/null
  report_cmd "$phase"
}

collect_all() {
  mkdir -p "$LRES/target"
  tssh "sudo tar -C /var/lib/hawkeye/loadtest/rehearsal/$RUN_ID -cz --exclude='*.mjs' --exclude='*.sh' --exclude=drill . 2>/dev/null" | tar -C "$LRES/target" -xz 2>/dev/null || true
  local i done_self=""
  for i in $(seq 1 "$G_N"); do
    if [ -n "${G_SELF[$i]}" ]; then [ -n "$done_self" ] && continue; done_self=1; fi
    mkdir -p "$LRES/${G_LABEL[$i]}"
    gssh "$i" "test -d ~/lt/results/$RUN_ID && tar -C ~/lt/results/$RUN_ID -cz . || true" | tar -C "$LRES/${G_LABEL[$i]}" -xz 2>/dev/null || true
  done
  find "$LRES" -type f \( -name '*.log' -o -name '*.txt' -o -name '*.out' -o -name '*.err' \) -print0 | while IFS= read -r -d '' f; do scrub < "$f" > "$f.s" && mv "$f.s" "$f"; done
  find "$LRES" -type f -name 'samples.json.gz' -print0 | while IFS= read -r -d '' f; do zcat "$f" | scrub | gzip -1 > "$f.s" && mv "$f.s" "$f"; done
  echo "collected into $LRES ($(du -sh "$LRES" | cut -f1))"
}

report_cmd() {  # [PHASE]: print that phase's numbers and gates; always rewrite report.md
  [ -d "$LRES" ] || die "nothing collected yet in $LRES"
  python3 - "$LRES" "${1:-}" "$COST_MACHINES" "$BUDGET_USD" "$PHOTO_CORES_PLANNED" "$OCR_WIDTH" <<'PY'
import glob, gzip, json, math, os, re, sys, time
L, only, machines, budget, pcores, ocrw = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), int(sys.argv[6])
PHASES = ['warm', 'read', 'upload', 'auth', 'ramp', 'photos', 'restore']
def env(p):
    d = {}
    try:
        for l in open(p):
            if '=' in l: k, v = l.rstrip('\n').split('=', 1); d[k] = v.strip('"')
    except FileNotFoundError: pass
    return d
def pct(xs, q):
    xs = sorted(xs)
    return None if not xs else xs[min(len(xs) - 1, max(0, math.ceil(q / 100 * len(xs)) - 1))]
def met(m, k, f):
    v = m.get(k)
    if v is None: return None
    v = v.get('values', v)
    return v.get(f)
def k6(phase):
    out = {'gens': 0, 'codes': [], 'm': {}, 'p95': {}, 'names': {}}
    for s in sorted(glob.glob(os.path.join(L, '*', '%s-*' % phase, 'summary.json'))):
        try: m = json.load(open(s))['metrics']
        except Exception: continue
        out['gens'] += 1
        d = s[:-len('/summary.json')]; c = open(d + '.done').read().strip() if os.path.exists(d + '.done') else '-'; out['codes'].append(c)
        for k, v in m.items():
            vv = v.get('values', v)
            agg = out['m'].setdefault(k, {})
            for f in ('count', 'passes', 'fails'):
                if f in vv: agg[f] = agg.get(f, 0) + vv[f]
            for f in ('p(95)', 'p(99)', 'max', 'med', 'avg'):
                if f in vv: agg[f] = max(agg.get(f, 0), vv[f])     # across generators: the worst one
            if 'rate' in vv and 'passes' not in vv: agg['rate'] = agg.get('rate', 0) + vv['rate']
        sp = os.path.join(d, 'samples.json.gz')
        if os.path.exists(sp):
            for line in gzip.open(sp, 'rt'):
                if '"http_req_duration"' not in line or '"Point"' not in line: continue
                try: o = json.loads(line)
                except Exception: continue
                t = o['data'].get('tags', {}); n = t.get('name', '?'); st = t.get('status', '?')
                e = out['names'].setdefault(n, {'d': [], 's': {}}); e['d'].append(o['data']['value']); e['s'][st] = e['s'].get(st, 0) + 1
    for k, v in out['m'].items():
        if 'passes' in v: v['rate'] = v['passes'] / max(1, v['passes'] + v['fails'])
    return out
def mon(phase):
    rows = []
    for l in open(os.path.join(L, 'target', phase, 'monitor.log')) if os.path.exists(os.path.join(L, 'target', phase, 'monitor.log')) else []:
        try: rows.append(json.loads(l))
        except Exception: pass
    if len(rows) < 3: return None
    cores = int(env(os.path.join(L, 'target', phase, 'start.env')).get('CORES', '1') or 1)
    box, roles, probe, rate = [], {}, {}, []
    for a, b in zip(rows, rows[1:]):
        dt = b['t'] - a['t']
        if dt <= 0: continue
        tb, ti = b['busy'] - a['busy'], b['idle'] - a['idle']
        if tb + ti > 0: box.append(cores * tb / (tb + ti))
        for n, v in b['cpu'].items():
            if n in a['cpu']: roles.setdefault(n, []).append(max(0, (v - a['cpu'][n]) / 1e9 / dt))
        if b['maxid'] >= 0 and a['maxid'] >= 0: rate.append(((b['t'] + a['t']) / 2, (b['maxid'] - a['maxid']) / dt))
    for r in rows:
        for n, v in r['probe'].items(): probe.setdefault(n, []).append(2000.0 if v < 0 else v)
    return dict(cores=cores, box=box, roles=roles, probe=probe, rate=rate, wal=max(r['wal'] for r in rows), mem=min(r['mem'] for r in rows),
                disk=min(r['disk'] for r in rows), drops=rows[-1]['drops'] - rows[0]['drops'], n=len(rows), t0=rows[0]['t'], t1=rows[-1]['t'])
f0 = lambda x, d=0: '-' if x is None else ('%.*f' % (d, x))
gates_all = []
def gate(phase, name, ok, val, need, src):
    gates_all.append((phase, name, 'n/a' if ok is None else ('PASS' if ok else 'FAIL'), val, need, src))
def phase_block(phase):
    st, po = env(os.path.join(L, 'target', phase, 'start.env')), env(os.path.join(L, 'target', phase, 'post.env'))
    lines = []; K = k6(phase); m = K['m']; M = mon(phase)
    try: led = json.load(open(os.path.join(L, 'target', phase, 'ledger.json')))
    except Exception: led = None
    if K['gens']:
        reqs = met(m, 'http_reqs', 'count'); fails = met(m, 'http_req_failed', 'passes')
        lines.append('k6: %d process(es), exit %s | requests %s, failed %s (%.2f%%) | dropped iterations %s | 503 busy %s | 429 %s' % (
            K['gens'], ','.join(K['codes']), f0(reqs), f0(fails), 100.0 * (fails or 0) / max(1, reqs or 1), f0(met(m, 'dropped_iterations', 'count')),
            f0(met(m, 'server_busy_503', 'count')), f0(met(m, 'rate_limited_429', 'count'))))
        for k in sorted(m):
            mm = re.match(r'http_req_duration\{(name|scenario):([^}]*)\}', k)
            if mm: lines.append('  p95 %-28s %7s ms   (p99 %s, max %s)' % (mm.group(2), f0(met(m, k, 'p(95)')), f0(met(m, k, 'p(99)')), f0(met(m, k, 'max'))))
        for k in ('report_ok', 'otp_flow_ok', 'edge_hit', 'checks'):
            if k in m: lines.append('  %-14s %.2f%% (%s ok, %s not)' % (k, 100 * m[k]['rate'], f0(m[k].get('passes')), f0(m[k].get('fails'))))
        if 'report_end_to_end_ms' in m: lines.append('  report end-to-end p95 %s ms' % f0(met(m, 'report_end_to_end_ms', 'p(95)')))
        if K['names']:
            lines.append('  per endpoint (every request sampled): name, count, p50 / p95 / max ms, statuses')
            for n, e in sorted(K['names'].items(), key=lambda x: -len(x[1]['d'])):
                lines.append('    %-22s %7d  %6s / %6s / %7s  %s' % (n, len(e['d']), f0(pct(e['d'], 50), 1), f0(pct(e['d'], 95), 1), f0(max(e['d']), 0), ' '.join('%s:%d' % kv for kv in sorted(e['s'].items()))))
    if M:
        lines.append('server (%d samples, %d cores): box CPU mean %s / p95 %s / peak %s cores | WAL max %s MB | free memory min %s MB | disk min %s GB | listen drops +%d' % (
            M['n'], M['cores'], f0(sum(M['box']) / len(M['box']), 2), f0(pct(M['box'], 95), 2), f0(max(M['box']), 2), f0(M['wal'] / 1048576),
            M['mem'], f0(M['disk'] / 1024, 1), M['drops']))
        lines.append('  CPU per role, cores mean/peak: ' + ', '.join('%s %.2f/%.2f' % (n, sum(v) / len(v), max(v)) for n, v in sorted(M['roles'].items()) if v))
        lines.append('  /api/health latency per process (event-loop proxy), p50/p99/max ms: ' + ', '.join('%s %s/%s/%s' % (n, f0(pct(v, 50), 1), f0(pct(v, 99), 0), f0(max(v), 0)) for n, v in sorted(M['probe'].items())))
        if M['rate']: lines.append('  accepted reports/s (ledger head, 2-s steps): peak %.1f, mean while non-zero %.1f' % (max(r for _, r in M['rate']), (lambda z: sum(z) / len(z) if z else 0)([r for _, r in M['rate'] if r > 0])))
    if led: lines.append('ledger: chain %s, columns %s, %s entries, forks %s (re-hashed from genesis in %s ms)' % ('whole' if led.get('chainOk') else 'BROKEN', 'ok' if led.get('columnsOk') else led.get('columnsOk'), led.get('entries'), led.get('forks'), led.get('ms')))
    dcount = None
    if st and po:
        dcount = int(po.get('COUNT1', 0)) - int(st.get('COUNT0', 0))
        lines.append('database: +%d reports this phase | journal lines %s, unshipped bytes %s | failed units: %s | peak mode %s -> %s | OCR waiting %s, photo checks waiting %s' % (
            dcount, po.get('JOURNAL_LINES'), po.get('JOURNAL_PENDING'), po.get('FAILED_UNITS') or 'none', st.get('PEAK'), po.get('PEAK1'), po.get('OCR_QUEUED'), po.get('AN_QUEUED')))
    # ---- gates (ELECTION-NIGHT-HOSTING.md §1.2, §5.4, §6 alerts; REHEARSAL-1-PLAN.md §2) ----
    p95 = lambda k: met(m, k, 'p(95)')
    if phase in ('read', 'ramp') and K['gens']:
        fr = met(m, 'http_req_failed{scenario:public_read}', 'rate')
        if fr is None and 'http_req_failed{scenario:public_read}' in m:
            v = m['http_req_failed{scenario:public_read}']; fr = v.get('passes', 0) / max(1, v.get('passes', 0) + v.get('fails', 0))
        gate(phase, 'public reads failed', None if fr is None else fr < 0.01, f0(None if fr is None else 100 * fr, 2) + '%', '< 1%', 'k6')
        gate(phase, 'public reads p95', None if p95('http_req_duration{scenario:public_read}') is None else p95('http_req_duration{scenario:public_read}') < 800, f0(p95('http_req_duration{scenario:public_read}')) + ' ms', '< 800 ms', 'k6')
        gate(phase, 'results board (/api/national) p95', None if p95('http_req_duration{name:national}') is None else p95('http_req_duration{name:national}') < 1000, f0(p95('http_req_duration{name:national}')) + ' ms', '< 1000 ms', 'k6')
        gate(phase, 'signed-in reads p95', None if p95('http_req_duration{scenario:authed_read}') is None else p95('http_req_duration{scenario:authed_read}') < 500, f0(p95('http_req_duration{scenario:authed_read}')) + ' ms', '< 500 ms', 'k6')
    if phase in ('upload', 'ramp') and 'report_ok' in m:
        ro = m['report_ok']; att = ro.get('passes', 0) + ro.get('fails', 0); busy = met(m, 'server_busy_503', 'count') or 0
        gate(phase, 'reports accepted', ro['rate'] >= 0.98, '%.2f%% of %d' % (100 * ro['rate'], att), '>= 98%', 'k6 report_ok')
        gate(phase, 'report end-to-end p95', None if p95('report_end_to_end_ms') is None else p95('report_end_to_end_ms') < 6000, f0(p95('report_end_to_end_ms')) + ' ms', '< 6000 ms', 'k6')
        gate(phase, 'busy 503 share of report attempts', busy / max(1, att) <= 0.02, '%.2f%%' % (100 * busy / max(1, att)), '<= 2%, all with Retry-After', 'k6')
        for n, lim in (('presign', 800), ('submit', 1500)):
            v = p95('http_req_duration{name:%s}' % n); gate(phase, '%s p95' % n, None if v is None else v < lim, f0(v) + ' ms', '< %d ms' % lim, 'k6')
        if led and dcount is not None:
            gate(phase, 'ledger whole, no forks', bool(led.get('chainOk') and led.get('columnsOk') and led.get('forks') == 0), 'chain %s, columns %s, forks %s' % (led.get('chainOk'), led.get('columnsOk'), led.get('forks')), 'whole, 0 forks', 'services/ledger.js')
            gate(phase, 'every 201 is a stored report', dcount >= (ro.get('passes', 0)), '%d stored, %d accepted by k6' % (dcount, ro.get('passes', 0)), 'stored >= accepted', 'database')
            if st.get('PEAK') == 'on' or int(po.get('JOURNAL_LINES', 0) or 0) > 0:
                gate(phase, 'journal carries every report', int(po.get('JOURNAL_LINES', 0)) == dcount and po.get('JOURNAL_PENDING') == '0', '%s lines, %s bytes unshipped' % (po.get('JOURNAL_LINES'), po.get('JOURNAL_PENDING')), 'lines = reports, 0 unshipped', '/api/health')
    if phase in ('auth', 'ramp') and 'otp_flow_ok' in m:
        gate(phase, 'sign-in flows ok', m['otp_flow_ok']['rate'] >= 0.98, '%.2f%%' % (100 * m['otp_flow_ok']['rate']), '>= 98%', 'k6')
        for n in ('otp_register', 'login_password'):
            v = p95('http_req_duration{name:%s}' % n); gate(phase, '%s p95' % n, None if v is None else v < 1000, f0(v) + ' ms', '< 1000 ms', 'k6')
    if phase in ('read', 'upload', 'auth', 'ramp') and M:
        serving = {n: v for n, v in M['probe'].items() if n.startswith(('writer', 'reader'))}
        worst = max((pct(v, 99) for v in serving.values()), default=None)
        gate(phase, 'event-loop proxy p99 (writers, readers)', None if worst is None else worst < 200, f0(worst) + ' ms', '< 200 ms', 'sampler')
        wr = [sum(v) / len(v) for n, v in M['roles'].items() if n.startswith('writer') and v]
        gate(phase, 'busiest writer, mean CPU', None if not wr else max(wr) < 0.8, f0(max(wr) if wr else None, 2) + ' core', '< 0.8 core', 'sampler')
        gate(phase, 'box CPU p95', pct(M['box'], 95) < 0.85 * M['cores'], '%s of %d cores' % (f0(pct(M['box'], 95), 1), M['cores']), '< 85%', 'sampler')
        gate(phase, 'WAL largest', M['wal'] < 1.5 * 2**30, f0(M['wal'] / 2**20) + ' MB', '< 1.5 GB (alert at 1 GB)', 'sampler')
        gate(phase, 'connections dropped by the kernel', M['drops'] == 0, '+%d' % M['drops'], '0', '/proc/net/netstat')
        gate(phase, 'failed units', not (po.get('FAILED_UNITS') or ''), po.get('FAILED_UNITS') or 'none', 'none', 'systemd')
    if phase in ('read', 'upload', 'auth', 'ramp'):
        done = sorted(glob.glob(os.path.join(L, '*', '%s-*.done' % phase)))
        codes = [open(d).read().strip() for d in done]
        good = bool(done) and all(c in ('0', '99') for c in codes) and K['gens'] == len(done)
        gate(phase, 'k6 ran to completion on every generator', good, 'exit %s, %d summaries' % (','.join(codes) or 'none', K['gens']), '0 or 99 each, a summary each', 'k6 .done files')
        if not good:
            for d in done:
                lg = d[:-5] + '.log'
                if os.path.exists(lg): lines.append('k6 log %s (end): %s' % (os.path.basename(lg), ' | '.join(open(lg).read().strip().splitlines()[-4:])[:400]))
    if K['gens'] and phase != 'warm':
        it = met(m, 'iterations', 'count') or 0; dr = met(m, 'dropped_iterations', 'count') or 0
        gate(phase, 'generator kept up (validity)', dr / max(1, it + dr) < 0.01, '%d dropped of %d' % (dr, it + dr), '< 1% dropped, else INVALID', 'k6')
    if phase == 'photos':
        pe = env(os.path.join(L, 'target', 'photos', 'photos.env'))
        if pe:
            dt = max(1, int(pe['DT'])); ocr = int(pe['OCR_DONE']); procs = int(pe.get('LOCAL_PROCS', 0)) + 0
            cpu = float(pe['LOCAL_CPU_S']) + float(pe['REMOTE_CPU_S'])
            lines.append('photos: %d s window | OCR sheets %d (%.2f/s), photo checks %s (%.2f/s), left %s / %s | CPU used %.0f s (local %s, photo machines %s) | photo machines: %s' % (
                dt, ocr, ocr / dt, pe['AN_DONE'], int(pe['AN_DONE']) / dt, pe['OCR_LEFT'], pe['AN_LEFT'], cpu, pe['LOCAL_CPU_S'], pe['REMOTE_CPU_S'], pe.get('PMS') or 'none (dry run)'))
            if ocr > 0 and cpu > 0:
                checks = int(pe['AN_DONE'])
                ocr_cpu = max(0.5 * cpu, cpu - 0.3 * checks)              # §5.4: a photo check costs ~0.3 CPU-s; the rest is OCR
                per = ocr_cpu / ocr                                      # CPU-s per synthetic sheet
                real = per * 6.1 / 2.4 * (0.8 if ocrw <= 1000 else 1.0)  # §5.4: real EC8A 6.1 s vs 2.4 s on test photos; 1,000 px -20%
                hours = 528000 * (real + 0.3) / pcores / 3600            # every sheet read + every photo pair checked
                lines.append('  OCR %.2f CPU-s per synthetic sheet (photo checks taken out at 0.3 s each) -> ~%.1f per real sheet at %d px; 528,000 sheets + checks on %d cores: ~%.1f h' % (per, real, ocrw, pcores, hours))
                gate(phase, 'OCR projection: 528k real sheets + checks', hours <= 12, '%.1f h on %d cores' % (hours, pcores), '<= 12 h', 'ocr_jobs + CPU, x2.5 real-sheet factor')
            else:
                gate(phase, 'OCR projection: 528k real sheets + checks', None, 'no sheets read in the window', '<= 12 h', 'ocr_jobs')
    if phase == 'restore':
        rt = open(os.path.join(L, 'target', 'restore', 'restore-test.txt')).read() if os.path.exists(os.path.join(L, 'target', 'restore', 'restore-test.txt')) else ''
        lines += ['restore test: ' + l.strip() for l in rt.splitlines() if l.startswith(('PASS', 'FAIL', 'restore test'))]
        att = re.search(r'ATTEMPTS=(\d+) LITESTREAM_CAUGHT_UP_AFTER_S=(\d+)', rt)
        gate(phase, 'restore test, both copies', ('RC=0' in rt) if rt else None, ('PASS' if 'RC=0' in rt else 'FAIL') + (', attempt %s, %s s after peak mode off' % att.groups() if att else ''), 'PASS', 'hawkeye-restore-test')
        de = env(os.path.join(L, 'target', 'restore', 'drill.env'))
        if de:
            lines.append('journal drill: %s | rebuilt %s reports, head %s | live %s reports, head %s' % (de.get('DRILL'), de.get('R_reports'), de.get('R_head'), de.get('L_reports'), de.get('L_head')))
            gate(phase, 'journal drill (snapshot + journal = live)', None if de.get('DRILL') == 'skipped' else de.get('DRILL') == 'pass', de.get('DRILL'), 'reports, head, hash of hashes equal', 'journal_restore.mjs')
    return lines
blocks = {}
for ph in PHASES:
    if os.path.isdir(os.path.join(L, 'target', ph)) or glob.glob(os.path.join(L, '*', ph + '-*')): blocks[ph] = phase_block(ph)
# cost from the phases log: the machines were up from the first start to the last end, plus one hour of setup
ev = [l.split() for l in open(os.path.join(L, 'phases.log'))] if os.path.exists(os.path.join(L, 'phases.log')) else []
span_h = ((int(ev[-1][0]) - int(ev[0][0])) / 3600 + 1) if ev else 0
price = {'A1': (0.010, 0.0015), 'E5': (0.030, 0.002)}
cost = sum((float(o) * price.get(f, price['A1'])[0] + float(g) * price.get(f, price['A1'])[1]) * span_h for _, f, o, g in (x.split(':') for x in machines.split()))
gate('all', 'cost (list price, estimate)', cost <= budget, '$%.2f for %.1f h' % (cost, span_h), '<= $%.0f' % budget, 'phases.log x COST_MACHINES')
scales = [float(t[6:]) for e in ev if len(e) > 1 and e[1] not in ('warm', 'teardown') for t in e if t.startswith('scale=')]
scale = max(scales) if scales else None
if only:
    for l in blocks.get(only, ['no data for phase %s' % only]): print(l)
    for g in gates_all:
        if g[0] == only: print('GATE %-4s %-42s %-28s (need %s)' % (g[2], g[1], g[3], g[4]))
# report.md: the results template of REHEARSAL-1-PLAN.md §11, filled in
md = ['# Rehearsal 1 (load test #1): results, run %s' % os.path.basename(L).replace('rehearsal-', ''), '',
      '*Generated by `scripts/loadtest/rehearsal.sh report` on %s UTC. Scale x%s of the design point (ELECTION-NIGHT-HOSTING.md §1.2).%s*' % (
          time.strftime('%Y-%m-%d %H:%M', time.gmtime()), scale, ' **Below x0.5 these numbers prove the pipeline, not capacity.**' if (scale or 0) < 0.5 else ''), '',
      '## Gates', '', '| Phase | Gate | Result | Measured | Needed | Source |', '|---|---|---|---|---|---|']
md += ['| %s | %s | **%s** | %s | %s | %s |' % g for g in gates_all]
fails = [g for g in gates_all if g[2] == 'FAIL']
md += ['', '**Verdict:** %s' % ('every gate that applies passed.' if not fails else '%d gate(s) failed: %s. Each goes into the fix list (plan §4: "any ceiling below 1.0x design goes into a fix list").' % (len(fails), '; '.join('%s/%s' % (g[0], g[1]) for g in fails))), '']
md += ['## Phases', '']
for ph, ls in blocks.items(): md += ['### %s' % ph, '', '```'] + ls + ['```', '']
md += ['## Phase log', '', '```'] + [' '.join([time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(int(e[0])))] + e[1:]) for e in ev] + ['```', '',
       '## To fill in by hand', '', '- Oracle Cost Analysis for the day (owner, next morning): $____ against the estimate above.',
       '- Anything the operator saw that the numbers do not show:', '- Fix list (each failed gate, owner + date):', '']
open(os.path.join(L, 'report.md'), 'w').write('\n'.join(md))
if not only:
    for ph, ls in blocks.items(): print('== ' + ph); [print(l) for l in ls]
    for g in gates_all: print('GATE %-4s %-8s %-42s %-28s (need %s)' % (g[2], g[0], g[1], g[3], g[4]))
print('report: %s' % os.path.join(L, 'report.md'))
PY
}

teardown_cmd() {
  target_ident
  [ -d "$LRES" ] && collect_all >/dev/null 2>&1 || true
  say "teardown: k6, samplers, hosts mappings, firewall admits, copies of fixtures and the origin secret, photo machines, peak mode, contest dates; then reset"
  local i
  for i in $(seq 1 "$G_N"); do
    if [ -n "${G_SELF[$i]}" ] && [ "$i" -gt 1 ] && [ -n "${G_SELF[1]}" ]; then continue; fi
    gssh "$i" 'for f in ~/lt/results/*/*.pid; do [ -f "$f" ] && kill -TERM -- -"$(cat "$f")" 2>/dev/null; done; sudo sed -i "/# hawkeye-rehearsal\$/d" /etc/hosts; rm -rf ~/lt; echo "generator: k6 stopped, hosts mapping and ~/lt (fixtures, origin secret, results) removed"' 2>&1 | sed "s/^/  ${G_LABEL[$i]}: /" || true
  done
  if [ -n "$PHOTO_MACHINES" ] && [ -z "$DRY" ]; then
    agent_up; local pm
    for pm in $PHOTO_MACHINES; do tssh_a "ssh -o ConnectTimeout=15 ubuntu@${pm%%:*} 'sudo bash -s stop' < /opt/hawkeye/current/scripts/staging/oracle/photo-machine.sh" 2>&1 | tail -1 | sed 's/^/  photo machine: /'; done
  else
    note "no photo machines configured: nothing to stop"
  fi
  troot <<'R' | scrub
set -uo pipefail
for f in /var/lib/hawkeye/loadtest/rehearsal/*/*/sampler.pid; do [ -f "$f" ] || continue; p="$(cat "$f")"; grep -qs rehearsal-sampler "/proc/$p/cmdline" && kill "$p"; rm -f "$f"; done
n=0; while r="$(iptables -S INPUT | grep -m1 -- '--comment hawkeye-rehearsal')"; [ -n "$r" ]; do iptables ${r/-A /-D } && n=$((n + 1)) || break; done
echo "  firewall: $n temporary generator admit(s) removed"
sed -i '/# hawkeye-rehearsal$/d' /etc/hosts; rm -rf /home/ubuntu/lt
[ -f /etc/hawkeye/peak-mode ] && /usr/local/sbin/hawkeye-peak-mode off | tail -1 | sed 's/^/  /'
REL="$(readlink -f /opt/hawkeye/current)"; C="$REL/backend/src/data/contests.json"
if [ -f "$C.pre-rehearsal" ]; then mv "$C.pre-rehearsal" "$C"; echo "  contest dates restored from the release's own file"; fi
/usr/local/sbin/hk-reset-staging | tail -1 | sed 's/^/  /'
echo "  kept on the target: $(ls -1 /var/lib/hawkeye/snapshots/ | grep -E '^(pre-test|before-rehearsal)-.*\.db$' | tr '\n' ' ')"
echo "  kept: fixtures in /var/lib/hawkeye/loadtest/fixtures (staging tokens, never leave the host); results in /var/lib/hawkeye/loadtest/rehearsal/"
echo "  host after teardown: peak mode $([ -f /etc/hawkeye/peak-mode ] && echo ON || echo off), hosts lines $(grep -c hawkeye-rehearsal /etc/hosts), admits $(iptables -S INPUT | grep -c hawkeye-rehearsal), failed units $(systemctl list-units 'hawkeye-*' --state=failed --plain --no-legend | wc -l)"
R
  mark teardown end
  rm -f "$CUR"
  if [ -f "$LRES/phases.log" ]; then
    local h; h="$(awk 'NR==1{a=$1} {b=$1} END{printf "%.2f", (b-a)/3600 + 1}' "$LRES/phases.log")"
    cost_estimate "$h" "this run, first phase to teardown + 1 h of setup"
  fi
  echo "OWNER, in the Oracle console: terminate every $GEN_NAME_PREFIX* and $PHOTO_NAME_PREFIX* instance; put $TARGET_NAME back to its everyday size; next morning read Cost Analysis. Nothing to undo in Cloudflare."
}

# ---- dispatch -------------------------------------------------------------------------------------
load_generators
case "$CMD" in
  check) check_cmd ;;
  seed) seed_cmd ;;
  warm) warm_cmd ;;
  run)
    PH="${1:-}"; [ -n "$PH" ] || die "run what? read | upload | auth | ramp | photos-start | photos | restore | all"
    target_ident
    if [ "$PH" != photos ] && [ "$PH" != restore ] && [ "$PH" != photos-start ]; then
      awk "BEGIN{exit !($SCALE >= 0.5)}" && [ "$EXPECT_CORES" != 0 ] && [ "$T_CORES" -lt "$EXPECT_CORES" ] && die "REFUSED: x$SCALE needs the target at $EXPECT_CORES cores; it has $T_CORES"
    fi
    case "$PH" in
      read) run_k6_phase read read off ;;
      upload) run_k6_phase upload upload on ;;
      auth) run_k6_phase auth auth off ;;
      ramp) run_k6_phase ramp ramp on ;;
      photos-start) photos_start_cmd ;;
      photos) photos_cmd ;;
      restore) restore_cmd ;;
      all) for p in read upload auth; do run_k6_phase "$p" "$p" "$([ "$p" = upload ] && echo on || echo off)"; done
           photos_start_cmd; run_k6_phase ramp ramp on; photos_cmd; restore_cmd ;;
      *) die "unknown phase '$PH'" ;;
    esac ;;
  collect) collect_all ;;
  report) report_cmd "${1:-}" ;;
  teardown) teardown_cmd ;;
  *) die "unknown command '$CMD' (see --help)" ;;
esac
