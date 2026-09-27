/*
 * invite-unit.js — "Bring a second observer to your unit".
 *
 * WHY A SECOND OBSERVER. One report at a unit shows as REPORTED; it turns
 * VERIFIED when another observer at the same unit reports the same numbers. So
 * the most useful person an observer can recruit is not anyone, it is someone
 * who will stand at THEIR unit. This is the ordinary invite link (referral.js,
 * /api/observers/referral) with the sender's unit added:
 *
 *     https://hawkeye.com.ng/open?to=invite&ref=CODE&unit=NN-NN-NN-NNN
 *
 * and when the recipient signs up, choose-unit.html opens with that unit
 * already selected. They confirm it or change it.
 *
 * /open, NOT /invite.html: /open is a path both apps already claim (App Links,
 * Universal Links — native/app.json, .well-known/apple-app-site-association),
 * so with the app installed the link opens it straight onto sign-up. Without
 * the app, open/index.html forwards the same params to invite.html. Old
 * invite.html links keep working; they just always open the browser.
 *
 * THE ORIGIN IS WRITTEN OUT, NEVER READ FROM location. A link the user SENDS
 * has left this device by definition. In Hawkeye Lite this very file is served
 * from https://localhost (Android) or capacitor://localhost (iOS), and an
 * invite built from location.origin once pointed at the sender's own phone.
 *
 * WHAT THE LINK CARRIES, AND NOTHING ELSE: the sender's referral code and the
 * unit code they chose to share. No names. The server is not told which unit
 * an invite was for, so nothing public can say a unit is being watched.
 *
 * SHARING. Inside Lite the OS share sheet (Capacitor Share, same route as
 * share.js); on the web, copy — the one action that works everywhere and can be
 * confirmed on screen (see profile.html's invite row for the failures that
 * taught that). If even the clipboard is refused, the caller reveals the text
 * for copying by hand.
 *
 * Every string is resolved when it is USED, never at load: i18n.js loads after
 * this file on every page.
 */
(function () {
  'use strict';

  var ORIGIN = 'https://hawkeye.com.ng';
  /* The register's canonical form (pu-code.js normalizeCode). Anything else in
     `unit` is dropped, never guessed at. */
  var PU_RE = /^\d{2}-\d{2}-\d{2}-\d{3}$/;
  var enc = encodeURIComponent;

  function T(k, en) { return window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en; }

  function validUnit(pu) { return PU_RE.test(String(pu || '')); }

  /** The link. A unit that fails the format is left off rather than sent. */
  function link(code, pu) {
    var url = ORIGIN + '/open?to=invite&ref=' + enc(code);
    return validUnit(pu) ? url + '&unit=' + enc(pu) : url;
  }

  function token() { try { return localStorage.getItem('hawkeye_token'); } catch (e) { return null; } }

  /** Signed-in GET with a real deadline; null on any failure. Quiet by design:
   *  an invite is never worth an error on the screen that hosts it. */
  async function authed(path) {
    var t = token();
    if (!t) return null;
    var headers = { authorization: 'Bearer ' + t };
    try { if (window.getDeviceId) headers['x-device-id'] = await window.getDeviceId(); } catch (e) { /* optional */ }
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 10000);
    try {
      var r = await fetch(path, { headers: headers, signal: ctl.signal, cache: 'no-store' });
      return r.ok ? await r.json().catch(function () { return null; }) : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* One request per page for the code; a failure is not remembered, so the
     next tap is a real retry. */
  var codeP = null;
  function referralCode() {
    if (!codeP) {
      codeP = authed('/api/observers/referral').then(function (b) {
        var c = (b && b.code) || '';
        if (!c) codeP = null;
        return c;
      });
    }
    return codeP;
  }

  /** The signed-in observer's saved unit; null when none is saved; undefined
   *  when it could not be asked (signed out, offline, server error) — so a
   *  failed request is never mistaken for "no unit". */
  async function myUnit() {
    var b = await authed('/api/observers/my-unit');
    if (!b || b.ok === false) return undefined;
    return b.unit && validUnit(b.unit.pu_code) ? b.unit : null;
  }

  /** What travels with the link. No unit name and no sender name: the
   *  recipient sees the unit on the chooser, and a forwarded message says no
   *  more than it has to. */
  function text() {
    return T('invite2.share-text',
      'Watch my polling unit with me on Hawkeye. When two of us report the same numbers there, the count is verified.');
  }

  /**
   * Hand the link on. Resolves to what happened, so the caller can SAY it:
   *   'shared'  the OS sheet opened (Lite)
   *   'copied'  on the clipboard
   *   'manual'  nothing worked; show the text for copying by hand
   */
  async function share(url) {
    var Cap = window.Capacitor;
    var S = Cap && Cap.Plugins && Cap.Plugins.Share;
    if (S && typeof S.share === 'function') {
      try {
        await S.share({ title: 'Hawkeye', text: text(), url: url, dialogTitle: T('invite2.button', 'Invite a second observer') });
      } catch (e) { /* dismissed: not an error */ }
      return 'shared';
    }
    try {
      await navigator.clipboard.writeText(text() + ' ' + url);
      return 'copied';
    } catch (e) {
      return 'manual';
    }
  }

  /** The by-hand fallback: a selected, read-only field after `anchor`. */
  function reveal(anchor, url) {
    var box = anchor.parentNode && anchor.parentNode.querySelector('.iu-reveal');
    if (!box) {
      box = document.createElement('input');
      box.readOnly = true;
      box.className = 'iu-reveal';
      // Inline, so no host page needs a rule for a field most readers never see.
      box.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:8px 0 0;padding:.6rem .75rem;'
        + 'font:500 .85rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--border);'
        + 'border-radius:.5rem;background:var(--bg);color:inherit';
      box.setAttribute('aria-label', T('invite2.button', 'Invite a second observer'));
      anchor.insertAdjacentElement('afterend', box);
    }
    box.value = text() + ' ' + url;
    box.hidden = false;
    box.focus();
    box.select();
  }

  /** Share, then report the outcome in words. Returns the outcome. */
  async function shareAndSay(url, anchor, say) {
    var how = await share(url);
    if (how === 'copied') say(T('profile.copied', 'Copied'));
    else if (how === 'manual') { reveal(anchor, url); say(T('profile.copy-it-here', 'Copy it below')); }
    return how;
  }

  window.HawkeyeInviteUnit = {
    ORIGIN: ORIGIN,
    validUnit: validUnit,
    link: link,
    referralCode: referralCode,
    myUnit: myUnit,
    text: text,
    share: share,
    reveal: reveal,
    shareAndSay: shareAndSay,
  };
})();
