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

// Chunked media upload (v1.1 media/upload) with OAuth 1.0a. INIT/FINALIZE/STATUS
// carry signed form/query params; APPEND is multipart, so only the oauth params
// are signed (the form fields are not part of the signature base). Returns a
// media_id usable in a v2 tweet.
const UPLOAD = 'https://upload.twitter.com/1.1/media/upload.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadMedia(buffer, mime) {
  const category = mime.startsWith('video') ? 'tweet_video' : (mime.includes('gif') ? 'tweet_gif' : 'tweet_image');
  const initP = { command: 'INIT', total_bytes: String(buffer.length), media_type: mime, media_category: category };
  const initR = await fetch(UPLOAD, { method: 'POST', headers: { authorization: authHeader('POST', UPLOAD, initP), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(initP) });
  const initJ = await initR.json();
  const mediaId = initJ.media_id_string;
  if (!mediaId) throw new Error(`INIT ${initR.status}: ${JSON.stringify(initJ).slice(0, 300)}`);

  const CH = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < buffer.length; i += CH, seg++) {
    const chunk = buffer.subarray(i, Math.min(i + CH, buffer.length));
    const fd = new FormData();
    fd.append('command', 'APPEND'); fd.append('media_id', mediaId); fd.append('segment_index', String(seg));
    fd.append('media', new Blob([chunk]), 'chunk');
    const ap = await fetch(UPLOAD, { method: 'POST', headers: { authorization: authHeader('POST', UPLOAD, {}) }, body: fd });
    if (ap.status >= 300) throw new Error(`APPEND ${ap.status}: ${(await ap.text()).slice(0, 200)}`);
  }

  const finP = { command: 'FINALIZE', media_id: mediaId };
  const finR = await fetch(UPLOAD, { method: 'POST', headers: { authorization: authHeader('POST', UPLOAD, finP), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(finP) });
  const finJ = await finR.json();
  if (finJ.errors) throw new Error(`FINALIZE ${finR.status}: ${JSON.stringify(finJ.errors).slice(0, 200)}`);
  let info = finJ.processing_info;
  for (let n = 0; info && (info.state === 'pending' || info.state === 'in_progress') && n < 30; n++) {
    await sleep((info.check_after_secs || 2) * 1000);
    const stP = { command: 'STATUS', media_id: mediaId };
    const stR = await fetch(`${UPLOAD}?${new URLSearchParams(stP)}`, { headers: { authorization: authHeader('GET', UPLOAD, stP) } });
    info = (await stR.json()).processing_info;
  }
  if (info && info.state === 'failed') throw new Error('x_media_processing_failed');
  return mediaId;
}

export async function postX({ text, mediaUrl = '', mediaType = 'text' }) {
  const body = String(text || '').slice(0, 280);
  if (!body) throw new Error('empty_text');
  let mediaIds;
  if (mediaUrl && mediaType !== 'text') {
    const mr = await fetch(mediaUrl);
    if (!mr.ok) throw new Error(`fetch_media_${mr.status}`);
    const buf = Buffer.from(await mr.arrayBuffer());
    const mime = mr.headers.get('content-type') || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
    mediaIds = [await uploadMedia(buf, mime)];
  }
  const url = 'https://api.twitter.com/2/tweets';
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: authHeader('POST', url), 'content-type': 'application/json' },
    body: JSON.stringify(mediaIds ? { text: body, media: { media_ids: mediaIds } } : { text: body }),
  });
  const j = await r.json();
  if (!r.ok || !j.data) throw new Error(`TWEET ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { id: j.data.id };
}
