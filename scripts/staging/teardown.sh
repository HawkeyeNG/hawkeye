#!/usr/bin/env bash
# Delete EVERYTHING tagged project=hawkeye env=staging, so staging costs nothing
# while it is not needed (docs/private/ELECTION-NIGHT-HOSTING.md §3.2).
#
#   scripts/staging/teardown.sh               # list what would go, ask for confirmation, delete
#   scripts/staging/teardown.sh --list        # list only; delete nothing
#   scripts/staging/teardown.sh --keep-bucket # keep the S3 bucket (its hourly DB backups and any Litestream history)
#   scripts/staging/teardown.sh --yes         # no prompt (for scripts; still guarded by the account check)
#
# Found by TAG (Resource Groups Tagging API + EC2 filters), plus the IAM role and
# instance profile, which that API cannot see, by their fixed path AND their tags.
# Staging data is disposable: it is a restored prod snapshot plus test rows, and
# prod's own replicas are untouched (different buckets, different names).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

LIST=""; KEEP_BUCKET=""; YES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1; shift ;;
    --keep-bucket) KEEP_BUCKET=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

require_account

TAGF=(--filters "Name=tag:project,Values=$TAG_PROJECT" "Name=tag:env,Values=$TAG_ENV")
INSTANCES="$(aws_ ec2 describe-instances "${TAGF[@]}" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
VOLUMES="$(aws_ ec2 describe-volumes "${TAGF[@]}" --query 'Volumes[].VolumeId' --output text)"
SNAPSHOTS="$(aws_ ec2 describe-snapshots --owner-ids self "${TAGF[@]}" --query 'Snapshots[].SnapshotId' --output text)"
SGS="$(aws_ ec2 describe-security-groups "${TAGF[@]}" --query 'SecurityGroups[].GroupId' --output text)"
EIPS="$(aws_ ec2 describe-addresses "${TAGF[@]}" --query 'Addresses[].AllocationId' --output text)"
# Everything else the tagging API knows about (S3, SSM parameters, anything added by hand).
ARNS="$(aws_ resourcegroupstaggingapi get-resources --tag-filters "Key=project,Values=$TAG_PROJECT" "Key=env,Values=$TAG_ENV" \
  --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | sort -u)"
BUCKETS="$(grep '^arn:aws:s3:::' <<<"$ARNS" | sed 's#^arn:aws:s3:::##' || true)"
PARAMS="$(aws_ ssm describe-parameters --parameter-filters "Key=Path,Option=Recursive,Values=$SSM_PREFIX" \
  --query 'Parameters[].Name' --output text | tr '\t' '\n' | sed '/^$/d' || true)"
# IAM is global and invisible to the tagging API: fixed path + tag check.
ROLES=""; for r in $(aws iam list-roles --path-prefix "$IAM_PATH" --query 'Roles[].RoleName' --output text); do
  [ "$(aws iam list-role-tags --role-name "$r" --query "Tags[?Key=='env'].Value | [0]" --output text)" = "$TAG_ENV" ] && ROLES="$ROLES $r"
done
PROFILES="$(aws iam list-instance-profiles --path-prefix "$IAM_PATH" --query 'InstanceProfiles[].InstanceProfileName' --output text)"
# ARNs the script does not know how to delete: listed, never silently skipped.
UNKNOWN="$(grep -vE '^arn:aws:(s3:::|ssm:[^:]+:[0-9]+:parameter/|ec2:[^:]+:[0-9]+:(instance|volume|snapshot|security-group|network-interface|elastic-ip)/)' <<<"$ARNS" | sed '/^$/d' || true)"

