/**
 * Dynamic Expo config. app.json stays the static source of truth — this file
 * exists only to supply what must not live in git history, and to keep the dev
 * client and the release build from colliding.
 *
 * Two things vary together and must never drift apart: the Android package name
 * and the Google Maps key. A Maps SDK for Android key is bound in Cloud console
 * to a (package name, signing SHA-1) pair, so the dev client and the release
 * build need different keys — pairing them here means one variable decides both
 * and they cannot be mismatched by hand.
 *
 * Default is the DEV variant, matching what app.json already declares, so the
 * everyday build is unchanged. Production is opt-in:
 *
 *   APP_VARIANT=production npx expo prebuild --clean
 *
 * The key ends up in AndroidManifest as com.google.android.geo.API_KEY, which
 * is public-by-design inside an APK — the package + SHA-1 restriction is the
 * real protection. Committing it to the repo would outlive any later change to
 * that restriction, which is the only reason it lives in .env.local.
 */
const PROD_PACKAGE = 'ng.com.hawkeye.observer';

module.exports = ({ config }) => {
  const production = process.env.APP_VARIANT === 'production';
  const apiKey =
    (production ? process.env.GOOGLE_MAPS_API_KEY_PROD : process.env.GOOGLE_MAPS_API_KEY_DEV) ?? '';

  // A missing key does not fail the build — it produces a blank grey map at
  // runtime, which is a miserable thing to diagnose on a phone. Say so now.
  if (!apiKey) {
    console.warn(
      `[hawkeye] No Maps key for the ${production ? 'production' : 'dev'} variant — ` +
        'set GOOGLE_MAPS_API_KEY_' +
        (production ? 'PROD' : 'DEV') +
        ' in native/.env.local, or the map will render blank.',
    );
  }

  return {
    ...config,
    android: {
      ...config.android,
      // Dev keeps whatever app.json declares (…​.observer.dev).
      package: production ? PROD_PACKAGE : config.android?.package,
      config: { ...config.android?.config, googleMaps: { apiKey } },
      // FCM. ONE file covers BOTH variants: Firebase emits a google-services.json
      // listing every Android app in the project, and gradle picks the client
      // whose package_name matches the applicationId being built. So unlike the
      // Maps key this does not vary, and it is committed — it is public-by-design
      // (extractable from any APK) and a gitignored copy would just break clean
      // clones. The service-account PRIVATE key is the secret, and it lives only
      // in the server's environment, never here.
      googleServicesFile: './google-services.json',
    },
  };
};
