// Web Push (VAPID) opt-in. Subscribes this browser / installed PWA to Hawkeye
// alerts and registers the PushSubscription with the backend, so "new report at
// your saved unit" and the like reach it the same way FCM reaches the native app.
// window.hawkeyeEnableWebPush() is called from a user gesture (the permission
// prompt requires one) and returns { ok, reason? } so the caller can show status.
(function () {
  function urlB64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Support probe — false on non-installed iOS Safari (no Web Push there) and any
  // browser without a service worker or PushManager. Callers hide the control.
  function webPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function enableWebPush() {
    if (!webPushSupported()) return { ok: false, reason: 'unsupported' };
    const authToken = localStorage.getItem('hawkeye_token');
    if (!authToken) return { ok: false, reason: 'signin_required' };
    // Empty key = VAPID not configured server-side; treat as "push off", not an error.
    let publicKey = '';
    try { publicKey = (await fetch('/api/push/vapid').then((r) => r.json())).publicKey || ''; } catch { /* offline */ }
    if (!publicKey) return { ok: false, reason: 'server_push_off' };
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: 'denied' };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      }));
    const res = await fetch('/api/push/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken },
      body: JSON.stringify({ token: JSON.stringify(sub), platform: 'web' }),
    });
    return { ok: res.ok, reason: res.ok ? undefined : 'register_failed' };
  }

  window.hawkeyeWebPushSupported = webPushSupported;
  window.hawkeyeEnableWebPush = enableWebPush;
})();