# Never touch a production-looking name, whatever its tags say.
for n in $BUCKETS; do case "$n" in *staging*) ;; *) die "tagged bucket '$n' does not look like staging; refusing (fix its tags by hand)";; esac; done
for n in $PARAMS; do case "$n" in "$SSM_PREFIX"/*) ;; *) die "parameter '$n' is outside $SSM_PREFIX; refusing";; esac; done

show() { local label="$1"; shift; local v; v="$(echo "$*" | xargs)"; printf '  %-18s %s\n' "$label" "${v:-(none)}"; }
echo
echo "== Hawkeye staging resources in $HAWKEYE_ACCOUNT / $REGION (tag project=$TAG_PROJECT env=$TAG_ENV)"
show "EC2 instances" "$INSTANCES"
show "EBS volumes" "$VOLUMES"
show "EBS snapshots" "$SNAPSHOTS"
show "Elastic IPs" "$EIPS"
show "security groups" "$SGS"
show "IAM roles" "$ROLES"
show "instance profiles" "$PROFILES"
show "SSM parameters" "$PARAMS"
if [ -n "$KEEP_BUCKET" ]; then show "S3 buckets (KEPT)" "$BUCKETS"; else show "S3 buckets" "$BUCKETS"; fi
[ -z "$UNKNOWN" ] || { echo "  NOT HANDLED (delete by hand):"; sed 's/^/    /' <<<"$UNKNOWN"; }
echo

DEL_BUCKETS="$BUCKETS"; [ -z "$KEEP_BUCKET" ] || DEL_BUCKETS=""
TOTAL="$(echo "$INSTANCES $VOLUMES $SNAPSHOTS $EIPS $SGS $ROLES $PROFILES $PARAMS $DEL_BUCKETS" | wc -w)"
if [ "$TOTAL" = 0 ]; then say "nothing tagged env=staging exists. Staging costs 0."; exit 0; fi
[ -z "$LIST" ] || { say "--list: nothing deleted."; exit 0; }

if [ -z "$YES" ]; then
  [ -t 0 ] || die "not a terminal; re-run interactively or pass --yes"
  printf 'This PERMANENTLY deletes the resources above (staging DB, replicas, secrets).\nType "delete hawkeye staging" to continue: '
  read -r answer
  [ "$answer" = "delete hawkeye staging" ] || die "not confirmed; nothing deleted"
fi

# ---- Delete in dependency order ------------------------------------------------------------
if [ -n "$INSTANCES" ]; then
  say "terminating $INSTANCES"
  # shellcheck disable=SC2086
  aws_ ec2 terminate-instances --instance-ids $INSTANCES >/dev/null
  # shellcheck disable=SC2086
  aws_ ec2 wait instance-terminated --instance-ids $INSTANCES
fi
for a in $EIPS; do say "releasing EIP $a"; aws_ ec2 release-address --allocation-id "$a"; done
# Volumes with DeleteOnTermination went with the instance; anything left is deleted now.
for v in $(aws_ ec2 describe-volumes "${TAGF[@]}" --query 'Volumes[].VolumeId' --output text); do
  aws_ ec2 wait volume-available --volume-ids "$v" 2>/dev/null || true
  say "deleting volume $v"; aws_ ec2 delete-volume --volume-id "$v"
done
for s in $SNAPSHOTS; do say "deleting snapshot $s"; aws_ ec2 delete-snapshot --snapshot-id "$s"; done
for g in $SGS; do
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do   # the ENI of a just-terminated instance lingers briefly
    aws_ ec2 delete-security-group --group-id "$g" 2>/dev/null && { say "deleted security group $g"; break; }
    sleep 10
  done
done
for p in $PROFILES; do
  for r in $(aws iam get-instance-profile --instance-profile-name "$p" --query 'InstanceProfile.Roles[].RoleName' --output text); do
    aws iam remove-role-from-instance-profile --instance-profile-name "$p" --role-name "$r"
  done
  say "deleting instance profile $p"; aws iam delete-instance-profile --instance-profile-name "$p"
done
for r in $ROLES; do
  for a in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$r" --policy-arn "$a"
  done
  for n in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$r" --policy-name "$n"
  done
  say "deleting IAM role $r"; aws iam delete-role --role-name "$r"
done
if [ -n "$PARAMS" ]; then
  # delete-parameters takes at most 10 names per call
  # shellcheck disable=SC2086
  printf '%s\n' $PARAMS | xargs -n 10 aws --region "$REGION" ssm delete-parameters --names >/dev/null
  say "deleted $(wc -w <<<"$PARAMS") SSM parameter(s)"
fi
if [ -n "$DEL_BUCKETS" ]; then
  for b in $DEL_BUCKETS; do
    say "emptying and deleting s3://$b"
    aws_ s3 rm "s3://$b" --recursive --only-show-errors
    aws_ s3api delete-bucket --bucket "$b"
  done
fi

# ---- Prove it: list again. A teardown that only prints success is not a teardown. --------
sleep 5
LEFT_EC2="$(aws_ ec2 describe-instances "${TAGF[@]}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
$(aws_ ec2 describe-volumes "${TAGF[@]}" --query 'Volumes[].VolumeId' --output text)
$(aws_ ec2 describe-security-groups "${TAGF[@]}" --query 'SecurityGroups[].GroupId' --output text)"
LEFT_IAM="$(aws iam list-roles --path-prefix "$IAM_PATH" --query 'Roles[].RoleName' --output text) $(aws iam list-instance-profiles --path-prefix "$IAM_PATH" --query 'InstanceProfiles[].InstanceProfileName' --output text)"
LEFT_SSM="$(aws_ ssm describe-parameters --parameter-filters "Key=Path,Option=Recursive,Values=$SSM_PREFIX" --query 'Parameters[].Name' --output text)"
LEFT_S3=""; for b in $DEL_BUCKETS; do if aws_ s3api head-bucket --bucket "$b" >/dev/null 2>&1; then LEFT_S3="$LEFT_S3 $b"; fi; done
LEFT="$(echo "$LEFT_EC2 $LEFT_IAM $LEFT_SSM $LEFT_S3" | xargs)"
if [ -n "$LEFT" ]; then die "still present after teardown: $LEFT"; fi
if [ -n "$KEEP_BUCKET" ]; then
  say "teardown verified: only the kept bucket remains ($BUCKETS): cents per month of storage."
else
  say "teardown verified: nothing tagged env=staging is left. Staging now costs 0."
fi
