/**
 * The language chooser: a row on My Profile, and a one-time prompt after sign-up.
 *
 * WHY A PROMPT AT ALL. The default is the browser's language, which on a phone
 * bought in Nigeria is very often English regardless of what its owner reads
 * most comfortably. Asking once, at the moment someone has just committed to
 * being an observer, is the only point where the answer is cheap to collect.
 *
 * WHY IT ASKS ONLY ONCE. It records that it asked, not just what was answered,
 * so "Not now" is respected permanently. A prompt that reappears is a prompt
 * people learn to dismiss without reading, and this one has to be read on the
 * day it matters.
 *
 * DRAFT STATUS IS SHOWN, NOT HIDDEN, AND IT COMES FROM THE BUNDLE. Hausa, Igbo
 * and Yoruba are machine drafts built on a glossary an anonymous speaker has
 * checked; the picker labels each one with whatever its own `_meta.review`
 * says, so a reviewer's sign-off reaches the badge without anyone editing this
 * file. An observer trusting a mistranslated instruction on polling day is a
 * worse outcome than an observer reading English.
 */
(function () {
  'use strict';

  var ASKED = 'hawkeye_lang_prompted';
  var I18N = window.HawkeyeI18n;
  if (!I18N) return;

  /**
   * Tell the server, so the things it SENDS follow the choice too — push
   * notifications, Telegram, the OTP on the next device, the alert feed. The
   * browser's own copy in localStorage only governs what this page renders.
   *
   * BEST-EFFORT AND NEVER BLOCKING. The picker has already closed and the page
   * has already changed language by the time this runs; if it fails, the app is
   * still correct and only the notifications lag until the next successful
   * call. Signed out, there is no row to write to and nothing to do — the
   * language rides on the OTP request at sign-up instead (app.js chosenLang).
   */
  function tellServer(code) {
    var token = null;
    try { token = localStorage.getItem('hawkeye_token'); } catch (e) { /* private mode */ }
    if (!token) return;
    fetch('/api/observers/language', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ lang: code }),
    }).catch(function () { /* the app is already in the right language */ });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * The badge for a bundle's review state. Four states, not two: a translation
   * a speaker has read but that is still waiting on corroborating reviewers is
   * not the same claim as raw machine output, and calling it the same thing
   * either overstates the draft or understates the reviewed one.
   */
  var BADGE = {
    'machine-draft': ['lang.draft', 'Draft translation, being reviewed'],
    provisional: ['lang.provisional', 'Reviewed by one speaker — being confirmed'],
    unknown: ['lang.draft', 'Draft translation, being reviewed'],
  };

  function badge(state) {
    var b = BADGE[state];
    if (!b) return '';   // 'source' and 'human' carry no caveat
    return '<span class="lang-badge" data-i18n="' + b[0] + '">' + esc(I18N.t(b[0], b[1])) + '</span>';
  }

  /** One row per language. Pending ones are listed but not selectable. */
  function options(selected, states) {
    var html = '';
    I18N.LANGS.forEach(function (l) {
      html += '<label class="lang-opt" data-lang="' + l.code + '">'
        + '<input type="radio" name="hk-lang" value="' + l.code + '"'
        + (l.code === selected ? ' checked' : '') + '>'
        + '<span class="lang-native">' + esc(l.native) + '</span>'
        + '<span class="lang-en">' + esc(l.name) + '</span>'
        + badge((states || {})[l.code] || (l.code === 'en' ? 'source' : 'unknown'))
        + '</label>';
    });
    I18N.PENDING.forEach(function (l) {
      html += '<label class="lang-opt is-pending" aria-disabled="true">'
        + '<input type="radio" name="hk-lang" value="' + l.code + '" disabled>'
        + '<span class="lang-native">' + esc(l.native) + '</span>'
        + '<span class="lang-en">' + esc(l.name) + '</span>'
        + '<span class="lang-badge">' + esc(I18N.t('lang.coming', 'Coming soon')) + '</span>'
        + '</label>';
    });
    return html;
  }

  /** Build (once) and return the modal element. */
  function modal() {
    var el = document.getElementById('lang-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'lang-modal';
    el.className = 'lang-back';
    el.hidden = true;
    el.innerHTML =
      '<div class="lang-card" role="dialog" aria-modal="true" aria-labelledby="lang-modal-title">'
      + '<div class="lang-brand"><img src="/logo.svg" alt="" width="28" height="28">'
      + '<strong>Hawkeye</strong></div>'
      + '<h2 id="lang-modal-title" style="margin-top:8px" data-i18n="lang.title">'
      + esc(I18N.t('lang.title', 'Choose your language')) + '</h2>'
      + '<p class="hint" data-i18n="lang.body">'
      + esc(I18N.t('lang.body', 'Hawkeye works in more than one language. '
          + 'You can change this any time in My Profile.')) + '</p>'
      + '<div class="lang-list">' + options(I18N.current) + '</div>'
      + '<div class="lang-actions">'
      + '<button type="button" class="secondary" id="lang-cancel" style="width:auto" '
      + 'data-i18n="lang.later">' + esc(I18N.t('lang.later', 'Not now')) + '</button>'
      + '<button type="button" id="lang-save" style="width:auto" data-i18n="lang.save">'
      + esc(I18N.t('lang.save', 'Save')) + '</button>'
      + '</div></div>';
    document.body.appendChild(el);

    el.addEventListener('click', function (e) {
      if (e.target === el) close();
    });
    el.querySelector('#lang-cancel').addEventListener('click', close);
    el.querySelector('#lang-save').addEventListener('click', function () {
      var picked = el.querySelector('input[name="hk-lang"]:checked');
      var code = picked ? picked.value : 'en';
      I18N.set(code).then(function () {
        remember();
        close();
        refreshRow();
        tellServer(code);
      });
    });
    return el;
  }

  function open() {
    var el = modal();
    el.querySelectorAll('input[name="hk-lang"]').forEach(function (i) {
      i.checked = (i.value === I18N.current);
    });
    el.hidden = false;
    var first = el.querySelector('input[name="hk-lang"]:not([disabled])');
    if (first) first.focus();

    /* Badges start at the cautious default ("draft") and are corrected once
       each bundle has answered for itself. Cautious-first matters: if the
       fetch fails we must not have promised a review that nobody did. */
    I18N.statuses().then(function (states) {
      el.querySelectorAll('.lang-opt[data-lang]').forEach(function (row) {
        var state = states[row.getAttribute('data-lang')];
        if (!state) return;
        var old = row.querySelector('.lang-badge');
        var next = badge(state);
        if (old && !next) old.remove();
        else if (old) old.outerHTML = next;
        else if (next) row.insertAdjacentHTML('beforeend', next);
      });
    });
  }

  function close() {
    var el = document.getElementById('lang-modal');
    if (el) el.hidden = true;
    remember();
    settle();
  }

  /**
   * ONE ONBOARDING MODAL AT A TIME, AND LANGUAGE GOES FIRST.
   *
   * The first-run tour (menu.js) and this prompt are both "brand new observer,
   * right now" surfaces, and on index.html in the shell both were eligible at
   * once: the picker rendered on top and swallowed every click meant for the
   * tour. Found by tests/tour_test.mjs, which could not press Next.
   *
   * Language first, because a five-card tour in a language the reader does not
   * use is worth nothing — answering this question is what makes the tour
   * legible. So the tour waits for `hawkeye-lang-prompt-done`, which fires
   * exactly once however this resolves: prompt answered, prompt dismissed,
   * already answered on an earlier visit, or never shown because nobody signed
   * in. A path that did not fire it would leave the tour permanently suppressed.
   */
  var settled = false;
  function settle() {
    if (settled) return;
    settled = true;
    document.dispatchEvent(new CustomEvent('hawkeye-lang-prompt-done'));
  }

  /**
   * WHERE IT IS FAIR TO INTERRUPT.
   *
   * A modal is fine on the home screen or in Profile. It is not fine over a
   * half-filled incident report at a polling unit — which is what happened:
   * this prompt opened on incidents.html and covered Submit. Found by
   * tests/incident_kind_test.mjs, which could not press the button.
   *
   * The exception is the moment it exists for. If the token appears while this
   * page is open, the reader has just finished signing up on it, and the
   * question is expected rather than intrusive — that is the "first sign up"
   * prompt. A token that was already in storage when the page loaded is a
   * returning reader, so we wait for a calm screen. Nothing is lost by waiting:
   * every route through the app passes Home.
   *
   * Home only, not Profile. Profile has modals of its own — the picker landed
   * on top of the polling-unit chooser and blocked it
   * (tests/profile_unit_modal_test.mjs) — and it is the one screen that already
   * shows the Language row, so a reader who gets there does not need asking.
   */
  var HAD_TOKEN_AT_LOAD = (function () {
    try { return !!localStorage.getItem('hawkeye_token'); } catch (e) { return false; }
  })();

  function mayInterrupt() {
    var page = location.pathname.replace(/^.*\//, '') || 'index.html';
    if (page === 'index.html' || page === '') return true;
    return !HAD_TOKEN_AT_LOAD;   // signed up on this page, just now
  }

  /** True while the prompt may still appear, so the tour knows to hold. */
  function willPrompt() {
    return !settled && !asked() && !I18N.chosen && mayInterrupt();
  }

  function remember() {
    try { localStorage.setItem(ASKED, '1'); } catch (e) { /* private mode */ }
  }

  function asked() {
    try { return !!localStorage.getItem(ASKED); } catch (e) { return true; }
  }

  /** Keep the profile row's value in step with the chosen language. */
  function refreshRow() {
    var v = document.getElementById('p-lang');
    if (v) v.textContent = I18N.name(I18N.current);
    var k = document.querySelector('#btn-lang .prow-k');
    if (k) k.textContent = I18N.t('profile.language', 'Language');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btn-lang');
    if (btn) { btn.addEventListener('click', open); refreshRow(); }

    /* The one-time prompt. Signed in, never asked, and no explicit choice yet —
       which is exactly the state a new observer is in the moment sign-up
       finishes.
       CHECKED MORE THAN ONCE, on purpose. The token is written after the OTP
       round-trip returns, which can land well after DOMContentLoaded; a single
       check at load would miss the very users this prompt exists for — the ones
       signing up right now — and they are the hardest to reach again. Polling a
       few times costs nothing and stops the moment it has asked. */
    var tries = 0;
    (function maybePrompt() {
      if (asked() || I18N.chosen) { settle(); return; }
      var signedIn = false;
      try { signedIn = !!localStorage.getItem('hawkeye_token'); } catch (e) { /* ignore */ }
      if (signedIn) {
        if (mayInterrupt()) open();                  // settles when the modal closes
        else settle();                               // ask on a calmer screen instead
        return;
      }
      if (++tries < 6) setTimeout(maybePrompt, 1200);
      else settle();
    })();
  });

  document.addEventListener('hawkeye-lang', refreshRow);
  window.HawkeyeLang = { open: open, willPrompt: willPrompt };
})();
