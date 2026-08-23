#!/usr/bin/env bash
# Is the ML Kit scanner pre-warm actually in a built AAB?
#
#   ./verify_aab_prewarm.sh <new.aab> [control.aab]
#
# GREPPING THE DEX FOR 'deferredInstall' DOES NOT WORK, and looks like proof.
# Release builds run R8 with minification on, which renames
# ModuleInstall -> B8.c, ModuleInstallClient -> B8.d,
# GmsDocumentScanning -> Ia.c, GmsDocumentScannerOptions -> Ia.b. A name search
# returns zero for a bundle that contains the code, which reads as "the rebuild
# achieved nothing" — it nearly did here.
#
# So: resolve the obfuscated names out of the build's own mapping.txt, then
# disassemble MainApplication and count references. Pass a control AAB built
# WITHOUT the plugin and the check becomes two-sided — the control must come back
# zero, or the probe is matching something unrelated.
set -uo pipefail
AAB="${1:?usage: verify_aab_prewarm.sh <aab> [control.aab]}"
CONTROL="${2:-}"
DEXDUMP=$(ls "$HOME"/android/sdk/build-tools/*/dexdump 2>/dev/null | sort -V | tail -1)
MAP="${MAPPING:-/home/elrio/hawkeye/native/android/app/build/outputs/mapping/release/mapping.txt}"

[ -x "$DEXDUMP" ] || { echo "no dexdump in the SDK build-tools"; exit 1; }
[ -f "$MAP" ]     || { echo "no mapping.txt at $MAP — set MAPPING= to the build's own"; exit 1; }

OBF=$(grep -E '^com\.google\.(android\.gms\.common\.moduleinstall|mlkit\.vision\.documentscanner)\.[A-Za-z]+ ->' "$MAP" \
      | sed 's/.*-> //; s/:$//' | tr '.' '/' | sort -u)
[ -n "$OBF" ] || { echo "mapping.txt names no module-install classes — wrong mapping for this build"; exit 1; }
PAT=$(printf 'L%s;\n' $OBF | paste -sd'|' -)

count () {
  local aab="$1" tmp hits
  tmp=$(mktemp -d)
  unzip -o -q "$aab" 'base/dex/*.dex' -d "$tmp" 2>/dev/null
  hits=0
  for d in "$tmp"/base/dex/*.dex; do
    n=$("$DEXDUMP" -d "$d" 2>/dev/null \
      | awk '/Class descriptor.*MainApplication/{f=1} f{print} f&&/^  source_file_idx/{f=0}' \
      | grep -cE "$PAT" || true)
    hits=$((hits + n))
  done
  rm -rf "$tmp"
  echo "$hits"
}

NEW_HITS=$(count "$AAB")
echo "  $(basename "$AAB"): $NEW_HITS module-install/doc-scanner references in MainApplication"

if [ -n "$CONTROL" ] && [ -f "$CONTROL" ]; then
  OLD_HITS=$(count "$CONTROL")
  echo "  $(basename "$CONTROL") [control]: $OLD_HITS"
  if [ "$OLD_HITS" -ne 0 ]; then
    echo "CONTROL FAILED: the no-prewarm build also matches — the probe is not specific"; exit 1
  fi
fi

if [ "$NEW_HITS" -gt 0 ]; then
  echo "PRE-WARM PRESENT in the shipped artefact."
  echo "Note: present is not proven working. Only a phone that reproduces the stall can say that."
  exit 0
fi
echo "PRE-WARM ABSENT — this bundle does not carry it."
exit 1
