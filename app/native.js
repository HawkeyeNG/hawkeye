/* Hawkeye native bridge. STRICT NO-OP on the web — everything here activates
   only inside the Capacitor shell (window.Capacitor present). Keeps ONE
   codebase: web and app run the same app/ bundle; native features light up
   when wrapped. Loaded first in <head> so it runs before any page fetch. */
(function () {
  const Cap = window.Capacitor;
  const native = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const BASE = 'https://hawkeye.com.ng';
  window.HAWKEYE = { native, apiBase: native ? BASE : '' };
  if (!native) return; // ---- web path ends here; nothing below runs in a browser ----

  // There is no same-origin server in the shell, so leading-slash URLs must
  // point at the real API host. CapacitorHttp (enabled in capacitor.config)
  // makes fetch use native HTTP, so this is cross-origin-safe (no CORS wall);
  // requests still traverse Cloudflare, which stamps the origin-lock header.
  const abs = (u) => (typeof u === 'string' && u[0] === '/' && u[1] !== '/') ? BASE + u : u;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) =>
    origFetch(input && input.url ? new Request(abs(input.url), input) : abs(input), init);

  // Evidence photos, logo, map GeoJSON etc. are referenced with a leading slash.
  const fixEl = (el) => {
    if (!el.getAttribute) return;
    for (const a of ['src', 'href']) {
      const v = el.getAttribute(a);
      if (v && v[0] === '/' && v[1] !== '/') el.setAttribute(a, BASE + v);
    }
  };
  const scan = (root) => root.querySelectorAll
    && root.querySelectorAll('img,video,source').forEach(fixEl);
  document.addEventListener('DOMContentLoaded', () => scan(document));
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType === 1) { fixEl(n); scan(n); }
  }))).observe(document.documentElement, { childList: true, subtree: true });

  // Native capability seams — app.js calls these when present, keeping the
  // compress → hash → sign → upload order intact (architecture §3).
  const Camera = Cap.Plugins && Cap.Plugins.Camera;
  window.HAWKEYE.capabilities = { camera: !!Camera, secureKey: false, push: false };

  if (Camera) {
    // A LIVE camera capture (source CAMERA — never gallery/prompt) returned as a
    // JPEG Blob. app.js then compresses → hashes → signs → uploads it exactly as
    // on web, so content-addressing and the whole integrity model are unchanged.
    // The OS camera is inherently live-only, which satisfies "no gallery" more
    // strongly than the web getUserMedia path.
    window.HAWKEYE.capturePhoto = async function capturePhoto() {
      const photo = await Camera.getPhoto({
        source: 'CAMERA',
        resultType: 'base64',
        quality: 92,
        allowEditing: false,
        saveToGallery: false,
        correctOrientation: true,
        webUseInput: false,
      });
      const bin = atob(photo.base64String);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'image/' + (photo.format || 'jpeg') });
    };
  }

  // ---- native push (FCM/APNs) --------------------------------------------
  const Push = Cap.Plugins && Cap.Plugins.PushNotifications;
  window.HAWKEYE.capabilities.push = !!Push;
  if (Push) {
    // Register this device's token against the signed-in observer so the backend
    // can push "new report at your saved unit" etc. Only runs once the observer
    // has a session; a tap on a notification with a data.url deep-links there.
    window.HAWKEYE.initPush = async function initPush() {
      if (!localStorage.getItem('hawkeye_token')) return;
      let perm = await Push.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await Push.requestPermissions();
      if (perm.receive !== 'granted') return;
      Push.addListener('registration', (t) => {
        const jwt = localStorage.getItem('hawkeye_token');
        if (!jwt) return;
        origFetch(BASE + '/api/push/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
          body: JSON.stringify({ token: t.value, platform: Cap.getPlatform() }),
        }).catch(() => {});
      });
      Push.addListener('pushNotificationActionPerformed', (ev) => {
        const url = ev && ev.notification && ev.notification.data && ev.notification.data.url;
        if (url) location.href = url;
      });
      await Push.register();
    };
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => window.HAWKEYE.initPush().catch(() => {}), 1500));
  }
})();
