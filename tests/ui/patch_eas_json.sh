#!/usr/bin/env bash
#
# Two changes to native/eas.json, plus a local env file for `eas submit`.
#
#  1. production build profile gets `credentialsSource: local`, so EAS signs
#     with the certificate and profile in credentials.json instead of asking
#     Apple for new ones (which means an interactive login and 2FA).
#
#  2. the submit profile drops `appleId`. Signing in as a person needs an
#     app-specific password typed at a prompt; the App Store Connect API key
#     needs nothing typed. Its three values are NOT written into eas.json —
#     this repo is public, and while a key id and issuer id are useless without
#     the .p8, there is no reason to publish them. They live in an env file
#     outside the repo and EAS reads them from the environment.
set -euo pipefail

REPO="/home/elrio/hawkeye"
SECRETS="$HOME/hawkeye-secrets/ios"
EASJSON="$REPO/native/eas.json"

KEY_ID="8LUGC6NGP8"
ISSUER_ID="3a2516b5-8187-4c7f-b5a3-f5e261af829a"
TEAM_ID="G99KD9RW94"
ASC_APP_ID="6804218478"

python3 - "$EASJSON" "$TEAM_ID" "$ASC_APP_ID" <<'PY'
import json, sys
path, team, ascapp = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))

prod = d.setdefault('build', {}).setdefault('production', {})
prod['credentialsSource'] = 'local'

sub = d.setdefault('submit', {}).setdefault('production', {}).setdefault('ios', {})
sub.pop('appleId', None)          # replaced by the API key, read from the env
sub['ascAppId'] = ascapp
sub['appleTeamId'] = team
sub.setdefault('language', 'en-US')

json.dump(d, open(path, 'w'), indent=2)
open(path, 'a').write('\n')
print('patched', path)
PY

cat > "$SECRETS/asc.env" <<ENV
# Source this before \`eas submit\`. Outside the repo on purpose.
#   source ~/hawkeye-secrets/ios/asc.env && npx eas-cli submit -p ios --profile production
export EXPO_ASC_API_KEY_PATH="$SECRETS/AuthKey_${KEY_ID}.p8"
export EXPO_ASC_KEY_ID="$KEY_ID"
export EXPO_ASC_ISSUER_ID="$ISSUER_ID"
export EXPO_APPLE_TEAM_ID="$TEAM_ID"
ENV
chmod 600 "$SECRETS/asc.env"
echo "wrote $SECRETS/asc.env (mode 600)"

echo
echo "--- native/eas.json now ---"
cat "$EASJSON"
