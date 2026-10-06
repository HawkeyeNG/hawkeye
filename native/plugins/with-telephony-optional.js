const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Keep the app installable on devices without a phone radio.
 *
 * CALL_PHONE (the missed-call sign-up places its own call — lib/call-phone.ts)
 * IMPLIES <uses-feature android.hardware.telephony required="true"> to Play,
 * which would quietly drop every Wi-Fi-only tablet from the listing. Declaring
 * the feature as not required keeps them; on such a device the Call route just
 * falls back to the dialler (or is never chosen). A config plugin, because
 * `expo prebuild` regenerates AndroidManifest.xml on every build.
 */
module.exports = function withTelephonyOptional(config) {
  return withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults.manifest;
    m['uses-feature'] = (m['uses-feature'] ?? []).filter((f) => f.$?.['android:name'] !== 'android.hardware.telephony');
    m['uses-feature'].push({ $: { 'android:name': 'android.hardware.telephony', 'android:required': 'false' } });
    return cfg;
  });
};
