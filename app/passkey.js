/* PASSKEYS ON THE WEB — sign in with a fingerprint, face or screen lock
 * instead of a code or a password (WebAuthn). The server's rules are in
 * backend/src/services/passkeys.js: a passkey is for RETURNING sign-in only,
 * never a sign-up and never the phone proof that resets a password.
 *
 * OFFERED ONLY WHERE IT CAN WORK. A passkey belongs to hawkeye.com.ng (the RP
 * ID the server reports in /api/health), so:
 *   - the Lite app's shell (https://localhost, capacitor://localhost) cannot
 *     use one: WebAuthn there would be for "localhost", not for us;
 *   - Telegram's in-app browser and other app WebViews either lack WebAuthn or
 *     refuse it without the host app's entitlement;
 *   - a server without the library installed says passkeys:false.
 * Any of those, and nothing about passkeys is shown. The native apps get their
 * own module in a later store build.
 *
 * No pop-up before the system prompt (owner rule): every entry point is an
 * ordinary inline button, and pressing it goes straight to the browser's own
 * passkey sheet.
 *
 * Exposes window.HawkeyePasskey = { supported, canCreateHere, register, signIn,
 * list, remove, errorText }. The caller passes its own `api(path, opts)` so the
 * device id, device class and token headers are the page's usual ones.
 */
