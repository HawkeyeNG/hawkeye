#!/usr/bin/env bash
# Forward APNs registration callbacks to Capacitor's NotificationCenter events.
#
# WHY THIS EXISTS — the root cause of iOS Lite builds 2-6 receiving no push.
#
# `cap add ios` regenerates ios/ from the CLI's template every CI run, and that
# template's AppDelegate has NO push forwarding: iOS registers with APNs, hands
# the app its device token via didRegisterForRemoteNotificationsWithDeviceToken,
# and the default no-op drops it on the floor. Capacitor plugins do not hook the
# app delegate themselves — BOTH plugins wait on the NotificationCenter event
# this patch posts:
#
#   @capacitor/push-notifications  PushNotificationsPlugin.swift:41 observes
#     .capacitorDidRegisterForRemoteNotifications (its 'registration' JS event)
#   @capacitor-firebase/messaging  FirebaseMessagingPlugin.swift:44 observes the
#     same event (the ONLY place it learns the APNs token getToken() needs)
#
# So without this, the JS 'registration' listener never fires, no FCM token is
# ever exchanged, nothing registers with the server, and NO error surfaces
# anywhere — the permission grant succeeds and then the chain just ends. The
# build-6 wake-up fix in app/native.js was correct but sits one link downstream
# of this break, so it never got the chance to run.
#
# Capacitor documents these methods as a REQUIRED manual step for push - a step
# a committed iOS project gets once and keeps, and a CI-generated one loses
# every single run. Hence a script, not a one-off edit.
#
# Idempotent: skips if the marker is already present. Verifies afterwards and
# fails LOUDLY, because the failure it guards is perfectly silent.
set -euo pipefail

APPDELEGATE="${1:-ios/App/App/AppDelegate.swift}"

if [ ! -f "$APPDELEGATE" ]; then
  echo "::error::$APPDELEGATE not found — run after 'cap add ios'"
  exit 1
fi

MARKER="capacitorDidRegisterForRemoteNotifications"
if grep -q "$MARKER" "$APPDELEGATE"; then
  echo "  ok: AppDelegate already forwards APNs registration"
  exit 0
fi

# Insert before the class's closing brace (the file's final '}').
# The template ends: ...last method... \n} — python keeps this robust against
# whitespace variations that would make a sed address fragile.
python3 - "$APPDELEGATE" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
methods = '''
    // APNs -> Capacitor. Added by mobile/scripts/patch_ios_appdelegate.sh —
    // the template omits these and BOTH push plugins depend on them; without
    // this forwarding the device token is dropped and push dies silently.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // The third method @capacitor-firebase/messaging's README mandates
    // (lines 138-140). NOT needed for token registration, alerts or badges —
    // added because without it a background/data-only message never reaches
    // FirebaseMessagingPlugin, which observes this exact notification name. A
    // gap that would only surface the day someone builds on data messages, by
    // which time nobody would connect it to push setup.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(name: Notification.Name("didReceiveRemoteNotification"), object: completionHandler, userInfo: userInfo)
    }
'''
i = src.rstrip().rfind('}')
if i < 0:
    sys.exit('AppDelegate has no closing brace — template changed, patch by hand')
open(path, 'w').write(src[:i] + methods + '\n' + src[i:])
PY

# VERIFY, loudly. A patch that silently failed would reproduce the exact bug it
# exists to prevent, with a green build.
ok=1
grep -q "didRegisterForRemoteNotificationsWithDeviceToken" "$APPDELEGATE" || ok=0
grep -q "capacitorDidRegisterForRemoteNotifications" "$APPDELEGATE" || ok=0
grep -q "capacitorDidFailToRegisterForRemoteNotifications" "$APPDELEGATE" || ok=0
grep -q "didReceiveRemoteNotification" "$APPDELEGATE" || ok=0
if [ "$ok" != 1 ]; then
  echo "::error::AppDelegate patch did not take — push registration would be silently dead"
  exit 1
fi
echo "  ok: AppDelegate now forwards APNs registration + failure to Capacitor"
