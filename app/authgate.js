/* Signed-out access tiers (WEB-PARITY-PLAN, "After Parity").
   WEB, signed out: Index + Live Data + Learn & About (+ Terms) + practice stay
   open; Take Part and Trust & Verify pages bounce to sign-in.
   APP shell (Capacitor), signed out: only the auth funnel + practice stay open.
   Runs in <head> (after native.js, before <body>) so a gated page never flashes
   its content before the redirect. Signed-in users are unrestricted. */
(function () {
  /* ONE DEVICE AT A TIME (owner decision D3). A sign-in on another device
     revokes this one's session, and every authenticated call from here on
     answers 401 { error: 'signed_in_elsewhere' }. This file is the one script
     in <head> of every token-using page, ahead of any page script, so it is
     where that answer is caught once instead of in forty 401 handlers.

     It drops the dead token and leaves a flag that observe.html's sign-in pane
     turns into "you were signed out because this account signed in on another
     device" (app.js paintElsewhere). A READ is then sent to sign-in. A WRITE is
     not: whatever the page was sending (a signed report, a collation) belongs to
     that page's own 401 handling, which keeps it — navigating away here would
     throw it on the floor. observe.html explains in place, never redirects. */
  if (window.fetch && !window.__hkElsewhereHooked) {
    window.__hkElsewhereHooked = true;
    var origFetch = window.fetch;
    var handled = false;
    var signedOutElsewhere = function (method) {
      try { localStorage.removeItem('hawkeye_token'); } catch (e) { /* storage blocked */ }
      try { localStorage.setItem('hawkeye_signed_out_elsewhere', String(Date.now())); } catch (e) { /* storage blocked */ }
      try { window.dispatchEvent(new CustomEvent('hawkeye-signed-out-elsewhere')); } catch (e) { /* old engine */ }
      if (handled) return;
      handled = true;
      var pg = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      if (pg === 'observe.html' || (method !== 'GET' && method !== 'HEAD')) return;
      location.replace('observe.html?intent=signin&next=' + encodeURIComponent(nextHere()));
    };
    window.fetch = function (input, init) {
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return origFetch.apply(this, arguments).then(function (res) {
        if (res && res.status === 401) {
          try {
            res.clone().json().then(function (b) {
              if (b && b.error === 'signed_in_elsewhere') signedOutElsewhere(method);
            }, function () { /* not JSON: not ours */ });
          } catch (e) { /* body already used: not ours */ }
        }
        return res;
      });
    };
  }

  function tokenFresh() {
    try {
      var t = localStorage.getItem('hawkeye_token');
      if (!t) return false;
      var exp = JSON.parse(atob(t.split('.')[1])).exp;   // JWT exp (seconds)
      return exp * 1000 > Date.now() + 60000;            // matches app.js tokenFresh()
    } catch (e) { return false; }
  }
  /* THIS DEVICE HAS HAD AN ACCOUNT. Set on every signed-in page load and never
     cleared by a sign-out, so the app shell can tell a first launch (offer
     sign-up first) from a returning reader (straight to sign-in) — see below. */
  var K_HAD = 'hawkeye_had_account';
  if (tokenFresh()) {
    try { localStorage.setItem(K_HAD, '1'); } catch (e) { /* a courtesy */ }
    return;
  }

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Reachable while signed out in BOTH tiers — the auth funnel (observe.html) and
  // practice, or a visitor could never sign in / try the product; plus donate.
  var ALWAYS = { 'observe.html': 1, 'practice.html': 1, 'support.html': 1, '404.html': 1 };

  // Web-only public surface: Index + Live Data + Learn & About (+ Terms) + the
  // public transparency pages. The tamper-evident ledger, public docket and
  // integrity views stay OPEN to signed-out visitors — "anyone can audit" is the
  // whole point; only Take Part actions (report/collation/incident/map) are gated.
  // A CASE is the docket's own page (FA-PUB-1): the docket linked to it and the
  // gate sent a signed-out auditor to sign-in. Reading it is public (GET
  // /api/docket/:id needs no session); case.html asks for sign-in only where a
  // verdict is cast.
  var WEB_PUBLIC = {
    'index.html': 1, '': 1,
    'results.html': 1, 'osun.html': 1, 'candidates.html': 1, 'dashboard.html': 1,
    'political.html': 1, 'race.html': 1, 'races.html': 1,
    'ledger.html': 1, 'docket.html': 1, 'case.html': 1, 'integrity.html': 1, 'incident-reports.html': 1,
    'how.html': 1, 'guide.html': 1, 'faq.html': 1, 'about.html': 1,
    'privacy.html': 1, 'terms.html': 1, 'meta.html': 1, 'preview.html': 1
  };

  var isApp = !!(
    (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    || (window.HAWKEYE && window.HAWKEYE.native)
  );

  if (ALWAYS[page] || (!isApp && WEB_PUBLIC[page])) return;

  /* THE APP'S FIRST LAUNCH OPENS ON SIGN-UP (ONB-05). A stranger opening Lite
     for the first time was met by "Sign In — Welcome back" with sign-up a small
     link at the bottom, where native opens on a welcome with "Become an
     observer" first and the web on its landing page's same button. Home with
     no sign of an account on this device (never signed in here, no stale
     token, not signed out by another device) goes to the sign-up form, the
     web's "Become an observer" — whose "Have an account? Sign In" keeps a
     returning reader one tap from signing in. Everyone else, as before. */
  var fresh = false;
  if (page === 'index.html' || page === '') {
    try {
      fresh = !localStorage.getItem(K_HAD) && !localStorage.getItem('hawkeye_token')
        && !localStorage.getItem('hawkeye_signed_out_elsewhere');
    } catch (e) { fresh = false; }
  }
  if (fresh) { location.replace('observe.html?intent=observe'); return; }

  // Gated → sign-in, remembering the page they were headed for (app.js honours ?next).
  location.replace('observe.html?intent=signin&next=' + encodeURIComponent(nextHere()));

  function nextHere() {
    var here = location.pathname.replace(/^.*\//, '') + location.search;
    // A situation room lives at /room/<slug>, whose last segment is the slug and
    // not a page — and app.js only honours `next` shaped like `<page>.html`, a
    // guard against sign-in becoming an open redirect. Passed through as-is, the
    // slug fails that guard and the manager lands on the homepage instead of the
    // room they were opening. Re-expressed in the shape the guard accepts, rather
    // than loosening the guard for one route.
    // The REST of the query rides along (?tab=team from a jump-list shortcut or
    // a pasted link): rebuilding the address from the slug alone dropped it, and
    // the manager came back from sign-in on Overview. Same shape as the page's
    // own /room/ forward, which keeps the query and sets room=.
    var room = location.pathname.match(/^\/room\/([a-z0-9-]+)\/?$/i);
    if (room) {
      here = 'situation-room.html?room=' + room[1];
      try {
        var q = new URLSearchParams(location.search);
        q.set('room', room[1]);
        here = 'situation-room.html?' + q.toString();
      } catch (e) { /* an old engine still gets the room, as before */ }
    }
    return here;
  }
})();
