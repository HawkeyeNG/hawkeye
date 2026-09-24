/* Support chat (Intercom), loaded ONLY when a visitor asks for it.
 *
 * Nothing from Intercom loads on page view: the privacy page promises no
 * third-party trackers, so the widget and its cookies arrive only after a click
 * on a [data-chat-open] button. The backend opens Intercom's hosts in the CSP on
 * the pages that carry the button and nowhere else (CHAT_PAGES in
 * backend/src/services/security.js), and sw.js lets Intercom's requests bypass
 * the service worker, whose own CSP would block them.
 *
 * IN THE APPS the chat opens on the website, in the in-app browser, at
 * WEB_CHAT — which opens the messenger at once (?chat=1). Intercom never loads
 * inside the app itself: the app shell is not served by the backend that sets
 * the CSP, and a webview on capacitor:// cannot keep Intercom's cookies. The
 * native app's FAQ/About screens and More menu open the same URL.
 */
(function () {
  const APP_ID = 'nibzdah2';
  const WEB_CHAT = 'https://hawkeye.com.ng/about.html?chat=1';
  const inApp = !!window.Capacitor;
  const buttons = document.querySelectorAll('[data-chat-open]');
  if (!buttons.length) return;
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
    + 'body.has-tabbar #hk-chat-fab{bottom:calc(78px + env(safe-area-inset-bottom))}';
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
      if (inApp) { window.open(WEB_CHAT, '_blank'); return; }
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
          window.Intercom('onHide', () => { open = false; });
        }
        window.Intercom('show');
      } catch (_) {
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
