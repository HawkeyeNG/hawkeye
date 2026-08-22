#!/usr/bin/env bash
#
# Point EAS Build at the signing material we already hold, so an iOS build
# needs no interactive Apple login and no 2FA prompt.
#
# EAS defaults to REMOTE credentials: it signs you into Apple, generates a
# certificate and profile itself, and stores them on Expo's servers. We already
# have a verified Apple Distribution certificate and an App Store profile for
# ng.com.hawkeye.observer, so local credentials are both fewer moving parts and
# fewer secrets in a third party's hands.
#
# credentials.json has to carry the .p12 password in clear text — that is the
# format EAS defines — so this script refuses to write it until .gitignore
# covers it. The repo is public.
set -euo pipefail

REPO="/home/elrio/hawkeye"
NATIVE="$REPO/native"
SECRETS="$HOME/hawkeye-secrets/ios"
DL="${DL:-/mnt/c/Users/HP/Downloads}"

# Keep the profile beside the rest of the signing material rather than in
# Downloads, which is not a place for it.
install -m 600 "$DL/Hawkeye_App_Store.mobileprovision" "$SECRETS/Hawkeye_App_Store.mobileprovision"

for f in "$SECRETS/dist.p12" "$SECRETS/Hawkeye_App_Store.mobileprovision" "$SECRETS/github-secrets/P12_PASSWORD"; do
  [ -f "$f" ] || { echo "MISSING: $f  (run build_ios_secrets.sh first)" >&2; exit 1; }
done

# --- .gitignore FIRST, before anything sensitive is written into the repo ----
GI="$REPO/.gitignore"
add_ignore() {
  grep -qxF "$1" "$GI" || printf '%s\n' "$1" >> "$GI"
}
if ! grep -q "iOS signing material" "$GI"; then
  cat >> "$GI" <<'IGN'

# iOS signing material. credentials.json holds the .p12 password in clear text
# (EAS defines the format), and this repo is public.
IGN
fi
add_ignore 'credentials.json'
add_ignore 'native/credentials.json'
add_ignore '*.p12'
add_ignore '*.mobileprovision'
add_ignore '*.p8'
add_ignore '*.certSigningRequest'

cd "$REPO"
git check-ignore -q native/credentials.json || {
  echo "REFUSING: .gitignore still does not cover native/credentials.json" >&2
  exit 1
}
echo ".gitignore covers credentials.json, .p12, .mobileprovision, .p8"

# --- credentials.json --------------------------------------------------------
# The password is read from its file and never echoed. python writes the JSON so
# a password containing quotes or backslashes cannot break the file.
P12_PASSWORD_FILE="$SECRETS/github-secrets/P12_PASSWORD" \
P12_PATH="$SECRETS/dist.p12" \
PROFILE_PATH="$SECRETS/Hawkeye_App_Store.mobileprovision" \
OUT="$NATIVE/credentials.json" \
python3 - <<'PY'
import json, os
pw = open(os.environ['P12_PASSWORD_FILE']).read()
doc = {
    "ios": {
        "provisioningProfilePath": os.environ['PROFILE_PATH'],
        "distributionCertificate": {
            "path": os.environ['P12_PATH'],
            "password": pw,
        },
    }
}
out = os.environ['OUT']
with open(out, 'w') as f:
    json.dump(doc, f, indent=2)
    f.write('\n')
os.chmod(out, 0o600)
print('wrote', out, '(mode 600, password not shown)')
PY

echo
echo "credentials.json keys:"
python3 -c "import json;d=json.load(open('$NATIVE/credentials.json'));print(' profile :',d['ios']['provisioningProfilePath']);print(' p12     :',d['ios']['distributionCertificate']['path']);print(' password:', '<'+str(len(d['ios']['distributionCertificate']['password']))+' chars, not shown>')"
