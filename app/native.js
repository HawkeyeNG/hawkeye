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

  // Mark the document early so CSS can strip web-only UI (e.g. the PWA install
  // CTA) with no race against page scripts.
  document.documentElement.classList.add('native-app');

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

  const DocScan = Cap.Plugins && Cap.Plugins.DocumentScanner;   // ML Kit doc scanner
  const TextRec = Cap.Plugins && Cap.Plugins.TextRecognition;   // ML Kit on-device OCR
  window.HAWKEYE.capabilities.docScanner = !!DocScan;
  window.HAWKEYE.capabilities.ocr = !!TextRec;

  const pathToBlob = async (p) => {
    const src = Cap.convertFileSrc ? Cap.convertFileSrc(p) : p;
    return (await origFetch(src)).blob();
  };

  // On-device OCR of the captured sheet. Runs in the background after capture;
  // app.js uses the line geometry to auto-fill counts (observer must confirm
  // before submitting). Never blocks capture and never replaces the
  // server-side vision read.
  async function ocrSheet(path) {
    if (!TextRec) return;
    try {
      const r = await TextRec.processImage({ path });
      const text = (r && r.text) || '';
      const tokens = text.match(/\d+/g) || [];
      const lines = [];
      for (const b of (r && r.blocks) || []) {
        for (const ln of b.lines || []) {
          const bb = ln.boundingBox || {};
          lines.push({ text: ln.text || '', left: bb.left || 0, top: bb.top || 0, bottom: bb.bottom || 0 });
        }
      }
      window.HAWKEYE.sheetOcr = { text, tokens, lines, at: Date.now() };
      window.dispatchEvent(new CustomEvent('hawkeye-sheet-ocr', { detail: window.HAWKEYE.sheetOcr }));
    } catch { /* advisory — ignore */ }
  }

  if (Camera) {
    // LIVE capture only — never gallery. The SHEET goes through the ML Kit
    // document scanner (live edge detection, auto-capture, perspective
    // correction — on-device); the VENUE uses the plain OS camera. Both return
    // a JPEG Blob that app.js compresses → hashes → signs → uploads exactly as
    // on web, so content-addressing and the integrity model are unchanged.
    // Google's ML Kit document scanner is delivered as an ON-DEMAND Google Play
    // Services module — it is NOT bundled in the APK and must be installed once
    // before the first scan, or scanDocument() fails and the sheet capture
    // appears to do nothing (no edge detection). Ensure it up front.
    async function ensureDocModule() {
      try {
        const a = await DocScan.isGoogleDocumentScannerModuleAvailable();
        if (a && a.available === false) await DocScan.installGoogleDocumentScannerModule();
      } catch { /* fall through — scanDocument surfaces the real error, handled below */ }
    }
    window.HAWKEYE.capturePhoto = async function capturePhoto(target) {
      if (target === 'sheet' && DocScan) {
        try {
          await ensureDocModule();
          const r = await DocScan.scanDocument({
            galleryImportAllowed: false,
            pageLimit: 1,
            resultFormats: 'JPEG',
            scannerMode: 'FULL',
          });
          const imgs = (r && (r.scannedImages || (r.result && r.result.scannedImages))) || [];
          if (imgs.length) {
            const path = imgs[0].path || imgs[0];
            ocrSheet(path); // fire-and-forget advisory read
            return pathToBlob(path);
          }
          throw new Error('cancelled'); // scanner returned nothing = user backed out
        } catch (e) {
          // A genuine user-cancel aborts; anything else (module unavailable, no
          // Play Services, scan error) falls through to the plain camera so the
          // capture button never dead-ends — the server-side vision read still runs.
          if (/cancel/i.test(String((e && e.message) || ''))) throw e;
          console.warn('[docscan] unavailable — using plain camera:', (e && e.message) || e);
        }
      }
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
  // DISABLED until Firebase is configured. Without mobile/android/app/
  // google-services.json, Firebase is never initialised, so Push.register()
  // throws a native "Default FirebaseApp is not initialized" exception the
  // instant the user grants the notification permission — and because the
  // session token then persists, initPush() re-runs on every launch and
  // crash-loops the app. In-app notifications (the header bell + the
  // /api/notifications feed) are web-based and unaffected.
  // TO ENABLE: add google-services.json (Firebase console -> Android app,
  // package ng.com.hawkeye.observer), set PUSH_ENABLED = true, rebuild.
  const PUSH_ENABLED = false;
  const Push = PUSH_ENABLED && Cap.Plugins && Cap.Plugins.PushNotifications;
  window.HAWKEYE.capabilities.push = !!Push;
  window.HAWKEYE.initPush = async () => {}; // safe no-op unless enabled below
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

  // ---- geolocation: route navigator.geolocation through the native plugin ----
  // The system WebView denies web geolocation unless the OS runtime permission is
  // granted; the plugin requests it properly. Patching getCurrentPosition means
  // the existing app.js code (getCaptureFix / getPosition) works unchanged.
  const Geo = Cap.Plugins && Cap.Plugins.Geolocation;
  if (Geo && navigator.geolocation) {
    window.HAWKEYE.capabilities.geolocation = true;
    const gerr = (code, message) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    navigator.geolocation.getCurrentPosition = function (success, error, options) {
      (async () => {
        try {
          let perm = await Geo.checkPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') perm = await Geo.requestPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') { if (error) error(gerr(1, 'Location permission denied')); return; }
          const pos = await Geo.getCurrentPosition({
            enableHighAccuracy: !(options && options.enableHighAccuracy === false),
            timeout: (options && options.timeout) || 15000,
            maximumAge: (options && options.maximumAge) || 0,
          });
          success({ coords: pos.coords, timestamp: pos.timestamp });
        } catch (e) { if (error) error(gerr(2, String((e && e.message) || e))); }
      })();
    };
  }

  // The PWA "Install Web App" prompt is meaningless inside the installed app.
  document.addEventListener('DOMContentLoaded', () => {
    for (const id of ['install-cta', 'install-hint']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  });
})();
