#!/usr/bin/env bash
#
# Upload the latest iOS build to App Store Connect, where it becomes a
# TestFlight build. This does NOT submit anything for App Review — that stays a
# deliberate click in App Store Connect.
#
# WHY THE PATCH-AND-REVERT DANCE. `eas submit --non-interactive` will only use
# an App Store Connect API key that is named in eas.json; there are no
# environment variables for it (checked against docs.expo.dev/submit/ios).
# eas.json is tracked and this repo is public, so the key id and issuer id are
# written in for the length of the upload and taken straight back out. They are
# not secrets on their own — useless without the .p8, which never leaves
# ~/hawkeye-secrets — but there is no reason to publish them either.
set -euo pipefail

source "$HOME/hawkeye-secrets/ios/asc.env"
[ -f "$EXPO_ASC_API_KEY_PATH" ] || { echo "missing $EXPO_ASC_API_KEY_PATH" >&2; exit 1; }

EASJSON="/home/elrio/hawkeye/native/eas.json"
BACKUP="$(mktemp)"
cp "$EASJSON" "$BACKUP"
restore() { cp "$BACKUP" "$EASJSON"; rm -f "$BACKUP"; echo "eas.json restored (API key fields removed)"; }
trap restore EXIT

python3 - "$EASJSON" "$EXPO_ASC_API_KEY_PATH" "$EXPO_ASC_KEY_ID" "$EXPO_ASC_ISSUER_ID" <<'PY'
import json, sys
path, keypath, keyid, issuer = sys.argv[1:5]
d = json.load(open(path))
ios = d['submit']['production']['ios']
ios['ascApiKeyPath'] = keypath
ios['ascApiKeyId'] = keyid
ios['ascApiKeyIssuerId'] = issuer
json.dump(d, open(path, 'w'), indent=2)
open(path, 'a').write('\n')
print('eas.json: API key fields added for this run')
PY

cd /home/elrio/hawkeye/native
npx eas-cli submit --platform ios --profile production --latest --non-interactive "$@"
