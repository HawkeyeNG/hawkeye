/**
 * React Native autolinking overrides.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `@react-native-ml-kit/text-recognition` is an ANDROID-ONLY dependency of
 * this app, but nothing told the iOS build that.
 *
 * lib/ocr.ts reads the EC8A sheet with Apple Vision on iOS, through the local
 * modules/hawkeye-vision module, and only falls back to ML Kit elsewhere:
 *
 *     if (Platform.OS !== 'ios') {
 *       const mod = require('@react-native-ml-kit/text-recognition');
 *     }
 *
 * The switch to Vision was made precisely because the ML Kit pod is heavy —
 * its podspec depends on `GoogleMLKit/TextRecognition`, which carries five
 * recognition models (Latin, Chinese, Devanagari, Japanese, Korean). But the
 * JAVASCRIPT moved to Vision while the POD stayed: autolinking installs a
 * package's podspec because the package is in package.json, not because any
 * iOS code path uses it. So every IPA since has shipped tens of megabytes of
 * OCR models that no iOS user can reach.
 *
 * `platforms: { ios: null }` removes it from iOS autolinking only. Android
 * still links it, which is where the OCR actually runs.
 *
 * ── WHY HERE AND NOT IN THE PODFILE ───────────────────────────────────────
 *
 * `expo prebuild --clean` regenerates ios/ and android/ on every build, so a
 * hand-edited Podfile is deleted before it is ever used. The generated Podfile
 * calls `use_native_modules!`, which reads THIS file — so the exclusion
 * survives, the same reason app.json carries the build properties.
 *
 * If iOS ever needs ML Kit text recognition, delete this entry; nothing else
 * depends on it.
 */
module.exports = {
  dependencies: {
    '@react-native-ml-kit/text-recognition': {
      platforms: { ios: null },
    },
  },
};
