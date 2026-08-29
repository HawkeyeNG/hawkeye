#!/usr/bin/env bash
# Set the ONE secret ios-native-build.yml needs that Lite's does not: the App
# Store provisioning profile for ng.com.hawkeye.observer.
#
# YOU run this, not Claude — the profile is a signing credential and it goes
# straight from your disk to GitHub without being printed anywhere.
#
#   ./tests/ui/set_native_profile_secret.sh
#
# The distribution certificate, keychain password and App Store Connect key are
# already set (Lite uses the same ones — the cert and ASC key are team-wide).
# A PROFILE is bound to one App ID, which is why this one is separate.
set -euo pipefail

PROFILE="${1:-$HOME/hawkeye-secrets/ios/Hawkeye_App_Store.mobileprovision}"

if [ ! -f "$PROFILE" ]; then
  echo "No profile at $PROFILE"
  echo "Pass the path as the first argument, or download the App Store profile"
  echo "for ng.com.hawkeye.observer from developer.apple.com."
  exit 1
fi

# Verify it is the NATIVE profile before uploading it. Setting Lite's profile
# under this name would fail ten minutes into an archive with an error naming
# neither app.
APPID=$(security cms -D -i "$PROFILE" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null \
        || openssl smime -inform der -verify -noverify -in "$PROFILE" 2>/dev/null \
           | plutil -extract Entitlements.application-identifier raw - -)
BUNDLE="${APPID#*.}"
echo "profile is for: $BUNDLE"
if [ "$BUNDLE" != "ng.com.hawkeye.observer" ]; then
  echo "That is not the native app's profile (expected ng.com.hawkeye.observer)."
  echo "ng.com.hawkeye.lite belongs in PROVISIONING_PROFILE_BASE64, which is already set."
  exit 1
fi

base64 -w0 "$PROFILE" 2>/dev/null > /tmp/native_pp.b64 || base64 -i "$PROFILE" -o /tmp/native_pp.b64
gh secret set PROVISIONING_PROFILE_NATIVE_BASE64 < /tmp/native_pp.b64
rm -f /tmp/native_pp.b64

echo
echo "set. Now build without spending an EAS credit:"
echo "  gh workflow run ios-native-build.yml -f build_number=18 -f upload=true"
