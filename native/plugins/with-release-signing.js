/**
 * Sign release builds with the UPLOAD key — but only when it is actually there.
 *
 * Expo's template signs release with the DEBUG keystore, which is deliberate for
 * the team APK: that build carries the `.dev` package the dev Maps key is bound
 * to, and re-signing it would break the map for everyone testing. So this cannot
 * simply hard-swap the config — a Play build needs the upload key and a team
 * build must keep the debug one, from the same checked-out tree.
 *
 * A CONFIG PLUGIN RATHER THAN A HAND EDIT, because `expo prebuild --clean`
 * regenerates android/ from scratch and would silently drop a patched
 * build.gradle. A hand-edited signing block survives exactly until the next
 * prebuild, and the failure mode is a release quietly signed with the debug key
 * — which Play rejects at best and, if it ever got through, would be
 * unrecoverable (the upload key cannot be changed retroactively without
 * Google's help).
 *
 * Gradle picks the key at build time from properties, so no secret is ever in
 * this file, in app.json, or in the repository:
 *
 *   HAWKEYE_UPLOAD_STORE_FILE   absolute path to the .keystore
 *   HAWKEYE_UPLOAD_STORE_PASSWORD
 *   HAWKEYE_UPLOAD_KEY_ALIAS
 *   HAWKEYE_UPLOAD_KEY_PASSWORD
 *
 * scripts/build_play_aab.sh reads those from ~/hawkeye-secrets and passes them
 * in. With none set, release falls back to debug and the team APK is unchanged.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

const SIGNING_CONFIG = `
        // Injected by plugins/with-release-signing.js — see that file for why
        // this is a plugin and not an edit to this generated file.
        upload {
            if (project.hasProperty('HAWKEYE_UPLOAD_STORE_FILE')) {
                storeFile file(HAWKEYE_UPLOAD_STORE_FILE)
                storePassword HAWKEYE_UPLOAD_STORE_PASSWORD
                keyAlias HAWKEYE_UPLOAD_KEY_ALIAS
                keyPassword HAWKEYE_UPLOAD_KEY_PASSWORD
            }
        }`;

/** release { signingConfig ... } chosen at configuration time. */
const RELEASE_PICK = `
            // The upload key when it is supplied, the debug key otherwise. The
            // team APK builds with no properties set and keeps its .dev signing;
            // a Play build supplies them and gets the upload key.
            signingConfig project.hasProperty('HAWKEYE_UPLOAD_STORE_FILE') ? signingConfigs.upload : signingConfigs.debug`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;

    // Idempotent: prebuild can run many times, and a second copy of the block
    // would be a gradle syntax error rather than a no-op.
    if (!src.includes('HAWKEYE_UPLOAD_STORE_FILE')) {
      const anchor = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;
      if (!src.includes(anchor)) {
        throw new Error(
          '[with-release-signing] the debug signingConfig block was not found in ' +
          'app/build.gradle. Expo changed the template — update this plugin rather ' +
          'than letting a release build fall back to debug signing unnoticed.',
        );
      }
      src = src.replace(anchor, anchor + SIGNING_CONFIG);

      const relAnchor = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;
      if (!src.includes(relAnchor)) {
        throw new Error(
          '[with-release-signing] the release buildType did not look as expected. ' +
          'Refusing to guess: an unsigned or debug-signed AAB is worse than a failed build.',
        );
      }
      src = src.replace(relAnchor, RELEASE_PICK);
    }

    cfg.modResults.contents = src;
    return cfg;
  });
};
