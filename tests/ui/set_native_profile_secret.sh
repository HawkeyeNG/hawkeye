#!/usr/bin/env bash
# Set the ONE secret ios-native-build.yml needs that Lite's does not: the App
# Store provisioning profile for ng.com.hawkeye.observer.
#
# YOU run this, not Claude — the profile is a signing credential and it goes
# straight from your disk to GitHub without being printed anywhere.
#
#   ./tests/ui/set_native_profile_secret.sh [path-to.mobileprovision]
#
# The distribution certificate, keychain password and App Store Connect key are
# already set: Lite uses the same ones, because a certificate and an ASC API key
# are team-wide. A PROFILE is bound to one App ID, which is why this is separate.
#
# LINUX, NOT macOS. The first version of this used `security cms -D` and
# `plutil`, which exist only on a Mac — it died on line 29 with
# "plutil: command not found". A .mobileprovision is a CMS-signed plist, so
# openssl unwraps it and python3's plistlib parses it; both are already here.
set -euo pipefail

PROFILE="${1:-$HOME/hawkeye-secrets/ios/Hawkeye_App_Store.mobileprovision}"
WANT_BUNDLE=ng.com.hawkeye.observer

if [ ! -f "$PROFILE" ]; then
  echo "No profile at $PROFILE"
  echo "Pass the path as the first argument, or download the App Store profile"
  echo "for $WANT_BUNDLE from developer.apple.com."
  exit 1
fi

command -v openssl >/dev/null || { echo "openssl is needed to read the profile"; exit 1; }
command -v gh >/dev/null      || { echo "gh is needed to set the secret"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

openssl smime -inform der -verify -noverify -in "$PROFILE" 2>/dev/null > "$TMP/pp.plist" \
  || { echo "Could not read $PROFILE — is it really a .mobileprovision?"; exit 1; }

# Verify BEFORE uploading. Setting Lite's profile under this name would fail ten
# minutes into an archive with an error naming neither app.
read -r BUNDLE APS NAME EXPIRES <<EOF
$(python3 - "$TMP/pp.plist" <<'PY'
import plistlib, sys
d = plistlib.load(open(sys.argv[1], 'rb'))
e = d.get('Entitlements', {})
appid = str(e.get('application-identifier', ''))
print(appid.split('.', 1)[-1] or '-',
      e.get('aps-environment', '-'),
      (d.get('Name') or '-').replace(' ', '_'),
      d.get('ExpirationDate', '-'))
PY
)
EOF

echo "profile : ${NAME//_/ }"
echo "bundle  : $BUNDLE"
echo "push    : aps-environment=$APS"
echo "expires : $EXPIRES"

if [ "$BUNDLE" != "$WANT_BUNDLE" ]; then
  echo
  echo "That is not the native app's profile (expected $WANT_BUNDLE)."
  echo "ng.com.hawkeye.lite belongs in PROVISIONING_PROFILE_BASE64, already set."
  exit 1
fi
if [ "$APS" != "production" ]; then
  echo
  echo "This profile has no production push entitlement, so TestFlight builds"
  echo "signed with it would receive no notifications. Re-generate it with"
  echo "Push Notifications enabled on the App ID."
  exit 1
fi

base64 -w0 "$PROFILE" > "$TMP/pp.b64"
gh secret set PROVISIONING_PROFILE_NATIVE_BASE64 < "$TMP/pp.b64"

echo
echo "set. Now build without spending an EAS credit:"
echo "  gh workflow run ios-native-build.yml -f build_number=18 -f upload=true"
