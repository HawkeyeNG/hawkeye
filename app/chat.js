/* Support chat (Intercom), loaded ONLY when a visitor asks for it.
 *
 * Nothing from Intercom loads on page view: the privacy page promises no
 * third-party trackers, so the widget and its cookies arrive only after a click
 * on a [data-chat-open] button. The backend opens Intercom's hosts in the CSP on
 * the pages that carry the button and nowhere else (CHAT_PAGES in
 * backend/src/services/security.js), and sw.js lets Intercom's requests bypass
 * the service worker, whose own CSP would block them.
 *
 * IN LITE (window.Capacitor) the messenger loads inside the app too — the owner
 * wants the chat window in-app, not a trip to the browser. The app shell has no
 * CSP (that header comes from the backend) and no service worker on iOS, so
 * nothing blocks it. If it cannot load there (20 s timeout or a script error),
 * it falls back to WEB_CHAT in the browser, which opens the messenger at once
 * (?chat=1). UNVERIFIED ON A DEVICE: iOS serves the shell from capacitor://,
 * where a returning visitor's Intercom cookie may not persist between pages.
 * The native app's FAQ/About screens and More menu open WEB_CHAT.
 */
(function () {
  const APP_ID = 'nibzdah2';
  const WEB_CHAT = 'https://hawkeye.com.ng/about.html?chat=1';
  const inApp = !!window.Capacitor;
  const buttons = document.querySelectorAll('[data-chat-open]');
  if (!buttons.length) return;
  // EMBEDDED in the native app's "Chat with us" modal (native/src/app/chat.tsx,
  // ?chat=1&embed=1): the page itself is hidden — the screen is only the chat —
  // and closing the messenger tells the app to close the modal.
  const embed = new URLSearchParams(location.search).get('embed') === '1';
  if (embed) {
    const es = document.createElement('style');
    es.textContent = 'body>:not([id^="intercom"]):not([class*="intercom"]):not(script):not(style){display:none!important}'
      + 'html,body{background:var(--bg,#0b1a12)!important}';
    document.head.appendChild(es);
  }
  document.querySelectorAll('[data-chat-wrap]').forEach((el) => { el.hidden = false; });

  // Translated at the moment of use, never at load: the language can change
  // after this file runs.
  const tr = (key, english) => (window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english);

  // OUR launcher, not Intercom's. Intercom's own bubble is hidden
  // (hide_default_launcher) and this Hawkeye-green button takes the corner,
  // styled like the Ask Hawkeye button it replaces here. Ask Hawkeye (#hk-fab,
  // mounted by menu.js) is hidden on these pages: two chat bubbles in one
  // corner, one of them a bot and one a person, is a guessing game.
  const st = document.createElement('style');
  st.textContent = '#hk-fab,#hk-panel{display:none!important}'
    + '#hk-chat-fab{position:fixed;right:18px;bottom:18px;z-index:98;width:56px;height:56px;margin:0;padding:0;border-radius:50%;border:none;cursor:pointer;background:var(--green,#004225);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}'
    + '#hk-chat-fab:hover{filter:brightness(1.08)}#hk-chat-fab:focus-visible{outline:3px solid var(--gold,#f5b301);outline-offset:2px}'
    // Above the app's tab bar, exactly where #hk-fab sits (styles.css).
    + 'body.has-tabbar #hk-chat-fab{bottom:calc(78px + env(safe-area-inset-bottom))}'
    // On a phone Intercom's messenger is full-screen from y=0. Lite draws under
    // the status bar (viewport-fit=cover), so its header spilled under the clock
    // and notch, and its composer under the home indicator. Inset it by the safe
    // areas — env() is 0 in a normal browser tab, so the web is unchanged.
    + '@media (max-width:450px){.intercom-messenger-frame{top:env(safe-area-inset-top)!important;'
    + 'bottom:env(safe-area-inset-bottom)!important;height:auto!important;max-height:none!important}}';
  document.head.appendChild(st);
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'hk-chat-fab';
  fab.setAttribute('data-chat-open', '');
  fab.setAttribute('data-i18n-attr', 'aria-label:common.chat-with-us');
  fab.setAttribute('aria-label', tr('common.chat-with-us', 'Chat with us'));
  fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-4.6A8.2 8.2 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>';
  document.body.appendChild(fab);
  let open = false;

  let loading = null;
  function load() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      // Colours live in Intercom's dashboard (Messenger > Appearance), one per
      // theme: Hawkeye green in light, gold in dark (the green fails contrast on
      // a dark messenger). Setting action_color here would force one colour
      // onto both themes.
      window.intercomSettings = {
        api_base: 'https://api-iam.intercom.io',
        app_id: APP_ID,
        hide_default_launcher: true,
      };
      // Intercom's own stub: calls made before the widget arrives are queued and
      // replayed once it boots.
      const stub = function () { stub.c(arguments); };
      stub.q = [];
      stub.c = (args) => stub.q.push(args);
      window.Intercom = stub;
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://widget.intercom.io/widget/${APP_ID}`;
      // A request can also HANG rather than fail — a page still controlled by a
      // service worker from before the chat existed routes it through the worker
      // and it never settles. Give up after 20 s so the button never stays dead.
      const fail = () => { loading = null; reject(new Error('chat_load_failed')); };
      const timer = setTimeout(fail, 20000);
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); fail(); };
      document.head.appendChild(s);
    });
    return loading;
  }

  [...buttons, fab].forEach((btn) => {
    btn.addEventListener('click', async () => {
      // The corner button toggles; the in-page buttons only open.
      if (btn === fab && open) { window.Intercom('hide'); return; }
      const status = btn.parentElement.querySelector('[data-chat-status]');
      if (status) status.textContent = '';
      btn.disabled = true;
      try {
        const first = !window.Intercom || window.Intercom.q;
        await load();
        if (first) {
          window.Intercom('onShow', () => { open = true; });
          window.Intercom('onHide', () => {
            open = false;
            if (embed && window.ReactNativeWebView) window.ReactNativeWebView.postMessage('chat-closed');
          });
        }
        window.Intercom('show');
      } catch (_) {
        if (inApp) { window.open(WEB_CHAT, '_blank'); return; }
        if (status) {
          status.textContent = tr('common.chat-could-not-load',
            'The chat could not load. Email info@hawkeye.com.ng instead.');
        }
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Arriving from an app's "Chat with us" (WEB_CHAT): that tap was the request,
  // so open the messenger now rather than asking for a second one.
  if (!inApp && new URLSearchParams(location.search).get('chat') === '1') fab.click();
})();
