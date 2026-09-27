#!/usr/bin/env bash
# Provision Hawkeye STAGING in AWS eu-west-1 (docs/private/ELECTION-NIGHT-HOSTING.md §2, §4).
#
#   scripts/staging/provision.sh                 # DRY RUN (default): print every resource + cost,
#                                                #   then check the account and run EC2 --dry-run calls
#   scripts/staging/provision.sh --offline       # print the plan only; no AWS call at all
#   scripts/staging/provision.sh --apply         # create (refuses unless the account is 025232685387)
#
#   --size rehearsal|small|loadtest   c7g.xlarge (default) | t4g.medium | c7g.4xlarge
#   --instance-type TYPE              override (Graviton only: the box is arm64)
#   --data-gb N                       data volume size (default 40)
#
# Creates, all tagged project=hawkeye env=staging:
#   EC2 (AL2023 arm64, IMDSv2 only, no key pair) + gp3 root + gp3 data volume + public IPv4
#   security group: 80/443 from Cloudflare's ranges only, egress 443 only, NO port 22 (SSM only)
#   IAM role + instance profile: SSM Session Manager, S3 on the staging bucket, SSM params under /hawkeye/staging/
#   S3 bucket: Litestream's second replica + deploy bundles (private, SSE-S3, TLS only)
#   SSM SecureString parameters: fresh JWT_SECRET / ORACLE_SECRET / PHONE_SALT / ORIGIN_AUTH_SECRET
# Idempotent: anything that already exists is reused, never replaced.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

APPLY=""; OFFLINE=""; SIZE="rehearsal"; ITYPE=""; DATA_GB="$DATA_GB_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    --size) SIZE="${2:-}"; shift 2 ;;
    --instance-type) ITYPE="${2:-}"; shift 2 ;;
    --data-gb) DATA_GB="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done
[ -z "$APPLY" ] || [ -z "$OFFLINE" ] || die "--apply and --offline are mutually exclusive"
if [ -z "$ITYPE" ]; then ITYPE="$(size_type "$SIZE")" || die "unknown --size '$SIZE' (rehearsal|small|loadtest)"; fi
[[ "$ITYPE" =~ ^[a-z]+[0-9]+g[a-z]*\.[a-z0-9]+$ ]] || die "$ITYPE is not a Graviton (arm64) type; the AMI and the bootstrap are arm64"
[[ "$DATA_GB" =~ ^[0-9]+$ ]] && [ "$DATA_GB" -ge 20 ] || die "--data-gb must be an integer >= 20"
PRICE="$(hourly_price "$ITYPE")"

# ---- Cloudflare ranges: live list, pinned fallback, drift warning --------------------
fetch_cf() {
  curl -fsS --max-time 15 "https://www.cloudflare.com/$1" 2>/dev/null | tr -s ' \r\n' ' ' | sed 's/^ //; s/ $//'
}
CF_V4="$(fetch_cf ips-v4 || true)"; CF_V6="$(fetch_cf ips-v6 || true)"
CF_SRC="live (cloudflare.com/ips-v4, ips-v6)"
if [ -z "$CF_V4" ] || [ -z "$CF_V6" ]; then
  CF_V4="$CF_V4_PINNED"; CF_V6="$CF_V6_PINNED"; CF_SRC="PINNED fallback (could not fetch the live list)"
fi
sorted() { tr ' ' '\n' <<<"$1" | sort; }
if [ "$(sorted "$CF_V4")" != "$(sorted "$CF_V4_PINNED")" ] || [ "$(sorted "$CF_V6")" != "$(sorted "$CF_V6_PINNED")" ]; then
  say "WARNING: Cloudflare's live ranges differ from the list pinned in lib.sh. Using the LIVE list; update lib.sh."
