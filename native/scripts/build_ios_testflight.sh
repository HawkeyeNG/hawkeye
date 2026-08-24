#!/usr/bin/env bash
# Build the iOS app on EAS and (optionally) send it to TestFlight.
#
# NO MAC REQUIRED. EAS compiles on Expo's macOS machines and hands back a signed
# .ipa; this host only orchestrates. That is the whole reason iOS is reachable
# from a Windows/WSL workstation at all.
#
#   scripts/build_ios_testflight.sh              build only
#   scripts/build_ios_testflight.sh --submit     build, then upload to TestFlight
#
# Everything Apple-side needs an active Apple Developer Program membership
# ($99/yr). Without it, EAS cannot create the distribution certificate or the
# provisioning profile and the build stops at the credentials step.
set -uo pipefail
cd "$(dirname "$0")/.."

SUBMIT=0
[ "${1:-}" = "--submit" ] && SUBMIT=1

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

step "Preflight"
WHO=$(npx eas whoami 2>/dev/null | grep -viE 'eas-cli@|upgrade|npm install|Proceeding|Deprecation|trace-deprecation' | head -1 | tr -d ' ')
[ -n "$WHO" ] || die "not logged into EAS — run: npx eas login"
note "eas account : $WHO"

BUNDLE=$(node -p "require('./app.json').expo.ios.bundleIdentifier")
VER=$(node -p "require('./app.json').expo.version")
BUILDNO=$(node -p "require('./app.json').expo.ios.buildNumber ?? '(auto)'")
note "bundle id   : $BUNDLE"
note "version     : $VER (buildNumber $BUILDNO)"
[ "$BUNDLE" = "ng.com.hawkeye.observer" ] || die "unexpected bundle identifier"

# eas.json's production profile sets autoIncrement, so buildNumber climbs on its
# own — App Store Connect rejects a repeat, and hand-editing it is how that gets
# forgotten.
node -p "require('./eas.json').build.production.autoIncrement === true ? '' : (()=>{throw 0})()" >/dev/null 2>&1 \
  || die "eas.json production.autoIncrement is not true — buildNumber would collide"
note "autoIncrement: on"

# The four Info.plist strings Apple rejects a build for omitting.
for k in NSCameraUsageDescription NSMicrophoneUsageDescription \
         NSLocationWhenInUseUsageDescription NSPhotoLibraryUsageDescription; do
  node -p "require('./app.json').expo.ios.infoPlist['$k'] ? '' : (()=>{throw 0})()" >/dev/null 2>&1 \
    || die "app.json is missing ios.infoPlist.$k — App Review rejects that"
done
note "usage strings: all four present"
node -p "require('./app.json').expo.ios.infoPlist.ITSAppUsesNonExemptEncryption === false ? '' : (()=>{throw 0})()" >/dev/null 2>&1 \
  && note "encryption   : declared exempt (saves a review round-trip)" \
  || note "encryption   : NOT declared — every upload will ask"

# FIREBASE MUST NOT RESOLVE THROUGH SPM HERE, and the failure is remote.
#
# @react-native-firebase v26 defaults to Swift Package Manager for the Firebase
# iOS SDK. firebase-ios-sdk's SPM products are automatic libraries, so each
# react-native-firebase pod embeds its own copy — and this project links
# statically ("Framework build type is static library"), where those copies
# collide as duplicate symbols. pod install refuses outright:
#
#   [!] [react-native-firebase] SPM + static linkage is not supported
#
# That cost a full build cycle to discover, because pod install runs on Expo's
# machines. `ios.disableSPM` on the app plugin puts Firebase back on CocoaPods,
# which static linkage handles. The alternative the log suggests — dynamic
# frameworks — is a far larger change and would touch every other pod.
node -p "require('./app.json').expo.plugins.some(p => Array.isArray(p) && p[0] === '@react-native-firebase/app' && p[1]?.ios?.disableSPM === true) ? '' : (()=>{throw 0})()" >/dev/null 2>&1 \
  || die "app.json: @react-native-firebase/app needs { ios: { disableSPM: true } } — SPM + static linkage fails at pod install"
note "firebase     : SPM disabled (CocoaPods), required for static linkage"

# aps-environment decides which APNs environment the device token comes from,
# and a TestFlight build on the sandbox one takes push that never arrives.
APS=$(APP_VARIANT=production npx expo config --type introspect --json 2>/dev/null \
  | sed -n '/^{/,$p' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).ios.entitlements['aps-environment'])}catch(e){console.log('unset')}})")
[ "$APS" = "production" ] || die "aps-environment is '$APS' for the production variant — TestFlight would get a sandbox push token"
note "aps-env      : production"

step "Project link"
LINKED=$(node -p "require('./app.json').expo.extra?.eas?.projectId ?? ''" 2>/dev/null)
if [ -z "$LINKED" ]; then
  note "not linked to an EAS project yet — creating one under $WHO"
  npx eas init --non-interactive || die "eas init failed"
  LINKED=$(node -p "require('./app.json').expo.extra?.eas?.projectId ?? ''")
fi
note "project id  : $LINKED"

step "Build (runs on Expo's macOS machines — minutes to hours, queue depending)"
# --profile production: the profile eas.json already points at TestFlight.
# Credentials are managed by EAS: on the first run it will offer to create the
# distribution certificate, the provisioning profile and the APNs key, which
# needs your Apple login. That prompt is interactive by design — it is asking
# for someone else's account, so it is not something this script should carry.
npx eas build --platform ios --profile production
RC=$?
[ $RC -eq 0 ] || die "eas build exited $RC"

if [ "$SUBMIT" = "1" ]; then
  step "Submit to TestFlight"
  npx eas submit --platform ios --profile production --latest
fi

cat <<'DONE'

TestFlight, once the build lands:
  1. App Store Connect -> your app -> TestFlight. Processing takes ~10-30 min.
  2. INTERNAL testing: up to 100 testers, NO review, usable immediately. This is
     the one for your own phone.
  3. EXTERNAL testing: up to 10,000, needs a Beta App Review (lighter than App
     Store review, usually about a day).

PUSH — FIXED as of 2026-08-24, and this build is the one that delivers it.
  The app is registered in Firebase, @react-native-firebase/messaging hands back
  an FCM token on iOS, the server selects 'ios', and aps-environment is set to
  production for this profile so TestFlight gets a production APNs token rather
  than a sandbox one. A phone only becomes reachable once it RE-REGISTERS from a
  build containing all of that — every earlier iOS install holds a raw APNs
  token the server declines by shape, and the admin console counts those
  separately so they are not mistaken for a broken key.

Known iOS gaps, which do not block testing:
  - MAPS. No iOS Google Maps key is set, deliberately: react-native-maps falls
    back to Apple Maps, which needs no key and is good at exactly the thing this
    app uses it for. Worth eyeballing the map screens before deciding to keep it.
DONE
