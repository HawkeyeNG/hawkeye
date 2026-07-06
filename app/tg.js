// Telegram Mini App adapter — a safe no-op in normal browsers.
// When the site is opened as a Telegram Web App (@HawkEyeNGBot), Telegram appends
// tgWebApp* params to the URL hash. Only then do we load Telegram's SDK and adapt
// the chrome (html.tg-app — see styles.css: static header, no footer/banner).
(function () {
  const isTg = /tgWebApp/i.test(location.hash) || /tgWebApp/i.test(location.search) ||
    window.TelegramWebviewProxy !== undefined;
  if (!isTg) return;
  const s = document.createElement('script');
  s.src = 'https://telegram.org/js/telegram-web-app.js';
  s.onload = () => {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) return;
    document.documentElement.classList.add('tg-app');
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#00251a');
      tg.setBackgroundColor('#f7f8f6');
    } catch (e) { /* older clients */ }
    // Pages that offer Telegram-native flows (OTP-free sign-in in app.js) hook this.
    window.HawkeyeTG = tg;
    document.dispatchEvent(new CustomEvent('hawkeye-tg-ready'));
  };
  document.head.appendChild(s);
})();
