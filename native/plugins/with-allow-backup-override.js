const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Let our `android:allowBackup="false"` win the manifest merge.
 *
 * react-native-compressor pulls in TAndroidLame (a LAME MP3 encoder), whose own
 * manifest declares `allowBackup="true"`. The Android manifest merger refuses to
 * reconcile the two values and fails :app:processDebugMainManifest with
 *   "add tools:replace=\"android:allowBackup\" to <application>".
 * We deliberately keep backup OFF — an observer's device holds their signing key
 * and unsent reports, and allowing Android auto-backup would copy those off the
 * device — so we override rather than concede the library's `true`.
 *
 * This has to be a config plugin, not a hand-edit: `expo prebuild` regenerates
 * AndroidManifest.xml every build, so a manual `tools:replace` would be wiped.
 * `xmlns:tools` is already declared on the manifest root by the Expo template,
 * so only the attribute is added here.
 */
module.exports = function withAllowBackupOverride(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) return cfg;
    app.$ = app.$ ?? {};
    app.$['android:allowBackup'] = 'false';
    const existing = app.$['tools:replace'];
    const parts = existing ? existing.split(',').map((s) => s.trim()) : [];
    if (!parts.includes('android:allowBackup')) parts.push('android:allowBackup');
    app.$['tools:replace'] = parts.join(',');
    return cfg;
  });
};
