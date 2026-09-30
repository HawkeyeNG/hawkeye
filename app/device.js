/* Device fingerprint (anti-sybil). SHA-256 of a persistent random seed +
 * stable hardware/browser signals. Two SIMs (= two observer accounts) on one
 * phone share one fingerprint; two identical phone models do NOT collide
 * (random seed). Sent as the x-device-id header on every API call.
 * Defence-in-depth, not perfection: clearing site data resets the seed.
 */
window.getDeviceId = (() => {
  let cached = null;
  return async function getDeviceId() {
    if (cached) return cached;
    let seed = localStorage.getItem('hk_device_seed');
    if (!seed) {
      seed = crypto.randomUUID();
      localStorage.setItem('hk_device_seed', seed);
    }
    let gpu = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch { /* signal optional */ }
    const sig = [
      seed, navigator.userAgent, navigator.platform, navigator.hardwareConcurrency,
      navigator.deviceMemory, screen.width, screen.height, window.devicePixelRatio,
      Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.maxTouchPoints, gpu,
    ].join('|');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
    cached = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return cached;
  };
})();

/* Device signals (backend services/clusters.js: count DEVICES, not accounts).
 * Sent with a result report and a docket verdict as the `signals` field —
 * outside the signed payload, so nothing evidentiary changes.
 *
 *   app      'lite' inside Hawkeye Lite, 'web' in a browser.
 *   shared   iOS Lite only: a random id Lite and the native app both read from
 *            one keychain access group (same Apple team), so one iPhone running
 *            both apps is one device. The server keeps a keyed hash of it.
 *   sibling  Android Lite only: whether the native Hawkeye app is installed on
 *            this phone — a yes/no, nothing about that app's account.
 *
 * Both come from the HawkeyeDevice native plugin, which exists only in Lite
 * store builds from 1.7 on. FEATURE-DETECTED: an older binary running this
 * bundle has no plugin, and a browser has no Capacitor, so they send
 * { app } alone and everything else behaves exactly as before. Never throws.
 */
window.getDeviceSignals = (() => {
  let cached = null;
  return function getDeviceSignals() {
    if (cached) return cached;
    cached = (async () => {
      const out = { app: window.HAWKEYE && window.HAWKEYE.native ? 'lite' : 'web' };
      try {
        const P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.HawkeyeDevice;
        if (P && typeof P.signals === 'function') {
          const r = await P.signals();
          if (r && /^[0-9a-f]{64}$/.test(String(r.shared || ''))) out.shared = String(r.shared);
          if (r && typeof r.sibling === 'boolean') out.sibling = r.sibling;
        }
      } catch { /* a signal not sent */ }
      return out;
    })();
    return cached;
  };
})();
