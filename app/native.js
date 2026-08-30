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

  // Status-bar icons must contrast the themed header: it is a WHITE bar in light
  // mode (needs DARK icons) and a dark-green bar in dark mode (needs light icons).
  // Follow html[data-theme]. Capacitor names the style by BACKGROUND: Style.Light
  // = dark icons for a light bg; Style.Dark = light icons for a dark bg.
  (function () {
    /**
     * THE PLUGIN IS NOT ALWAYS THERE YET, AND GIVING UP IS PERMANENT.
     *
     * This read Cap.Plugins.StatusBar once and returned if it was missing. Lite
     * is a multi-page app, so this runs on EVERY navigation, and on the ones
     * where Capacitor had not finished injecting its plugin bridge the bar was
     * simply never styled — which is exactly the "doesn't always change to
     * black" report: not a theme bug, a race. It is intermittent because it
     * depends on how quickly the bridge lands on that particular page load.
     *
     * So it retries briefly instead of bailing, and every later theme change
     * still goes through the observer below.
     */
    const applyBar = () => {
      const SB = Cap.Plugins && Cap.Plugins.StatusBar;
      if (!SB) return false;
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      SB.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
      if (SB.setBackgroundColor) SB.setBackgroundColor({ color: dark ? '#00251a' : '#ffffff' }).catch(() => {});
      return true;
    };
    if (!applyBar()) {
      // ~2s of 100ms attempts. Bounded: a bar that never styles is a cosmetic
      // fault, and an unbounded timer on every page is not worth it.
      let tries = 0;
      const t = setInterval(() => {
        if (applyBar() || ++tries > 20) clearInterval(t);
      }, 100);
    }
    new MutationObserver(applyBar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  })();

  /**
   * BOOT SPLASH IN THE WEB LAYER — the only place the mark can be shown on the
   * FIRST launch after install.
   *
   * Android 12+ has a documented platform bug (issuetracker.google.com/205021357;
   * hits Cordova/Xamarin/MAUI identically): on the first launch after
   * installation the system splash draws ONLY windowSplashScreenBackground — the
   * icon is omitted. Every later launch draws it. No theme, plugin or activity
   * code can change that; the icon-less splash is on screen before any app code
   * runs. So the hawk is drawn HERE, from the first frame the WebView paints
   * until the page is ready — bare green (OS, brief, unfixable) → green + hawk
   * (this) → app.
   *
   * First page of the SESSION only: in-shell navigations repaint instantly and
   * an overlay there would read as flicker. Assets are bundled (icon-192.png),
   * so this costs no network. The fallback timer is not optional — an overlay
   * nothing removes is an app that never appears.
   */
  // index.html owns the splash: it carries the markup AND its own removal (see
  // the comment there). This file NEVER creates one — it only guarantees any
  // splash present is taken down.
  //
  // REMOVAL IS UNCONDITIONAL. It used to sit inside a `!sessionStorage.hk_booted`
  // block, so returning Home later in the same session re-rendered index.html's
  // static splash with nothing left to remove it — the app sat behind a green
  // screen it could never leave. Removing an absent splash is a no-op, so there
  // is no reason to gate this on anything at all.
  const offSplash = () => {
    const el = document.getElementById('hk-boot-splash');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  };
  if (document.readyState === 'complete') setTimeout(offSplash, 150);
  else window.addEventListener('load', () => setTimeout(offSplash, 150), { once: true });
  setTimeout(offSplash, 3000); // hard cap — never strand the app behind the overlay

  // NO service worker in the app. The WebView already loads the shipped bundle
  // (local, instant, offline) — a SW adds nothing and actively breaks updates: an
  // installed SW keeps serving the PREVIOUS bundle's cached shell (old menu.js /
  // styles.css) after the APK is updated in place, so shipped changes never appear.
  // Registration is skipped in the shell (app.js / index.html guard on
  // window.HAWKEYE.native); here we also tear down any SW + caches a past build
  // left behind, so an updated install heals itself instead of staying stale.
  if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => Promise.all(rs.map((r) => r.unregister())))
      .then((rs) => {
        if (window.caches && caches.keys) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
        // If a stale SW WAS controlling this load, reload once (guarded so it can
        // never loop) so the WebView re-fetches the current bundle, not the cache.
        if (rs.length && navigator.serviceWorker.controller && !sessionStorage.getItem('hk_sw_purged')) {
          sessionStorage.setItem('hk_sw_purged', '1');
          location.reload();
        }
      })
      .catch(() => {});
  }

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

  // NO SPLASH PLUGIN. It was added to hold a splash the web layer controlled,
  // and it never showed the mark at all — the thing actually on screen is the
  // system splash and then the activity's own window background, so that is
  // where the fix belongs (mobile/android/.../values/styles.xml). One mechanism,
  // no timers, and nothing that can leave an app stuck behind a splash it was
  // never told to dismiss.

  // Native capability seams — app.js calls these when present, keeping the
  // compress → hash → sign → upload order intact (architecture §3).
  const Camera = Cap.Plugins && Cap.Plugins.Camera;
  window.HAWKEYE.capabilities = { camera: !!Camera, secureKey: false, push: false };

  // SCANNING AND OCR COME FROM WHICHEVER ENGINE THIS PLATFORM HAS.
  //
  // Android: ML Kit, as before. iOS: Apple's own VisionKit + Vision, through
  // the hawkeye-vision plugin. Two reasons it is not ML Kit on both:
  //   - @capacitor-mlkit/document-scanner is an iOS STUB. scanDocument() calls
  //     rejectCallAsUnimplemented, so sheet capture never had edge detection
  //     on iPhone at all — it silently used the plain camera.
  //   - ML Kit text recognition links 42 MB into the iOS binary (measured: a
  //     52 MB device build, of which the main binary is 42). Lite exists to be
  //     small; VisionKit and Vision are part of iOS and cost nothing.
  // hawkeye-vision deliberately mirrors the ML Kit method names and result
  // shapes, so everything below is one code path rather than two.
  const Vision  = Cap.Plugins && Cap.Plugins.HawkeyeVision;     // iOS: Apple frameworks
  const DocScan = Vision || (Cap.Plugins && Cap.Plugins.DocumentScanner);
  const TextRec = Vision || (Cap.Plugins && Cap.Plugins.TextRecognition);
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
      // VisionKit is part of iOS — nothing to fetch, and these two methods do
      // not exist on hawkeye-vision. Checking for the method rather than
      // calling it and catching keeps a normal iOS launch from throwing a
      // rejection on every capture.
      if (!DocScan.isGoogleDocumentScannerModuleAvailable) return;
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
  // ENABLED 2026-07-25: Firebase project "hawkeye-bd27d" configured —
  // google-services.json is in the Android project and the server holds the
  // matching FCM service account, so Push.register() initialises cleanly.
  const PUSH_ENABLED = true;
  const Push = PUSH_ENABLED && Cap.Plugins && Cap.Plugins.PushNotifications;
  // iOS only, by construction: @capacitor-firebase/messaging is stripped from
  // the Android build (mobile/scripts/build_aab_lite.sh) because it and
  // @capacitor/push-notifications both register a service for
  // com.google.firebase.MESSAGING_EVENT and Firebase delivers to only one.
  const FbMsg = Cap.Plugins && Cap.Plugins.FirebaseMessaging;
  window.HAWKEYE.capabilities.push = !!Push;
  window.HAWKEYE.initPush = async () => {}; // safe no-op unless enabled below
  if (Push) {
    // Register this device's token against the signed-in observer so the backend
    // can push "new report at your saved unit" etc. Only runs once the observer
    // has a session; a tap on a notification with a data.url deep-links there.
    /**
     * A BREADCRUMB PER STEP, because every one of them can end the chain.
     *
     * Six builds shipped with push silently dead, and the app could not say
     * which link broke: a refused permission, a plugin that never woke, a token
     * that never arrived and a register POST that failed all looked identical
     * from the outside — nothing. `stage` records the last point reached, so
     * the profile screen can name the failure instead of someone needing a
     * cable and Safari Web Inspector to find out.
     */
    const stage = (s) => { window.HAWKEYE.pushStage = s; };
    stage('not started');

    window.HAWKEYE.initPush = async function initPush() {
      stage('starting');
      if (!localStorage.getItem('hawkeye_token')) {
        // NOT an error — just nobody signed in yet. It became one only because
        // initPush ran once at launch and never again, so signing in afterwards
        // left push permanently unregistered for that install. The sign-in
        // paths in app.js now call this again; recorded either way.
        stage('waiting for sign-in');
        window.HAWKEYE.pushError = 'not signed in when push started';
        return;
      }

      /**
       * WAKE THE FIREBASE PLUGIN BEFORE ANYTHING REGISTERS WITH APNS.
       *
       * Capacitor instantiates a plugin lazily, on its first call from JS, and
       * FirebaseMessagingPlugin.load() is where it subscribes to
       * .capacitorDidRegisterForRemoteNotifications — the ONLY place it sets
       * Messaging.apnsToken. Reaching for it for the first time inside the
       * `registration` listener installed that observer AFTER the notification
       * had already fired, so Firebase never saw the APNs token and getToken()
       * failed with "No APNS token specified before fetching FCM Token".
       *
       * The app looked fine: permission was granted, iOS issued a token, and
       * the only symptom was that no push ever arrived. Any call will do — this
       * one is cheap and side-effect free; what matters is that it happens
       * before Push.register() below.
       */
      window.HAWKEYE.pushPlugins = { push: !!Push, firebase: !!FbMsg };
      if (FbMsg) {
        stage('waking Firebase');
        try { await FbMsg.checkPermissions(); } catch (e) {
          console.warn('[push] could not wake FirebaseMessaging:', (e && e.message) || e);
        }
      }

      stage('checking permission');
      let perm = await Push.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await Push.requestPermissions();
      window.HAWKEYE.pushPermission = perm.receive;
      if (perm.receive !== 'granted') {
        stage(`permission ${perm.receive}`);
        window.HAWKEYE.pushError = `permission ${perm.receive}`;
        return;
      }

      /**
       * THE FAILURE THAT USED TO LEAVE NO TRACE AT ALL.
       *
       * Everything below hangs off the 'registration' event. If APNs never
       * hands one back, none of it runs — no token, no server row, and
       * pushError never even gets assigned, because it was only ever set
       * INSIDE the listener. That is precisely how the AppDelegate bug hid for
       * five builds: permission granted, register() resolved, then silence
       * indistinguishable from success.
       *
       * The plugin does emit 'registrationError' for exactly this case (a
       * stripped aps-environment entitlement, no APNs reachability, a token
       * that will not parse). Listening costs nothing and turns the next
       * silent death into a readable one.
       */
      Push.addListener('registrationError', (e) => {
        const why = (e && (e.error || e.message)) || JSON.stringify(e);
        stage('APNs refused registration');
        window.HAWKEYE.pushError = `registrationError: ${why}`;
        console.warn('[push] APNs registration failed:', why);
      });

      // A registration that never arrives at all is the OTHER silent case, and
      // no event fires for it by definition. Park a reason after a generous
      // wait so "nothing happened" is distinguishable from "not tried yet";
      // the listener above clears it the moment a token does land.
      window.HAWKEYE.pushError = 'awaiting APNs registration';
      stage('awaiting APNs token');
      setTimeout(() => {
        if (window.HAWKEYE.pushError === 'awaiting APNs registration') {
          window.HAWKEYE.pushError = 'no registration event after 30s — APNs token never reached the app';
          stage('no APNs token after 30s');
          console.warn('[push]', window.HAWKEYE.pushError);
        }
      }, 30_000);

      Push.addListener('registration', async (t) => {
        window.HAWKEYE.pushError = null;
        stage('APNs token received');
        const jwt = localStorage.getItem('hawkeye_token');
        if (!jwt) { stage('token arrived but signed out'); return; }

        // WHICH TOKEN THE BACKEND CAN ACTUALLY USE.
        //
        // On Android this event carries an FCM token and the server sends via
        // FCM — fine. On iOS @capacitor/push-notifications hands back an APNs
        // token, which FCM cannot address: the server would store it, every
        // send would look like it succeeded, and no phone would ever ring.
        // hawkeye-vision's sibling here is @capacitor-firebase/messaging, which
        // exists on iOS ONLY (it must never reach Android — both plugins claim
        // the same MESSAGING_EVENT service) and exchanges it for an FCM token.
        let value = t.value;
        if (FbMsg) {
          // ONE RETRY. Firebase sets apnsToken from a NotificationCenter
          // observer; with the wake-up above that has already run by the time
          // this listener fires, but a single retry costs nothing and turns a
          // marginal ordering into a recovered one rather than a dead device.
          const fetchToken = async () => {
            const r = await FbMsg.getToken();
            if (!r || !r.token) throw new Error('no token returned');
            return r.token;
          };
          try {
            try {
              value = await fetchToken();
            } catch (first) {
              await new Promise((r) => setTimeout(r, 1500));
              value = await fetchToken();
            }
            window.HAWKEYE.pushError = null;
          } catch (e) {
            /* Deliberately register NOTHING rather than an APNs token the server
               cannot use: a stored dead token looks exactly like a working one.
               But "nothing" was also invisible — this failed on a real device and
               the only symptom was that no push ever arrived. Park the reason
               where it can be read back. */
            const why = (e && e.message) || String(e);
            stage('FCM token exchange failed');
            window.HAWKEYE.pushError = why;
            console.warn('[push] no FCM token on iOS — not registering:', why);
            return;
          }
        }

        /**
         * THE LAST SILENT LINK. This POST used to end in `.catch(() => {})`,
         * so a 401, an offline phone or a server error left no trace and the
         * device simply never appeared in the audience — the same
         * indistinguishable nothing as every other failure in this chain.
         *
         * The token's LENGTH is recorded, never the token: 64 hex characters
         * means an APNs token the sender declines by shape, ~150+ means a real
         * FCM one, and that difference is the whole diagnosis. The value itself
         * is the capability to push to this device and this screen gets
         * screenshotted.
         */
        stage('registering with server');
        window.HAWKEYE.pushTokenLen = String(value || '').length;
        origFetch(BASE + '/api/push/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
          body: JSON.stringify({ token: value, platform: Cap.getPlatform() }),
        }).then((r) => {
          if (r.ok) { stage('registered'); window.HAWKEYE.pushError = null; }
          else { stage(`server refused (${r.status})`); window.HAWKEYE.pushError = `register HTTP ${r.status}`; }
        }).catch((e) => {
          stage('register request failed');
          window.HAWKEYE.pushError = `register failed: ${(e && e.message) || e}`;
        });
      });
      Push.addListener('pushNotificationActionPerformed', (ev) => {
        const url = ev && ev.notification && ev.notification.data && ev.notification.data.url;
        /**
         * NO URL MEANS ALERTS, not "stay where you are".
         *
         * Tapping a notification used to do nothing at all unless the sender
         * had typed a url — so the app opened on whatever page it last showed,
         * normally Home, and the tap looked ignored. Broadcasts carry no url
         * unless one was entered, so that is the ORDINARY case, not an edge.
         * Alerts is where the tapped notification is a durable row, so it is
         * the honest destination.
         */
        location.href = url || 'notifications.html';
      });
      await Push.register();
    };

    /**
     * THE BADGE AND THE SHADE ARE TWO SEPARATE STORES, and reading an alert
     * has to clear both.
     *
     * The server sends an absolute badge count with every push, so once alerts
     * were read the icon kept the old number until the NEXT push arrived —
     * which is exactly what "the counter doesn't disappear" looked like. And
     * iOS keeps delivered notifications in the shade until something removes
     * them, so the same alert had to be dismissed a second time by hand.
     *
     * Neither push plugin exposes the icon badge (they can clear the shade
     * only), hence HawkeyeVision.setBadge — see the Swift side for why that
     * lives in the vision plugin instead of a new dependency. On Android the
     * launcher derives its badge from active notifications, so clearing
     * delivered ones does the whole job and Vision is absent by design.
     *
     * Every call is best-effort: a badge that fails to clear must never break
     * the page that was only trying to mark something read.
     */
    window.HAWKEYE.clearNotificationUi = async function clearNotificationUi(unread) {
      const n = Math.max(0, Number(unread) || 0);
      try {
        if (n === 0 && Push.removeAllDeliveredNotifications) {
          await Push.removeAllDeliveredNotifications();
        }
      } catch (e) { console.warn('[push] could not clear the shade:', (e && e.message) || e); }
      try {
        if (Vision && Vision.setBadge) await Vision.setBadge({ count: n });
      } catch (e) { console.warn('[push] could not set the badge:', (e && e.message) || e); }
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

/**
 * fetchData(name) — read a volatile data file from the LIVE site.
 *
 * WHY THIS EXISTS. Hawkeye Lite is a Capacitor wrapper with no `server.url`, so
 * app/ is served from https://localhost and a relative fetch reads the copy
 * BAKED INTO THE APK. That copy only changes with a Play release, and INEC
 * amended its 2023 candidate list SEVEN times after publication. Seven store
 * releases to correct a JSON file is not a pipeline.
 *
 * Off-origin (Lite): fetch the live file, fall back to the bundled copy if the
 * network is unavailable — so the app still opens at a polling unit with no
 * signal, just with whatever data it shipped with.
 * On hawkeye.com.ng: same-origin, behaves exactly as before.
 *
 * CapacitorHttp is enabled, which routes fetch through native code and is
 * therefore not subject to CORS — the live files send no
 * access-control-allow-origin header, so a plain browser cross-origin fetch
 * would be blocked. If that plugin is ever disabled this silently falls back to
 * the bundle, which looks like "the app works" while showing stale candidates.
 */
window.HAWKEYE_LIVE_ORIGIN = 'https://hawkeye.com.ng';
window.fetchData = function (name) {
  var onLive = /(^|\.)hawkeye\.com\.ng$/i.test(location.hostname);
  /**
   * A DEV SERVER IS `http:` — TEST FOR THAT, not for "not https".
   *
   * `location.protocol !== 'https:'` was written when Android was the only
   * shell, where capacitor.config sets androidScheme "https" and the app really
   * is served from https://localhost. iOS has no iosScheme, so it serves from
   * `capacitor://localhost` — which is not 'https:', so every fetchData call on
   * iOS took the DEV branch and read the copy baked into the app.
   *
   * That is invisible for anything still in the bundle and fatal for anything
   * stripped out of it. strip_web_assets.sh removes lga_geo, district_geo and
   * constituency_geo (1.7 MB) precisely because they are meant to come from the
   * live site, so on iOS they 404'd against the bundle and the board printed
   * "Map unavailable". states_geo.json stays bundled, which is why the
   * governorship map drew and the Senate one did not — the difference that
   * identified this.
   *
   * Not a regression: it has been true since the iOS shell existed. Android was
   * fine throughout, which is what made it look like a build problem.
   */
  var isDev = location.protocol === 'http:';
  if (onLive || isDev) return fetch(name);
  return fetch(window.HAWKEYE_LIVE_ORIGIN + '/' + name.replace(/^\/+/, ''))
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r; })
    .catch(function () { return fetch(name); });
};
