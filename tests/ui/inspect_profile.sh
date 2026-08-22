#!/usr/bin/env bash
# Read the interesting fields out of an Apple provisioning profile.
# It is a CMS-signed plist, so strip the signature first. Reads only.
set -euo pipefail
PROFILE="${1:-/mnt/c/Users/HP/Downloads/Hawkeye_App_Store.mobileprovision}"
CERT="${2:-/mnt/c/Users/HP/Downloads/distribution.cer}"

echo "=== profile: $PROFILE"
PLIST="$(openssl smime -inform DER -verify -noverify -in "$PROFILE" 2>/dev/null)"

field() {
  echo "$PLIST" | grep -A 1 "<key>$1</key>" | tail -1 | sed 's/.*<string>\(.*\)<\/string>.*/\1/'
}
echo "Name              : $(field Name)"
echo "AppIDName         : $(field AppIDName)"
echo "TeamName          : $(field TeamName)"
echo "TeamIdentifier    : $(echo "$PLIST" | grep -A 3 '<key>TeamIdentifier</key>' | grep '<string>' | head -1 | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
echo "application-id    : $(echo "$PLIST" | grep -A 1 'application-identifier' | tail -1 | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
echo "CreationDate      : $(echo "$PLIST" | grep -A 1 '<key>CreationDate</key>' | tail -1 | sed 's/.*<date>\(.*\)<\/date>.*/\1/')"
echo "ExpirationDate    : $(echo "$PLIST" | grep -A 1 '<key>ExpirationDate</key>' | tail -1 | sed 's/.*<date>\(.*\)<\/date>.*/\1/')"
echo "ProvisionsAllDevices/method: $(echo "$PLIST" | grep -o 'get-task-allow' | head -1) (absent value = distribution)"

echo
echo "=== certificate: $CERT"
openssl x509 -inform DER -in "$CERT" -noout -subject -issuer -dates 2>/dev/null \
  || openssl x509 -in "$CERT" -noout -subject -issuer -dates
