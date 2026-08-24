#!/usr/bin/env bash
#
# Assemble the eight signing secrets the Capacitor iOS workflows expected, as
# FILES under ~/hawkeye-secrets/ios/github-secrets/ (mode 600).
#
# ORPHANED as of 2026-08-24: .github/workflows/ios-release.yml and ios-build.yml
# were deleted (they built Lite and signed it as the observer app, and Lite is
# Android-only for now). Nothing consumes these secrets today. Kept because a
# Lite iOS CI would need exactly this again — recover the workflows with
# `git show 6648cc2^:.github/workflows/ios-release.yml`.
#
# This is NOT the path the live iOS app uses. That is EAS on native/, which
# reads ~/hawkeye-secrets/ios/ directly and touches no GitHub secret.
#
# Nothing is printed. Every value goes to a file, and the summary shows only
# names and byte counts — a transcript is the wrong place for a signing key,
# and a value echoed once is a value that lives in scrollback forever.
#
# Inputs: the distribution certificate and profile downloaded from Apple, plus
# the private key that generated the CSR (which never left this machine — that
# is the whole point of a CSR, and without it the .cer signs nothing).
set -euo pipefail

DL="${DL:-/mnt/c/Users/HP/Downloads}"
SECRETS="$HOME/hawkeye-secrets/ios"
OUT="$SECRETS/github-secrets"

CER="$DL/distribution.cer"
PROFILE="$DL/Hawkeye_App_Store.mobileprovision"
P8_SRC="$DL/AuthKey_8LUGC6NGP8.p8"
KEY="$SECRETS/ios_distribution.key"

KEY_ID="8LUGC6NGP8"
ISSUER_ID="3a2516b5-8187-4c7f-b5a3-f5e261af829a"
TEAM_ID="G99KD9RW94"

for f in "$CER" "$PROFILE" "$P8_SRC" "$KEY"; do
  [ -f "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
done

mkdir -p "$OUT"
chmod 700 "$SECRETS" "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- the certificate is DER from Apple; PKCS#12 export wants PEM -------------
openssl x509 -inform DER -in "$CER" -out "$WORK/dist.pem"

# --- refuse to build a .p12 whose key does not match its certificate ---------
# A mismatch produces a file that imports cleanly and then fails to sign, 20
# minutes into a macOS runner. Compare the public keys instead.
openssl x509 -in "$WORK/dist.pem" -noout -pubkey > "$WORK/from-cert.pub"
openssl pkey -in "$KEY" -pubout > "$WORK/from-key.pub" 2>/dev/null
if ! cmp -s "$WORK/from-cert.pub" "$WORK/from-key.pub"; then
  echo "ERROR: $KEY is not the private key for $CER" >&2
  echo "       The .p12 would import and then fail to codesign." >&2
  exit 1
fi
echo "key/cert pair verified"

# --- passwords: generated here, never reused from anything else --------------
P12_PASSWORD="$(openssl rand -base64 24)"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"

# -legacy: macOS `security import` cannot read the AES-256 PKCS#12 that
# OpenSSL 3 writes by default, and fails with a bare "MAC verification failed"
# that looks exactly like a wrong password.
openssl pkcs12 -export -legacy \
  -inkey "$KEY" -in "$WORK/dist.pem" \
  -name "Apple Distribution: IniXien, LLC" \
  -out "$WORK/dist.p12" -passout "pass:$P12_PASSWORD" 2>/dev/null \
  || openssl pkcs12 -export \
       -inkey "$KEY" -in "$WORK/dist.pem" \
       -name "Apple Distribution: IniXien, LLC" \
       -out "$WORK/dist.p12" -passout "pass:$P12_PASSWORD"

# Prove it round-trips before it is ever uploaded.
openssl pkcs12 -in "$WORK/dist.p12" -passin "pass:$P12_PASSWORD" -nokeys -legacy -noout 2>/dev/null \
  || openssl pkcs12 -in "$WORK/dist.p12" -passin "pass:$P12_PASSWORD" -nokeys -noout
echo ".p12 exported and re-opened cleanly"

# Keep the .p12 and a copy of the .p8 with the other signing material, out of
# Downloads — Apple hands the .p8 over exactly once.
install -m 600 "$WORK/dist.p12" "$SECRETS/dist.p12"
install -m 600 "$P8_SRC" "$SECRETS/AuthKey_${KEY_ID}.p8"

write() { printf '%s' "$2" > "$OUT/$1"; chmod 600 "$OUT/$1"; }

write BUILD_CERTIFICATE_BASE64    "$(base64 -w0 "$WORK/dist.p12")"
write P12_PASSWORD                "$P12_PASSWORD"
write PROVISIONING_PROFILE_BASE64 "$(base64 -w0 "$PROFILE")"
write KEYCHAIN_PASSWORD           "$KEYCHAIN_PASSWORD"
write APPSTORE_KEY_ID             "$KEY_ID"
write APPSTORE_ISSUER_ID          "$ISSUER_ID"
write APPLE_TEAM_ID               "$TEAM_ID"
# The .p8 is used verbatim, newlines and BEGIN/END lines intact.
install -m 600 "$P8_SRC" "$OUT/APPSTORE_PRIVATE_KEY"

echo
echo "wrote to $OUT (names and sizes only):"
for f in "$OUT"/*; do
  printf '  %-30s %6s bytes\n' "$(basename "$f")" "$(stat -c %s "$f")"
done
