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

  // Native capability seams — the observe flow (app.js) can call these when
  // present, keeping the compress → hash → sign → upload order intact. Filled
  // out per docs/MOBILE-APP-ARCHITECTURE.md §3 in the next phase (camera plugin,
  // Keychain/Keystore-backed signing key, FCM/APNs push, offline outbox).
  window.HAWKEYE.capabilities = { camera: false, secureKey: false, push: false };
})();
