import { requireOptionalNativeModule } from 'expo-modules-core';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

/**
 * THE MISSED-CALL SIGN-UP PLACES ITS OWN CALL (Android).
 *
 * Without CALL_PHONE a tel: link only opens the dialler with our number typed
 * in, and the observer still has to press the green button. With it, "Call now"
 * dials straight away. The permission is asked the moment Call is CHOSEN
 * (sign-in.tsx), so the system prompt arrives when the reason for it is on
 * screen — no pre-prompt of our own (owner, 2026-10-06).
 *
 * OPTIONAL BY CONSTRUCTION. ExpoIntentLauncher and the CALL_PHONE manifest entry
 * exist only in binaries built from 2026-10-06 on; this file also ships by OTA
 * to older ones. There the module is absent, nothing is asked (asking for a
 * permission the manifest lacks would be denied silently), and "Call now" opens
 * the dialler exactly as before. Denied, or any failure, does the same.
 * iOS always uses tel: — Apple shows its own call confirmation either way.
 */
type Launcher = { startActivity(action: string, params: { data?: string }): Promise<unknown> };
const launcher = Platform.OS === 'android' ? requireOptionalNativeModule<Launcher>('ExpoIntentLauncher') : null;

let asked = false;

/** Called when the observer picks Call. Asks once per app session, and only where it can be used. */
export async function askCallPermission(): Promise<void> {
  if (!launcher || asked) return;
  asked = true;
  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CALL_PHONE);
  } catch {
    /* an unanswerable prompt is a "no": the dialler still works */
  }
}

/** "Call now": dial directly when allowed, otherwise hand the number to the dialler. */
export async function placeCall(tel: string): Promise<void> {
  if (!/^tel:\+?\d{6,15}$/.test(tel)) return;
  if (launcher) {
    try {
      if (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CALL_PHONE)) {
        // Not awaited: the launcher resolves only when the call screen closes.
        launcher.startActivity('android.intent.action.CALL', { data: tel }).catch(() => {});
        return;
      }
    } catch {
      /* fall through to the dialler */
    }
  }
  await Linking.openURL(tel).catch(() => {});
}
