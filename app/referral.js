/*
 * referral.js — the invite code, on whatever page it lands on.
 *
 * TWO JOBS, deliberately in one file so the code can never be captured on a
 * page that cannot then use it:
 *
 *   1. CATCH the code out of `?r=` on ANY page load and park it. An invite link
 *      points at /get, but people forward the address bar, so the code has to
 *      survive arriving anywhere.
 *   2. HAND it to the signup request, once, when an account is created.
 *
 * WHY ATTRIBUTION HAPPENS AT SIGNUP AND NOT AT INSTALL. Android can carry a
 * code through the Play Store (Install Referrer); iOS has no equivalent at all,
 * and the third-party ways around that are clipboard sniffing and device
 * fingerprinting — neither of which belongs in an election tool. Taking the
 * code when the account is made is the one mechanism that behaves identically
 * on web, on Android, on iOS and in both wrappers.
 */
(function () {
  'use strict';

  var KEY = 'hawkeye_referral';
  /* Same alphabet the server mints from: no 0/O/1/I/L/U, because this gets read
     off one screen and typed into another. Out-of-alphabet characters are
     DROPPED rather than mapped to a guess — "O" must not silently become "0"
     and resolve to a stranger's code. Twin: backend services/referrals.js. */
  function normalize(s) {
    return String(s || '').toUpperCase().replace(/[^2-9A-HJKMNP-TV-Z]/g, '').slice(0, 6);
  }

  function capture() {
    try {
      var p = new URLSearchParams(location.search);
      var code = normalize(p.get('r') || p.get('ref') || '');
      if (code.length === 6) localStorage.setItem(KEY, code);
    } catch (e) { /* private mode, or no storage: an invite is not worth an error */ }
  }

  /* Read, never cleared here. The server refuses a second attribution for an
     account that already has one, so a leftover code cannot re-assign anybody;
     clearing on read would instead lose the code if the signup request failed
     and the person tried again. */
  function pending() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }

  capture();
  window.HAWKEYE_REFERRAL = { pending: pending, normalize: normalize, KEY: KEY };
})();
