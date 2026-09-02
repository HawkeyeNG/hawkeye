#!/bin/bash
# Do our patches/ apply to what npm ACTUALLY installs, using the tool that
# actually applies them?
#
# WHY THIS EXISTS. The first ML Kit patch was generated against a hand-rebuilt
# "original" (the registry was unreachable), verified by restoring that same
# reconstruction, and passed — then failed EAS Build at "Install dependencies".
# The real file orders its @import lines Chinese/Japanese/Korean/Devanagari and
# the reconstruction assumed Chinese/Devanagari/Japanese/Korean. A patch checked
# against the tree it was derived from proves nothing.
#
# AND IT MUST BE patch-package, NOT `git apply`. patch-package applies with its
# own fuzz tolerance, so git apply reports failures on patches that are fine in
# practice — react-native-document-scanner-plugin's is one, and a check that
# cries wolf gets ignored, which is worse than no check.
#
#   cd native && bash scripts/verify_patches.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
NATIVE=$PWD
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Install exactly the packages we patch, at the versions the patch names, with
# no scripts — then run patch-package over them, as postinstall does on the
# builder.
pkgs=()
for patch in patches/*.patch; do
  base=$(basename "$patch" .patch)
  ver=${base##*+}
  pkg=${base%+*}
  pkg=${pkg/+//}
  pkgs+=("$pkg@$ver")
done
echo "packages under patch: ${pkgs[*]}"

mkdir -p "$TMP/t"
cd "$TMP/t" || exit 1
npm init -y >/dev/null 2>&1
if ! npm install --ignore-scripts --no-audit --no-fund "${pkgs[@]}" >/dev/null 2>&1; then
  echo "could not install from the registry — cannot verify, not declaring success"
  exit 2
fi
cp -r "$NATIVE/patches" .
npm install --ignore-scripts --no-audit --no-fund patch-package >/dev/null 2>&1

echo
echo "== applying with patch-package (what the builder runs)"
out=$(npx patch-package 2>&1)
echo "$out" | sed 's/^/   /'
fail=0
echo "$out" | grep -qiE '(^|[^a-z])error|failed to apply|patch.*did not apply' && fail=1

# CONTROL: a corrupted patch must be REJECTED. Without this the run above could
# be reporting success while applying nothing at all.
echo
echo "== control (a corrupted patch must be rejected)"
sed 's/@import MLKitTextRecognitionCommon;/@import NoSuchModuleAtAll;/' \
  "patches/@react-native-ml-kit+text-recognition+2.0.0.patch" > patches/tmp_control.patch.bak
mv patches/tmp_control.patch.bak "patches/@react-native-ml-kit+text-recognition+2.0.0.patch"
rm -rf node_modules/@react-native-ml-kit
npm install --ignore-scripts --no-audit --no-fund '@react-native-ml-kit/text-recognition@2.0.0' >/dev/null 2>&1
if npx patch-package 2>&1 | grep -qiE 'error|failed'; then
  echo "   corrupted patch correctly rejected"
else
  echo "   CONTROL FAILED — a corrupted patch was accepted, so this check proves nothing"
  fail=1
fi

echo
if [ "$fail" = 0 ]; then echo "RESULT: patches apply to a clean registry install"; else echo "RESULT: PROBLEM — see above"; fi
exit $fail