(function () {
  'use strict';

  function T(key, english, params) {
    let out = window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english;
    for (const [k, v] of Object.entries(params || {})) out = String(out).split('{' + k + '}').join(v);
    return out;
  }

  const b64uToBuf = (s) => {
    let b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  const bufToB64u = (buf) => {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /** Inside an app's WebView (Lite, Telegram, Hawkeye native) rather than a browser. */
  function inAppShell() {
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return true;
      if (window.HAWKEYE && window.HAWKEYE.native) return true;
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) return true;
      if (/^(capacitor|ionic|file):$/.test(location.protocol)) return true;
    } catch (e) { /* treat as a browser */ }
    return false;
  }

  let healthP = null;
  function health() {
    // The sign-in page (app.js) has usually asked already; reuse its answer.
    if (!healthP && window.__hkHealthP) healthP = window.__hkHealthP;
    if (!healthP) {
      const base = (window.HAWKEYE && window.HAWKEYE.apiBase) || '';
      healthP = fetch(base + '/api/health').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    return healthP;
  }

  /** WebAuthn is present, this is a browser on our own domain, and the server has passkeys on. */
  async function supported() {
    if (!window.PublicKeyCredential || !navigator.credentials || inAppShell()) return false;
    const h = await health();
    if (!h || h.passkeys !== true || !h.passkeyRpId) return false;
    const host = location.hostname;
    return host === h.passkeyRpId || host.endsWith('.' + h.passkeyRpId);
  }

  /** …and this device can MAKE one with its own fingerprint, face or screen lock. */
  async function canCreateHere() {
    if (!(await supported())) return false;
    try {
      return !!(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
        && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (e) { return false; }
  }

  function creationOptions(o) {
    return {
      ...o,
      challenge: b64uToBuf(o.challenge),
      user: { ...o.user, id: b64uToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
  }
  function requestOptions(o) {
    return {
      ...o,
      challenge: b64uToBuf(o.challenge),
      allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
  }
  function credentialJSON(cred) {
    const r = cred.response;
    const out = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: (cred.getClientExtensionResults && cred.getClientExtensionResults()) || {},
      response: { clientDataJSON: bufToB64u(r.clientDataJSON) },
    };
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64u(r.attestationObject);
      try { out.response.transports = r.getTransports ? r.getTransports() : []; } catch (e) { out.response.transports = []; }
    } else {
      out.response.authenticatorData = bufToB64u(r.authenticatorData);
      out.response.signature = bufToB64u(r.signature);
      if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
    }
    return out;
  }

  /**
   * One sentence for any failure, in the reader's language. A cancelled system
   * sheet (NotAllowedError) is the commonest "failure" and is not an error to
   * the person who pressed Cancel — callers treat `cancelled` quietly.
   */
  function errorText(err) {
    const e = err && (err.error || err.name || err);
    if (e === 'cancelled' || e === 'NotAllowedError' || e === 'AbortError') return T('passkey.cancelled', 'Cancelled. Nothing was changed.');
    if (e === 'InvalidStateError' || e === 'passkey_exists') return T('passkey.already-here', 'This device already has a passkey for your account.');
    if (e === 'too_many_passkeys') return T('passkey.too-many', 'This account has the most passkeys it can hold. Remove one on your profile first.');
    if (e === 'passkey_failed') return T('passkey.failed', 'That passkey did not work here. Sign in another way.');
    if (e === 'passkeys_unavailable' || e === 'unsupported') return T('passkey.unavailable', 'Passkeys are not available here. Sign in another way.');
    if (e === 'network') return T('passkey.network', 'Could not reach Hawkeye. Check your connection and try again.');
    return T('passkey.failed-generic', 'Something went wrong with the passkey. Try again, or sign in another way.');
  }
  const failed = (e) => {
    const name = e && e.name;
    return { error: name === 'NotAllowedError' || name === 'AbortError' ? 'cancelled' : (name || 'failed') };
  };

  /** Make a passkey for the signed-in account on this device. Needs the caller's authenticated api(). */
  async function register(api) {
    if (!(await supported())) return { error: 'unsupported' };
    let r;
    try {
      r = await api('/api/observers/passkeys/register-options', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lang: (window.HawkeyeI18n && window.HawkeyeI18n.current) || undefined }),
      });
    } catch (e) { return { error: 'network' }; }
    if (r.status !== 200) return { error: (r.body && r.body.error) || 'failed' };
    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: creationOptions(r.body.options) });
    } catch (e) { return failed(e); }
    if (!cred) return { error: 'cancelled' };
    try {
      r = await api('/api/observers/passkeys/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: credentialJSON(cred) }),
      });
    } catch (e) { return { error: 'network' }; }
    if (r.status !== 200) return { error: (r.body && r.body.error) || 'failed' };
    try { localStorage.setItem('hawkeye_pk_here', '1'); } catch (e) { /* a courtesy flag */ }
    return { ok: true, passkeys: r.body.passkeys || [] };
  }

  /**
   * Sign in with a passkey. No phone number: the browser offers this site's
   * passkeys. `publicKeyJwk` is this device's signing key, bound to the session
   * exactly as every other sign-in binds it. Returns the server's sign-in body
   * ({ token, observerId, needsUnit, … }) or { error }.
   */
  async function signIn(api, publicKeyJwk) {
    if (!(await supported())) return { error: 'unsupported' };
    let r;
    try {
      r = await api('/api/observers/passkeys/login-options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch (e) { return { error: 'network' }; }
    if (r.status !== 200) return { error: (r.body && r.body.error) || 'failed' };
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: requestOptions(r.body.options) });
    } catch (e) { return failed(e); }
    if (!cred) return { error: 'cancelled' };
    try {
      r = await api('/api/observers/passkeys/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: credentialJSON(cred), publicKeyJwk }),
      });
    } catch (e) { return { error: 'network' }; }
    if (r.status !== 200) return { error: (r.body && r.body.error) || 'passkey_failed' };
    try { localStorage.setItem('hawkeye_pk_here', '1'); } catch (e) { /* a courtesy flag */ }
    return r.body;
  }

  async function list(api) {
    try {
      const r = await api('/api/observers/passkeys');
      return r.status === 200 ? r.body : null;
    } catch (e) { return null; }
  }
  async function remove(api, id) {
    try {
      const r = await api('/api/observers/passkeys/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      });
      return r.status === 200 ? r.body : { error: (r.body && r.body.error) || 'failed' };
    } catch (e) { return { error: 'network' }; }
  }

  window.HawkeyePasskey = { supported, canCreateHere, register, signIn, list, remove, errorText };
})();
