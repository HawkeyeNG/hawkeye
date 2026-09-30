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

/* Device signals (backend services/clusters.js: count DEVICES, not accounts;
 * services/deviceClaims.js: one phone, one counting account per election).
 * Sent with a result report and a docket verdict as the `signals` field —
 * outside the signed payload, so nothing evidentiary changes.
 *
 *   app        'lite' inside Hawkeye Lite, 'web' in a browser.
 *   shared     iOS Lite only: a random id Lite and the native app both read from
 *              one keychain access group (same Apple team), so one iPhone running
 *              both apps is one device. The server keeps a keyed hash of it.
 *   sibling    Android Lite only: whether the native Hawkeye app is installed on
 *              this phone — a yes/no, nothing about that app's account.
 *   androidId  Android Lite only: Settings.Secure.ANDROID_ID — one value per
 *              (Lite's signing key, user, phone), unchanged by a reinstall. The
 *              server keeps a peppered hash of it.
 *   dc         iOS Lite only, and only when asked for ({ deviceCheck: true }, a
 *              result report): a FRESH Apple DeviceCheck token. Not an id — each
 *              is new — and the server only passes it to Apple.
 *
 * All from the HawkeyeDevice native plugin, which exists only in Lite store
 * builds (shared/sibling from 1.7; androidId/dc from the build after). FEATURE-
 * DETECTED: an older binary running this bundle has no plugin, or no
 * deviceCheck method, and a browser has no Capacitor — they send what they
 * have and everything else behaves exactly as before. Never throws.
 */
window.getDeviceSignals = (() => {
  let cached = null;
  const plugin = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.HawkeyeDevice;
  const base = () => {
    if (cached) return cached;
    cached = (async () => {
      const out = { app: window.HAWKEYE && window.HAWKEYE.native ? 'lite' : 'web' };
      try {
        const P = plugin();
        if (P && typeof P.signals === 'function') {
          const r = await P.signals();
          if (r && /^[0-9a-f]{64}$/.test(String(r.shared || ''))) out.shared = String(r.shared);
          if (r && typeof r.sibling === 'boolean') out.sibling = r.sibling;
          if (r && /^[0-9a-fA-F]{8,32}$/.test(String(r.androidId || ''))) out.androidId = String(r.androidId).toLowerCase();
        }
      } catch { /* a signal not sent */ }
      return out;
    })();
    return cached;
  };
  return async function getDeviceSignals(opts) {
    const out = await base();
    if (!opts || !opts.deviceCheck) return out;
    try {
      const P = plugin();
      if (P && typeof P.deviceCheck === 'function') {
        // Apple can be slow or unreachable; a report never waits more than 3 s for it.
        const r = await Promise.race([P.deviceCheck(), new Promise((res) => setTimeout(() => res(null), 3000))]);
        const t = r && typeof r.token === 'string' ? r.token : '';
        if (t.length >= 16 && t.length <= 8192) return Object.assign({}, out, { dc: t });
      }
    } catch { /* not sent */ }
    return out;
  };
})();
