# shellcheck shell=bash
# Shared settings and guards for scripts/staging/*.sh. Sourced, never run.
#
# Every AWS call in these scripts passes --region explicitly and goes through
# require_account first, so a CLI signed in to the wrong account (or with a
# different default region) cannot create, bootstrap or delete anything.

# ---- Fixed by the owner --------------------------------------------------------
# Production AWS account (owner decision, 27 Sep 2026). The staging scripts refuse
# to touch any other account, including 131708657746 (the account the WSL CLI
# was signed in to when these scripts were written).
readonly HAWKEYE_ACCOUNT="025232685387"
readonly REGION="eu-west-1"
readonly AZ="eu-west-1a"

readonly NAME="hawkeye-staging"
readonly TAG_PROJECT="hawkeye"
readonly TAG_ENV="staging"
readonly IAM_PATH="/hawkeye/staging/"
readonly ROLE_NAME="hawkeye-staging-ec2"
readonly PROFILE_NAME="hawkeye-staging-ec2"
readonly SG_NAME="hawkeye-staging-origin"
readonly SSM_PREFIX="/hawkeye/staging"          # SecureString secrets live under here
readonly BUCKET="hawkeye-staging-replica-${HAWKEYE_ACCOUNT}"   # hourly DB backups + deploy bundles (+ Litestream until R2 keys exist)
readonly AMI_PARAM="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"

# --- Sizes (docs/private/ELECTION-NIGHT-HOSTING.md §2.2, §3.1, §3.2, §4) ------------
#   rehearsal  c7g.xlarge  : the plan's rehearsal-month box (default)
#   small      t4g.medium  : the plan's cheaper "Staging (t4g.medium + 40 GB)" line
#   loadtest   c7g.4xlarge : LT#1-#3 ("staging temporarily at c7g.4xlarge")
size_type() {
  case "$1" in
    rehearsal) echo c7g.xlarge ;;
    small) echo t4g.medium ;;
    loadtest) echo c7g.4xlarge ;;
    *) return 1 ;;
  esac
}
readonly ROOT_GB=10
readonly DATA_GB_DEFAULT=40

# On-demand, Linux, eu-west-1, AWS Pricing API 27 Sep 2026 (plan §3.1).
hourly_price() {
  case "$1" in
    t4g.small) echo 0.0184 ;;
    t4g.medium) echo 0.0368 ;;
    c7g.large) echo 0.0775 ;;
    c7g.xlarge) echo 0.1550 ;;
    c7g.2xlarge) echo 0.3101 ;;
    c7g.4xlarge) echo 0.6202 ;;
    *) echo "" ;;
  esac
}
readonly GP3_GB_MONTH=0.088
readonly IPV4_HOUR=0.005
readonly S3_GB_MONTH=0.023      # S3 Standard eu-west-1 (verify); staging DB is ~75 MB
readonly S3_PUT_PER_1K=0.005    # (verify); Litestream to S3 at a 10 s interval <= 8,640 PUT/day

# Cloudflare's published origin ranges, pinned 27 Sep 2026 as a fallback.
# provision.sh fetches the live lists and warns if they differ from these.
readonly CF_V4_PINNED="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
readonly CF_V6_PINNED="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

# ---- Helpers --------------------------------------------------------------------------
die() { echo "$(basename "$0"): $*" >&2; exit 2; }
say() { echo "$(basename "$0"): $*" >&2; }

# Tags in the two shapes the AWS CLI wants.
ec2_tags() {
  local t="{Key=project,Value=$TAG_PROJECT},{Key=env,Value=$TAG_ENV}"
  if [ -n "${1:-}" ]; then t="$t,{Key=Name,Value=$1}"; fi
  echo "$t"
}
iam_tags() { echo "Key=project,Value=$TAG_PROJECT Key=env,Value=$TAG_ENV"; }

aws_() { aws --region "$REGION" "$@"; }

# THE ACCOUNT GUARD. Called before ANY create/modify/delete, and before the
# read-only discovery calls too, so a wrong login fails loudly and early.
require_account() {
  command -v aws >/dev/null 2>&1 || die "aws CLI not found"
  local acct arn
  acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || die "REFUSED: 'aws sts get-caller-identity' failed (not signed in?). Run: aws login"
  arn="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"
  if [ "$acct" != "$HAWKEYE_ACCOUNT" ]; then
    die "REFUSED: the AWS CLI is signed in to account $acct ($arn). Staging lives ONLY in $HAWKEYE_ACCOUNT. Sign in to that account (aws login / AWS_PROFILE) and re-run. Nothing was created or changed."
  fi
  say "account guard OK: $acct ($arn), region $REGION"
}

# Money: awk evaluates the arithmetic expression (digits, . + - * / ( ) only).
money() {
  [[ "$1" =~ ^[0-9.+*/()\ -]+$ ]] || die "money: bad expression '$1'"
  awk "BEGIN { printf \"%.2f\", $1 }"
}
