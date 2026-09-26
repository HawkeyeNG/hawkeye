// Sentry's wrapper around Expo's default config: adds debug IDs so crash reports
// can be matched to source maps.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withNativeWind } = require("nativewind/metro");

const config = getSentryExpoConfig(__dirname);

module.exports = withNativeWind(config, { input: "./src/global.css" });
