// X (Twitter) posting via the v2 API with OAuth 1.0a user context. Posts to
// Hawkeye's OWN account using the four creds from the X developer portal — no
// interactive OAuth flow. Credential-gated: no-ops until all four are set.
// Text posting only for now; native video/image upload (chunked media/upload) is
// a future addition — until then the caption carries the hawkeye.com.ng link.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const xEnabled = () => Boolean(config.xApiKey && config.xApiSecret && config.xAccessToken && config.xAccessSecret);

// RFC-3986 percent-encoding (stricter than encodeURIComponent).
const enc = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Build the OAuth 1.0a Authorization header. `extra` holds any query/form params
// that must be signed (none for a JSON v2 tweet body).
function authHeader(method, url, extra = {}) {
  const oauth = {
    oauth_consumer_key: config.xApiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.xAccessToken,
    oauth_version: '1.0',
  };
  const all = { ...oauth, ...extra };
  const paramStr = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&');
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(paramStr)}`;
  const key = `${enc(config.xApiSecret)}&${enc(config.xAccessSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

export async function xStatus() {
  const s = { enabled: xEnabled() };
  if (!s.enabled) return s;
  try {
    const url = 'https://api.twitter.com/2/users/me';
    const r = await fetch(url, { headers: { authorization: authHeader('GET', url) } });
    const j = await r.json();
    if (j.data) { s.ok = true; s.username = j.data.username; } else { s.ok = false; s.error = j.detail || j.title || 'auth_failed'; }
  } catch (e) { s.ok = false; s.error = String(e.message || e); }
  return s;
}

export async function postX({ text }) {
  const body = String(text || '').slice(0, 280);
  if (!body) throw new Error('empty_text');
  const url = 'https://api.twitter.com/2/tweets';
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: authHeader('POST', url), 'content-type': 'application/json' },
    body: JSON.stringify({ text: body }),
  });
  const j = await r.json();
  if (!r.ok || !j.data) throw new Error(j.detail || (j.errors && JSON.stringify(j.errors)) || `x_post_${r.status}`);
  return { id: j.data.id };
}
