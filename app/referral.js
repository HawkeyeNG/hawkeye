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

  /* "Bring a second observer to your unit" (invite-unit.js) adds the sender's
     unit: ?ref=CODE&unit=NN-NN-NN-NNN. It is parked beside the code so the
     chooser that ends a new sign-up (choose-unit.html) can open with it
     selected. Only the register's canonical form is kept — anything else is
     dropped, not guessed at. Never sent to the server: the unit is the
     recipient's to confirm or change, and nothing records which unit an
     invite was for. */
  var UNIT_KEY = 'hawkeye_invite_unit';
  var PU_RE = /^\d{2}-\d{2}-\d{2}-\d{3}$/;
  function normalizeUnit(s) {
    s = String(s || '').trim();
    return PU_RE.test(s) ? s : '';
  }

  function capture() {
    try {
      var p = new URLSearchParams(location.search);
      var code = normalize(p.get('r') || p.get('ref') || '');
      if (code.length !== 6) return;
      var before = localStorage.getItem(KEY);
      localStorage.setItem(KEY, code);
      /* A unit only rides WITH a code. A link carrying the same code and no
         unit (invite.html's own "continue" link, a forwarded address bar)
         leaves the parked unit alone; a DIFFERENT invite without one clears
         it, because that unit belonged to someone else's invitation. */
      var unit = normalizeUnit(p.get('unit'));
      if (unit) localStorage.setItem(UNIT_KEY, unit);
      else if (before && before !== code) localStorage.removeItem(UNIT_KEY);
    } catch (e) { /* private mode, or no storage: an invite is not worth an error */ }
  }

  /* Read, never cleared here. The server refuses a second attribution for an
     account that already has one, so a leftover code cannot re-assign anybody;
     clearing on read would instead lose the code if the signup request failed
     and the person tried again. */
  function pending() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }

  function pendingUnit() {
    try { return normalizeUnit(localStorage.getItem(UNIT_KEY)); } catch (e) { return ''; }
  }
  /* Cleared by the chooser once the sign-up step is over (saved or skipped):
     the unit is a suggestion for that one moment, not a standing setting. */
  function clearUnit() {
    try { localStorage.removeItem(UNIT_KEY); } catch (e) { /* nothing to clear */ }
  }

  capture();
  window.HAWKEYE_REFERRAL = {
    pending: pending, normalize: normalize, KEY: KEY,
    pendingUnit: pendingUnit, clearUnit: clearUnit, normalizeUnit: normalizeUnit, UNIT_KEY: UNIT_KEY,
  };
})();
