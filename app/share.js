/*
 * share.js — "Share Hawkeye", and the one place the store links are written.
 *
 * An election tool spreads by someone handing it to someone else, and until now
 * the only way to do that was to copy the address bar. This puts a share button
 * where a person already is (the menu and their profile) and hands the link to
 * whatever they already use to talk to people.
 *
 * THREE ROUTES, IN ORDER, because no single one covers every surface Hawkeye
 * runs on:
 *
 *   1. navigator.share  — the OS sheet. Real browsers on Android and iOS, which
 *                         is where almost every visitor is. WhatsApp, Instagram,
 *                         iMessage, Telegram and everything else the phone
 *                         knows about, with no list for us to keep.
 *   2. Capacitor Share  — the same OS sheet inside Hawkeye Lite. Android WebView
 *                         does not expose navigator.share (it is a browser-UI
 *                         feature), so without this the app that most needs a
 *                         share button would be the one surface without one.
 *   3. our own sheet    — desktop, and anything else that has neither. Four web
 *                         intents and a copy button. Not a fallback nobody sees:
 *                         it is what a laptop gets, and a laptop is where a
 *                         journalist or a party agent reads this.
 *
 * Instagram and iMessage appear in 1 and 2 only. Neither has a web share URL —
 * Instagram has no share intent at all — so the honest fallback is Copy link
 * rather than a button that goes somewhere wrong.
 */
(function () {
  'use strict';

  /**
   * THE STORE LINKS, for download.html.
   *
   * TWO OTHER COPIES EXIST and this does not replace them: index.html's install
   * row has its own pair plus its own IOS_STORE_LIVE, and the backend has its
   * own for the /get redirect (backend/src/server.js), which runs before any of
   * this could load. Left alone deliberately — index.html's install section is
   * the most-tuned block on the site and a refactor of it is not what a share
   * button is for.
   *
   * SO WHEN THE APP STORE LISTING GOES LIVE, `iosLive` here and
   * `IOS_STORE_LIVE` in index.html flip together. Both are one line, both were
   * written in advance to be flipped, and neither shows anything iPhone-facing
   * until they are.
   */
  var STORES = {
    android: 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer',
    ios: 'https://apps.apple.com/app/id6804218478',
    // Flipped 2026-09-02, after checking the listing was actually purchasable
    // rather than merely approved: itunes.apple.com/lookup?id=6804218478
    // returns resultCount 1 for "Hawkeye Election Monitor" 1.0.0.
    iosLive: true,
    // Hawkeye Lite — a separate pair of listings, not a variant of the above.
    // Verified the same way as `ios` before being added here:
    // itunes.apple.com/lookup?bundleId=ng.com.hawkeye.lite returns resultCount 1,
    // "Hawkeye Lite: Election Monitor" 1.2, trackId 6806090537.
    liteAndroid: 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.lite',
    liteIos: 'https://apps.apple.com/app/id6806090537',
    liteIosLive: true,
  };

  /** Where a shared link lands: store badges, and the routes for phones with
   *  neither store. Absolute — a shared link has left this origin. */
  var LINK = 'https://hawkeye.com.ng/download';

  /**
   * WHAT GETS SENT. One sentence, no exclamation, no "download now".
   *
   * This arrives in someone's WhatsApp from a person they know, about an
   * election. It says what Hawkeye is and what it is for; anything that reads
   * like an advert is the fastest way to have it forwarded as spam — and on a
   * subject where Hawkeye's whole claim is that it is not campaigning for
   * anyone, tone is not decoration.
   */
  var TITLE = 'Hawkeye';
  var TEXT = 'Hawkeye lets Nigerians watch an election from their own polling unit '
    + 'and check the results against INEC\'s own sheets. It is free and independent.';

  var enc = encodeURIComponent;

  /** The OS sheet inside Hawkeye Lite, if this is Hawkeye Lite. */
  function capacitorShare() {
    var Cap = window.Capacitor;
    var S = Cap && Cap.Plugins && Cap.Plugins.Share;
    if (!S || typeof S.share !== 'function') return null;
    return S.share({ title: TITLE, text: TEXT, url: LINK, dialogTitle: 'Share Hawkeye' });
  }

  /**
   * The web-intent sheet. Built once, on first use — this is the third route of
   * three and most readers never reach it, so it should not cost every page a
   * dialog in the DOM.
   */
  var sheet = null;
  function buildSheet() {
    if (sheet) return sheet;
    var msg = TEXT + ' ' + LINK;
    var TARGETS = [
      { name: 'WhatsApp', url: 'https://wa.me/?text=' + enc(msg) },
      { name: 'Telegram', url: 'https://t.me/share/url?url=' + enc(LINK) + '&text=' + enc(TEXT) },
      { name: 'X', url: 'https://twitter.com/intent/tweet?text=' + enc(TEXT) + '&url=' + enc(LINK) },
      { name: 'Facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=' + enc(LINK) },
    ];
    sheet = document.createElement('dialog');
    sheet.className = 'share-sheet';
    sheet.innerHTML = '<h2 tabindex="-1">Share Hawkeye</h2>'
      + '<p class="hint">Send the download link to someone.</p>'
      + '<div class="share-targets">'
      + TARGETS.map(function (t) {
        return '<a class="btn-ghost" rel="noopener" target="_blank" href="' + t.url + '">' + t.name + '</a>';
      }).join('')
      + '</div>'
      + '<p class="share-link"><code>' + LINK + '</code></p>'
      + '<div class="share-foot"><button type="button" class="btn-accent" data-copy>Copy link</button>'
      + '<button type="button" class="btn-ghost" data-close>Close</button></div>';
    sheet.querySelector('[data-close]').addEventListener('click', function () { sheet.close(); });
    var copy = sheet.querySelector('[data-copy]');
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy link'; }, 1600); };
      // clipboard.writeText needs a secure context and can be refused outright;
      // the link is printed above regardless, so a refusal costs nothing.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(LINK).then(done, function () { copy.textContent = 'Copy it above'; });
      } else {
        copy.textContent = 'Copy it above';
      }
    });
    document.body.appendChild(sheet);
    return sheet;
  }

  /**
   * Share Hawkeye. Call from a click — every route below needs a user gesture,
   * and navigator.share throws without one.
   *
   * Never rejects into the caller: a share the reader cancelled is not an error,
   * and there is nothing to tell them about it.
   */
  function shareHawkeye() {
    try {
      if (navigator.share) {
        return navigator.share({ title: TITLE, text: TEXT, url: LINK }).catch(function () {});
      }
      var cap = capacitorShare();
      if (cap) return cap.catch(function () {});
    } catch (e) { /* fall through to the sheet */ }
    var s = buildSheet();
    if (typeof s.showModal === 'function') s.showModal();
    else window.open(LINK, '_blank', 'noopener');
    return Promise.resolve();
  }

  /**
   * Turn any element into a share control. The element keeps whatever href it
   * had, so without JS — or before this file loads — it is still a working link
   * to the download page.
   */
  function mountShare(el) {
    if (!el || el.dataset.shareMounted) return;
    el.dataset.shareMounted = '1';
    el.addEventListener('click', function (e) {
      e.preventDefault();
      shareHawkeye();
    });
  }

  window.HAWKEYE_STORES = STORES;
  window.HAWKEYE_SHARE_LINK = LINK;
  window.shareHawkeye = shareHawkeye;
  window.mountShare = mountShare;

  // Anything already in the page that says it is a share control. Pages that
  // build their own later call mountShare() directly.
  function mountAll() {
    [].forEach.call(document.querySelectorAll('[data-share]'), mountShare);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})();
