// ERROR REPORTING (Sentry, EU region) for the website and the Lite app, which
// run this same code. Crash reports only: no tracing, no session replay, no
// user identity. The SDK is self-hosted (vendor/sentry, MIT), so the only
// third-party host a page talks to is the ingest endpoint below. The CSP in
// backend security.js allows exactly that host, and sw.js lets it bypass the
// worker, whose own CSP would block it.
//
// PRIVACY IS THE POINT OF THIS FILE. Observers' safety depends on no report
// being linkable to a person. So every event is scrubbed HERE, before it
// leaves the device: phone numbers, e-mail addresses, long tokens/keys/hashes
// and URL query strings (invite tokens, codes) are removed, and the user,
// headers and cookies are dropped. The Sentry project ALSO refuses to store
// IP addresses and scrubs sensitive fields server-side. Belt and braces.
//
// The 92 KB SDK loads only after the page has finished loading, when the
// browser is idle, so it never competes with first paint on a low-end phone.
// Errors thrown before that are queued and sent once it arrives.
(function () {
  'use strict';
  var DSN = 'https://f89d3a4a5a332c2110fd2b33b7f1a6f1@o4512140316508160.ingest.de.sentry.io/4512148251803728';
  var SDK = '/vendor/sentry/bundle.min.js?v=11.0.0';
  var early = [];
  function onErr(e) { if (early) early.push(e.error || e.reason || e.message); }
  addEventListener('error', onErr);
  addEventListener('unhandledrejection', onErr);

  var PHONE = /(?:\+?234|\b0)\s?[789][01]\d(?:[\s-]?\d){7}\b/g;
  // Bounded parts (RFC 5321 limits): unbounded ones went quadratic on long text with no '@'.
  var EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
  var LONG = /\b[A-Za-z0-9_-]{24,}\b/g;                 // tokens, keys, hashes
  var QUERY = /(https?:\/\/[^\s?#"']*|\.html|\/)[?#][^\s"')]*/g;
  function clean(s) {
    return s.replace(QUERY, '$1').replace(EMAIL, '[email]')
      .replace(PHONE, '[phone]').replace(LONG, '[redacted]');
  }
  // Sentry's own ids are 32-hex strings that LONG would destroy; leave them.
  var KEEP = { event_id: 1, trace_id: 1, span_id: 1, parent_span_id: 1, sdk: 1, debug_meta: 1 };
  function walk(v, depth) {
    if (typeof v === 'string') return clean(v);
    if (!v || typeof v !== 'object' || depth > 8) return v;
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k) && !KEEP[k]) v[k] = walk(v[k], depth + 1);
    }
    return v;
  }
  function scrubEvent(ev) {
    delete ev.user;
    if (ev.request) { delete ev.request.headers; delete ev.request.cookies; delete ev.request.query_string; delete ev.request.data; }
    return walk(ev, 0);
  }
  function scrubCrumb(b) {
    // Typed input and console output are the two places a phone number or a
    // report could leak into a breadcrumb: drop them outright.
    if (b.category === 'ui.input' || b.category === 'console') return null;
    return walk(b, 0);
  }

  function start() {
    var s = document.createElement('script');
    s.src = SDK; s.async = true;
    s.onload = function () {
      var S = window.Sentry;
      if (!S || !S.init) return;
      var host = location.hostname;
      S.init({
        dsn: DSN,
        environment: window.Capacitor ? 'lite' : (host === 'hawkeye.com.ng' ? 'web' : 'development'),
        sendDefaultPii: false,
        tracesSampleRate: 0,
        maxBreadcrumbs: 30,
        // No release-health sessions: they would add a request per page view
        // and tell us nothing we act on.
        integrations: function (d) { return d.filter(function (i) { return i.name !== 'BrowserSession'; }); },
        // + the browser's own cross-page transition being skipped (Safari, not our
        // code: we never call startViewTransition).
        ignoreErrors: ['ResizeObserver loop', 'Non-Error promise rejection captured', 'Skipping view transition'],
        denyUrls: [/extensions\//i, /^chrome:\/\//i, /^moz-extension:/i, /^safari-(web-)?extension:/i],
        // Google's renderer (Googlebot's WRS) refuses service workers from its own
        // injected wrsParams shim: a crawler, not a user.
        beforeSend: function (ev) { return /wrsParams/.test(JSON.stringify(ev.exception || '')) ? null : scrubEvent(ev); },
        beforeBreadcrumb: scrubCrumb,
      });
      var q = early; early = null;
      removeEventListener('error', onErr);
      removeEventListener('unhandledrejection', onErr);
      (q || []).forEach(function (e) { if (e) S.captureException(e); });
    };
    document.head.appendChild(s);
  }
  function whenIdle() {
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 5000 });
    else setTimeout(start, 2000);
  }
  if (document.readyState === 'complete') whenIdle();
  else addEventListener('load', whenIdle);
})();
