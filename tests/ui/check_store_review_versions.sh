#!/usr/bin/env bash
# Which expo-store-review 57.x releases compile against the expo-modules-core
# this project actually has? SceneGeometry was added to ExpoModulesCore after
# 57.0.7, so any release calling it will not build here.
set -euo pipefail
WORK="$(mktemp -d)"
cd "$WORK"
for v in 57.0.0 57.0.1 57.0.2; do
  npm pack "expo-store-review@$v" >/dev/null 2>&1
  tgz="$(ls expo-store-review-$v.tgz 2>/dev/null || true)"
  if [ -z "$tgz" ]; then echo "$v  <could not fetch>"; continue; fi
  rm -rf pkg && mkdir pkg && tar xzf "$tgz" -C pkg
  if grep -rq "SceneGeometry" pkg/package/ios/ 2>/dev/null; then
    echo "$v  uses SceneGeometry   -> will NOT build"
  else
    echo "$v  clean                -> builds against expo-modules-core 57.0.7"
    echo "     ios sources: $(ls pkg/package/ios/ | tr '\n' ' ')"
  fi
done
rm -rf "$WORK"
