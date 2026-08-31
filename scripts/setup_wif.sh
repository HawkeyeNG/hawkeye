#!/usr/bin/env bash
#
# Workload Identity Federation: let GitHub Actions publish to Play WITHOUT a key.
#
# RUN THIS IN GOOGLE CLOUD SHELL, not here. Open
#   https://console.cloud.google.com/?cloudshell=true&project=hawkeye-503910&authuser=1
# and paste the whole file. Cloud Shell is already authenticated as you, so
# there is nothing to install and no credential to download — which is the
# entire point: the org policy iam.disableServiceAccountKeyCreation blocks
# service-account keys, and this satisfies that policy instead of circumventing
# it. GitHub presents a short-lived OIDC token; Google exchanges it for
# credentials that expire in an hour. Nothing long-lived exists to leak.
#
# WHAT IT CREATES
#   - a workload identity pool and an OIDC provider trusting GitHub
#   - a binding letting ONLY this repo impersonate the publisher service account
#
# THE ONE LINE THAT MATTERS MOST is the attribute condition. Without it, ANY
# repository on GitHub can present a token and impersonate the account — the
# classic and very expensive misconfiguration of this feature. It is set below
# and the script refuses to continue if it is empty.
set -euo pipefail

PROJECT_ID="hawkeye-503910"
POOL="github-pool"
PROVIDER="github-provider"
SA="hawkeye-play-publisher@${PROJECT_ID}.iam.gserviceaccount.com"
REPO="HawkeyeNG/hawkeye"          # owner/name — the ONLY repo allowed to publish

[ -n "$REPO" ] || { echo "REPO must be set — without it any repo could publish"; exit 1; }

gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo "project number: $PROJECT_NUMBER"

echo "==> enabling the APIs this needs"
gcloud services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  androidpublisher.googleapis.com

echo "==> workload identity pool"
gcloud iam workload-identity-pools create "$POOL" \
  --location=global \
  --display-name="GitHub Actions" \
  2>/dev/null || echo "    (already exists)"

echo "==> OIDC provider, restricted to ${REPO}"
# attribute-condition is the security boundary. Everything else is plumbing.
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global \
  --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository == '${REPO}'" \
  2>/dev/null || {
    echo "    (already exists — updating the condition, which is the part worth being sure of)"
    gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" \
      --location=global \
      --workload-identity-pool="$POOL" \
      --attribute-condition="assertion.repository == '${REPO}'"
  }

echo "==> letting only ${REPO} impersonate ${SA}"
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"

PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

echo
echo "==================== VERIFY ===================="
echo "attribute condition now on the provider:"
gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --format='value(attributeCondition)'
echo
echo "who may impersonate the service account:"
gcloud iam service-accounts get-iam-policy "$SA" \
  --format='table(bindings.role, bindings.members)' | grep -i workloadidentity || true

echo
echo "==================== ADD THESE TO GITHUB ===================="
echo "Repository -> Settings -> Secrets and variables -> Actions -> New repository secret"
echo
echo "  GCP_WIF_PROVIDER   ${PROVIDER_RESOURCE}"
echo "  GCP_SERVICE_ACCOUNT ${SA}"
echo
echo "Then, in Play Console -> Users and permissions -> Invite new user:"
echo "  ${SA}"
echo "  grant 'Release to testing tracks' on Hawkeye and Hawkeye Lite."
echo "  (The service account must be a Play user; the Cloud side alone is not enough.)"