fi
for c in $CF_V4; do [[ "$c" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || die "bad Cloudflare v4 range '$c'"; done
for c in $CF_V6; do [[ "$c" =~ ^[0-9a-f:]+/[0-9]+$ ]] || die "bad Cloudflare v6 range '$c'"; done
N4=$(wc -w <<<"$CF_V4"); N6=$(wc -w <<<"$CF_V6")

# ---- The plan ---------------------------------------------------------------------
EBS_GB=$((ROOT_GB + DATA_GB))
if [ -n "$PRICE" ]; then
  EC2_DAY="$(money "$PRICE*24")"; EC2_MON="$(money "$PRICE*730")"
else
  EC2_DAY="?"; EC2_MON="?"; say "WARNING: no price on file for $ITYPE (lib.sh hourly_price); totals exclude it"; PRICE=0
fi
EBS_DAY="$(money "$EBS_GB*$GP3_GB_MONTH*12/365")"; EBS_MON="$(money "$EBS_GB*$GP3_GB_MONTH")"
IP_DAY="$(money "$IPV4_HOUR*24")"; IP_MON="$(money "$IPV4_HOUR*730")"
S3_DAY="$(money "8.64*$S3_PUT_PER_1K + 0.1*$S3_GB_MONTH*12/365")"; S3_MON="$(money "(8.64*$S3_PUT_PER_1K)*365/12 + 0.1*$S3_GB_MONTH")"
TOT_DAY="$(money "$PRICE*24 + $EBS_GB*$GP3_GB_MONTH*12/365 + $IPV4_HOUR*24 + 8.64*$S3_PUT_PER_1K + 0.1*$S3_GB_MONTH*12/365")"
TOT_MON="$(money "$PRICE*730 + $EBS_GB*$GP3_GB_MONTH + $IPV4_HOUR*730 + (8.64*$S3_PUT_PER_1K)*365/12 + 0.1*$S3_GB_MONTH")"
TOT_HR="$(money "$PRICE + $EBS_GB*$GP3_GB_MONTH/730 + $IPV4_HOUR")"

MODE="DRY RUN: nothing is created without --apply"
[ -n "$APPLY" ] && MODE="APPLY: resources below will be CREATED (if missing)"
[ -n "$OFFLINE" ] && MODE="OFFLINE: plan only, no AWS call is made"
cat <<EOF

== Hawkeye staging: $MODE
   account $HAWKEYE_ACCOUNT (required) | region $REGION ($AZ) | every resource tagged project=$TAG_PROJECT env=$TAG_ENV

 #  RESOURCE           NAME / SETTINGS
 1  EC2 instance       $NAME: $ITYPE (--size $SIZE), Amazon Linux 2023 arm64 (SSM public AMI parameter),
                       IMDSv2 required, no key pair, no user-data secrets$([ "${ITYPE%%.*}" = t4g ] && echo ", CPU credits = standard (no surplus charges)")
 2  EBS gp3 root       ${ROOT_GB} GB, encrypted, deleted with the instance
 3  EBS gp3 data       ${DATA_GB} GB, encrypted, /var/lib/hawkeye (SQLite WAL + uploads), deleted with the instance
 4  Public IPv4        1, auto-assigned. Cloudflare's origin record only; never publish it (plan §2.2)
 5  Security group     $SG_NAME (default VPC): IN tcp 80,443 from $N4 Cloudflare IPv4 + $N6 IPv6 ranges ONLY;
                       OUT tcp 443 only; NO port 22 (shell = SSM Session Manager). Ranges: $CF_SRC
 6  IAM role           ${IAM_PATH}$ROLE_NAME: AmazonSSMManagedInstanceCore + inline: s3 on $BUCKET,
                       ssm:GetParameter(s)/GetParametersByPath on ${SSM_PREFIX}/*
 7  Instance profile   ${IAM_PATH}$PROFILE_NAME (holds the role)
 8  S3 bucket          $BUCKET: private (all public access blocked), SSE-S3, TLS-only policy,
                       Litestream replica #2 (litestream/) + deploy bundles (deploy/)
 9  SSM parameters     ${SSM_PREFIX}/env/{JWT_SECRET,ORACLE_SECRET,PHONE_SALT,ORIGIN_AUTH_SECRET}: SecureString (aws/ssm key),
                       generated fresh here (never copied from prod), never printed. Standard tier: free

EOF
row() { printf '   %-54s %8s %11s\n' "$1" "$2" "$3"; }
row "COST (on-demand, eu-west-1, plan §3.1)" "USD/day" "USD/month"
row "$ITYPE @ $PRICE/h" "$EC2_DAY" "$EC2_MON"
row "EBS gp3 ${EBS_GB} GB (root $ROOT_GB + data $DATA_GB) @ $GP3_GB_MONTH/GB-mo" "$EBS_DAY" "$EBS_MON"
row "Public IPv4 @ $IPV4_HOUR/h" "$IP_DAY" "$IP_MON"
row "S3 replica (upper bound: 8,640 PUT/day, ~0.1 GB)" "$S3_DAY" "$S3_MON"
row "SSM Parameter Store (standard), Session Manager" "0.00" "0.00"
row "Data out (behind Cloudflare; first 100 GB/mo free)" "0.00" "0.00"
row "TOTAL (= $TOT_HR/h while it exists; month = 730 h)" "$TOT_DAY" "$TOT_MON"
OTHERS=""
for s in small rehearsal loadtest; do
  t="$(size_type "$s")"; p="$(hourly_price "$t")"
  OTHERS="$OTHERS  $s ($t) $(money "$p*24 + $EBS_GB*$GP3_GB_MONTH*12/365 + $IPV4_HOUR*24 + 8.64*$S3_PUT_PER_1K")/day;"
done
echo "   By size:${OTHERS%;}"
echo "   Stopped instead of torn down: EBS only, $EBS_DAY/day (the public IPv4 is released). After teardown.sh: 0."
echo

if [ -n "$OFFLINE" ]; then say "offline: no AWS call was made."; exit 0; fi

# ---- From here on AWS is called. The guard comes FIRST. --------------------------------
require_account

VPC="$(aws_ ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
[ -n "$VPC" ] && [ "$VPC" != "None" ] || die "no default VPC in $REGION; create one (aws ec2 create-default-vpc) or extend this script"
SUBNET="$(aws_ ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=availability-zone,Values="$AZ" Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' --output text)"
[ -n "$SUBNET" ] && [ "$SUBNET" != "None" ] || die "no default subnet in $AZ"
AMI="$(aws_ ssm get-parameter --name "$AMI_PARAM" --query 'Parameter.Value' --output text)"
say "default VPC $VPC, subnet $SUBNET ($AZ), AMI $AMI"

EXISTING_INSTANCE="$(aws_ ec2 describe-instances \
  --filters Name=tag:project,Values="$TAG_PROJECT" Name=tag:env,Values="$TAG_ENV" \
            Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
SG_ID="$(aws_ ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
[ "$SG_ID" = "None" ] && SG_ID=""
ROLE_EXISTS=""; aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 && ROLE_EXISTS=1
PROFILE_EXISTS=""; aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1 && PROFILE_EXISTS=1
BUCKET_EXISTS=""; aws_ s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 && BUCKET_EXISTS=1

state() { if [ -n "$1" ]; then echo "exists ($1), reused"; else echo "will be created"; fi; }
cat <<EOF
 CURRENT STATE
   instance          $(state "$EXISTING_INSTANCE")
   security group    $(state "$SG_ID")
   IAM role          $(state "${ROLE_EXISTS:+$ROLE_NAME}")
   instance profile  $(state "${PROFILE_EXISTS:+$PROFILE_NAME}")
   S3 bucket         $(state "${BUCKET_EXISTS:+$BUCKET}")
EOF

BDM="[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$ROOT_GB,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}},
      {\"DeviceName\":\"/dev/sdf\",\"Ebs\":{\"VolumeSize\":$DATA_GB,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]"
META="HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1,InstanceMetadataTags=enabled"
CREDIT=(); [ "${ITYPE%%.*}" = t4g ] && CREDIT=(--credit-specification CpuCredits=standard)

if [ -z "$APPLY" ]; then
  # Free, create-nothing validation: EC2 answers DryRunOperation when the call WOULD succeed.
  out="$(aws_ ec2 run-instances --dry-run --image-id "$AMI" --instance-type "$ITYPE" --subnet-id "$SUBNET" \
    --block-device-mappings "$BDM" --metadata-options "$META" "${CREDIT[@]}" \
    --tag-specifications "ResourceType=instance,Tags=[$(ec2_tags "$NAME")]" 2>&1 || true)"
  if grep -q DryRunOperation <<<"$out"; then say "EC2 dry run: run-instances WOULD succeed ($ITYPE in $AZ)"; else say "EC2 dry run FAILED: $out"; fi
  if [ -z "$SG_ID" ]; then
    out="$(aws_ ec2 create-security-group --dry-run --group-name "$SG_NAME" --description x --vpc-id "$VPC" 2>&1 || true)"
    if grep -q DryRunOperation <<<"$out"; then say "EC2 dry run: create-security-group WOULD succeed"; else say "EC2 dry run FAILED: $out"; fi
  fi
  say "dry run complete. Nothing was created. Re-run with --apply to create."
  exit 0
fi

# =============================== APPLY ================================================
# 1. S3 bucket ----------------------------------------------------------------------------
if [ -z "$BUCKET_EXISTS" ]; then
  say "creating bucket $BUCKET"
  aws_ s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  aws_ s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws_ s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
  aws_ s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws_ s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TLSOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
  # Old deploy bundles are not worth paying for.
  aws_ s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-deploy-bundles","Status":"Enabled","Filter":{"Prefix":"deploy/"},"Expiration":{"Days":30}}]}'
fi
aws_ s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=project,Value=$TAG_PROJECT},{Key=env,Value=$TAG_ENV},{Key=Name,Value=$NAME}]"

# 2. IAM role + instance profile ---------------------------------------------------------
if [ -z "$ROLE_EXISTS" ]; then
  say "creating IAM role ${IAM_PATH}$ROLE_NAME"
  # shellcheck disable=SC2046
  aws iam create-role --role-name "$ROLE_NAME" --path "$IAM_PATH" \
    --description "Hawkeye staging EC2: SSM Session Manager, S3 replica bucket, staging SSM parameters" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags $(iam_tags) >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name hawkeye-staging-inline --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[
    {\"Sid\":\"ReplicaBucketList\",\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":\"arn:aws:s3:::$BUCKET\"},
    {\"Sid\":\"ReplicaBucketObjects\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},
    {\"Sid\":\"StagingParams\",\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParameters\",\"ssm:GetParametersByPath\"],
     \"Resource\":[\"arn:aws:ssm:$REGION:$HAWKEYE_ACCOUNT:parameter${SSM_PREFIX}\",\"arn:aws:ssm:$REGION:$HAWKEYE_ACCOUNT:parameter${SSM_PREFIX}/*\"]}
  ]}"
if [ -z "$PROFILE_EXISTS" ]; then
  say "creating instance profile ${IAM_PATH}$PROFILE_NAME"
  # shellcheck disable=SC2046
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" --path "$IAM_PATH" --tags $(iam_tags) >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"
fi

# 3. Security group ------------------------------------------------------------------------
if [ -z "$SG_ID" ]; then
  say "creating security group $SG_NAME"
  SG_ID="$(aws_ ec2 create-security-group --group-name "$SG_NAME" --vpc-id "$VPC" \
    --description "Hawkeye staging origin: 80/443 from Cloudflare only; no SSH (SSM)" \
    --tag-specifications "ResourceType=security-group,Tags=[$(ec2_tags "$SG_NAME")]" --query GroupId --output text)"
  # Egress: replace allow-all with 443 only (SSM, S3, R2, npm, nodejs.org, GitHub are all HTTPS).
  aws_ ec2 revoke-security-group-egress --group-id "$SG_ID" --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null
  aws_ ec2 authorize-security-group-egress --group-id "$SG_ID" --ip-permissions \
    '[{"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"HTTPS out"}],"Ipv6Ranges":[{"CidrIpv6":"::/0","Description":"HTTPS out"}]}]' >/dev/null
fi
# One call per range and port: idempotent (a duplicate is skipped, a missing one added).
for port in 80 443; do
  for c in $CF_V4 $CF_V6; do
    if [[ "$c" == *:* ]]; then r="\"Ipv6Ranges\":[{\"CidrIpv6\":\"$c\",\"Description\":\"Cloudflare\"}]"
    else r="\"IpRanges\":[{\"CidrIp\":\"$c\",\"Description\":\"Cloudflare\"}]"; fi
    out="$(aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
      --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":$port,\"ToPort\":$port,$r}]" 2>&1 >/dev/null || true)"
    if [ -n "$out" ] && ! grep -q InvalidPermission.Duplicate <<<"$out"; then die "ingress $port from $c: $out"; fi
  done
done
# Prove it: no rule may admit port 22, and every ingress source must be a Cloudflare range.
BAD="$(aws_ ec2 describe-security-groups --group-ids "$SG_ID" --query \
  'SecurityGroups[0].IpPermissions[?FromPort==`22` || ToPort==`22` || IpProtocol==`-1`]' --output text)"
[ -z "$BAD" ] || die "security group $SG_ID admits port 22 or all traffic: $BAD"
SRCS="$(aws_ ec2 describe-security-groups --group-ids "$SG_ID" --query 'SecurityGroups[0].IpPermissions[].[IpRanges[].CidrIp, Ipv6Ranges[].CidrIpv6][][]' --output text | tr '\t' '\n' | sort -u)"
for s in $SRCS; do tr ' ' '\n' <<<"$CF_V4 $CF_V6" | grep -qxF -- "$s" || die "security group $SG_ID admits a non-Cloudflare source: $s"; done
say "security group $SG_ID verified: Cloudflare-only ingress, no port 22"

# 4. Fresh secrets in SSM (never printed, never overwritten) ------------------------------
for p in JWT_SECRET ORACLE_SECRET PHONE_SALT ORIGIN_AUTH_SECRET; do
  if aws_ ssm get-parameter --name "$SSM_PREFIX/env/$p" --query Parameter.Name --output text >/dev/null 2>&1; then
    say "SSM $SSM_PREFIX/env/$p exists, kept"
  else
    # shellcheck disable=SC2046
    aws_ ssm put-parameter --name "$SSM_PREFIX/env/$p" --type SecureString --tier Standard \
      --value "$(openssl rand -hex 32)" --tags $(iam_tags) >/dev/null
    say "SSM $SSM_PREFIX/env/$p created"
  fi
done

# 5. The instance --------------------------------------------------------------------------
if [ -n "$EXISTING_INSTANCE" ]; then
  say "instance $EXISTING_INSTANCE already exists (tag env=staging); not creating another"
  IID="$EXISTING_INSTANCE"
else
  say "launching $ITYPE"
  IID=""; ERR="$(mktemp)"
  for attempt in 1 2 3 4 5 6; do   # a new instance profile takes a few seconds to be usable
    if IID="$(aws_ ec2 run-instances --image-id "$AMI" --instance-type "$ITYPE" \
        --network-interfaces "DeviceIndex=0,SubnetId=$SUBNET,Groups=$SG_ID,AssociatePublicIpAddress=true" \
        --iam-instance-profile Name="$PROFILE_NAME" \
        --block-device-mappings "$BDM" --metadata-options "$META" "${CREDIT[@]}" \
        --tag-specifications "ResourceType=instance,Tags=[$(ec2_tags "$NAME")]" \
                             "ResourceType=volume,Tags=[$(ec2_tags "$NAME")]" \
                             "ResourceType=network-interface,Tags=[$(ec2_tags "$NAME")]" \
        --query 'Instances[0].InstanceId' --output text 2>"$ERR")"; then break; fi
    grep -q 'Invalid IAM Instance Profile' "$ERR" || { cat "$ERR" >&2; die "run-instances failed"; }
    say "instance profile not visible to EC2 yet (attempt $attempt); retrying in 10 s"; sleep 10
  done
  rm -f "$ERR"
  [ -n "$IID" ] || die "run-instances did not return an instance id"
fi
aws_ ec2 wait instance-running --instance-ids "$IID"
IP="$(aws_ ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
say "instance $IID running. Waiting for the SSM agent (no SSH exists)..."
for _ in $(seq 1 40); do
  ssm_ping="$(aws_ ssm describe-instance-information --filters Key=InstanceIds,Values="$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$ssm_ping" = "Online" ] && break; sleep 10
done
if [ "${ssm_ping:-}" = "Online" ]; then say "SSM agent Online"; else say "WARNING: SSM agent not Online yet; bootstrap.sh will wait for it"; fi

cat <<EOF

== staging provisioned
   instance  $IID ($ITYPE, $AZ)      shell: aws ssm start-session --region $REGION --target $IID
   origin IP $IP  -> Cloudflare DNS: staging.hawkeye.com.ng A $IP, PROXIED (orange cloud) ONLY.
                    Never a DNS-only record, never in a doc or a chat (plan §2.2).
   bucket    s3://$BUCKET
   costs     $TOT_DAY USD/day until scripts/staging/teardown.sh
   next      scripts/staging/bootstrap.sh
EOF
