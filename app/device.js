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
