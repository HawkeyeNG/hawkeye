/* Support chat (Intercom), loaded ONLY when a visitor asks for it.
 *
 * Nothing from Intercom loads on page view: the privacy page promises no
 * third-party trackers, so the widget and its cookies arrive only after a click
 * on a [data-chat-open] button. The backend opens Intercom's hosts in the CSP on
 * the pages that carry the button and nowhere else (CHAT_PAGES in
 * backend/src/services/security.js), and sw.js lets Intercom's requests bypass
 * the service worker, whose own CSP would block them.
 *
 * Hidden in the app shell (window.Capacitor): the store builds have not been
 * tested with it, and the apps are not served by the backend that sets the CSP.
 */
(function () {
  const APP_ID = 'nibzdah2';
  const buttons = document.querySelectorAll('[data-chat-open]');
  if (!buttons.length) return;
  if (window.Capacitor) {
    document.querySelectorAll('[data-chat-wrap]').forEach((el) => el.remove());
    return;
  }
  document.querySelectorAll('[data-chat-wrap]').forEach((el) => { el.hidden = false; });

  // Translated at the moment of use, never at load: the language can change
  // after this file runs.
  const tr = (key, english) => (window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english);

  let loading = null;
  function load() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      window.intercomSettings = { api_base: 'https://api-iam.intercom.io', app_id: APP_ID };
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

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const status = btn.parentElement.querySelector('[data-chat-status]');
      if (status) status.textContent = '';
      btn.disabled = true;
      try {
        await load();
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
})();
