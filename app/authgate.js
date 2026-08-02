/* Signed-out access tiers (WEB-PARITY-PLAN, "After Parity").
   WEB, signed out: Index + Live Data + Learn & About (+ Terms) + practice stay
   open; Take Part and Trust & Verify pages bounce to sign-in.
   APP shell (Capacitor), signed out: only the auth funnel + practice stay open.
   Runs in <head> (after native.js, before <body>) so a gated page never flashes
   its content before the redirect. Signed-in users are unrestricted. */
(function () {
  function tokenFresh() {
    try {
      var t = localStorage.getItem('hawkeye_token');
      if (!t) return false;
      var exp = JSON.parse(atob(t.split('.')[1])).exp;   // JWT exp (seconds)
      return exp * 1000 > Date.now() + 60000;            // matches app.js tokenFresh()
    } catch (e) { return false; }
  }
  if (tokenFresh()) return;

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Reachable while signed out in BOTH tiers — the auth funnel (observe.html) and
  // practice, or a visitor could never sign in / try the product; plus donate.
  var ALWAYS = { 'observe.html': 1, 'practice.html': 1, 'support.html': 1, '404.html': 1 };

  // Web-only public surface: Index + Live Data + Learn & About (+ Terms) + the
  // public transparency pages. The tamper-evident ledger, public docket and
  // integrity views stay OPEN to signed-out visitors — "anyone can audit" is the
  // whole point; only Take Part actions (report/collation/incident/map) are gated.
  var WEB_PUBLIC = {
    'index.html': 1, '': 1,
    'results.html': 1, 'osun.html': 1, 'candidates.html': 1, 'dashboard.html': 1,
    'political.html': 1, 'race.html': 1, 'races.html': 1,
    'ledger.html': 1, 'docket.html': 1, 'integrity.html': 1, 'incident-reports.html': 1,
    'how.html': 1, 'guide.html': 1, 'faq.html': 1, 'about.html': 1,
    'privacy.html': 1, 'terms.html': 1, 'meta.html': 1, 'preview.html': 1
  };

  var isApp = !!(
    (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    || (window.HAWKEYE && window.HAWKEYE.native)
  );

  if (ALWAYS[page] || (!isApp && WEB_PUBLIC[page])) return;

  // Gated → sign-in, remembering the page they were headed for (app.js honours ?next).
  var here = location.pathname.replace(/^.*\//, '') + location.search;
  location.replace('observe.html?intent=signin&next=' + encodeURIComponent(here));
})();
