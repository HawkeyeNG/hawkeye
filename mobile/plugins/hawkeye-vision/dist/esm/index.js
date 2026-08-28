import { registerPlugin } from '@capacitor/core';
// app/native.js reaches for Capacitor.Plugins.HawkeyeVision directly, so this
// entry exists for completeness and for anything that prefers to import it.
const HawkeyeVision = registerPlugin('HawkeyeVision');
export { HawkeyeVision };
