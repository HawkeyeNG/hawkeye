// TikTok integration — Content Posting API (Direct Post) for Hawkeye's OWN
// official account. Credential-gated: everything no-ops until TIKTOK_CLIENT_KEY /
// TIKTOK_CLIENT_SECRET are set (from the TikTok developer app). The owner connects
// the account once via OAuth (video.publish scope); the token is stored in the
// social_tokens table and refreshed as needed. No third-party user data is touched.
import { db } from '../db.js';
import { config } from '../config.js';

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const SCOPE = 'video.publish';

export const tiktokEnabled = () => Boolean(config.tiktokClientKey && config.tiktokClientSecret);

// Step 1 — the URL we send the owner to, to authorize Hawkeye's app.
export function authUrl(state) {
  const q = new URLSearchParams({
    client_key: config.tiktokClientKey,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: config.tiktokRedirectUri,
    state,
  });
  return `${AUTH}?${q.toString()}`;
}

function saveToken(t) {
  const now = Date.now();
  db.prepare(`INSERT INTO social_tokens
     (provider, access_token, refresh_token, open_id, scope, expires_at, refresh_expires_at, updated_at)
     VALUES ('tiktok', @a, @r, @o, @s, @e, @re, @u)
     ON CONFLICT(provider) DO UPDATE SET
       access_token=@a, refresh_token=@r, open_id=@o, scope=@s, expires_at=@e, refresh_expires_at=@re, updated_at=@u`)
    .run({
      a: t.access_token, r: t.refresh_token || null, o: t.open_id || null, s: t.scope || SCOPE,
      e: now + (Number(t.expires_in) || 0) * 1000, re: now + (Number(t.refresh_expires_in) || 0) * 1000, u: now,
    });
}

export function tiktokStatus() {
  const row = db.prepare("SELECT open_id, scope, expires_at, refresh_expires_at, updated_at FROM social_tokens WHERE provider = 'tiktok'").get();
  return { enabled: tiktokEnabled(), connected: Boolean(row && row.expires_at), ...(row || {}) };
}

// Step 2 — exchange the OAuth code for tokens and store them.
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_key: config.tiktokClientKey,
    client_secret: config.tiktokClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.tiktokRedirectUri,
  });
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || 'token_exchange_failed');
  saveToken(j);
  return { open_id: j.open_id, scope: j.scope };
}

async function accessToken() {
  const row = db.prepare("SELECT * FROM social_tokens WHERE provider = 'tiktok'").get();
  if (!row || !row.access_token) throw new Error('not_connected');
  if (row.expires_at && row.expires_at - Date.now() > 60_000) return row.access_token;
  // refresh
  if (!row.refresh_token) throw new Error('token_expired_no_refresh');
  const body = new URLSearchParams({
    client_key: config.tiktokClientKey,
    client_secret: config.tiktokClientSecret,
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  });
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || 'refresh_failed');
  saveToken(j);
  return j.access_token;
}

// Step 3 — Direct Post a video by UPLOADING THE FILE (FILE_UPLOAD). This needs no
// domain verification (unlike PULL_FROM_URL) — our server sends the bytes straight
// to TikTok. Before audit, TikTok requires privacy_level SELF_ONLY. Flow: init
// returns publish_id + upload_url, then we PUT the video (one chunk if <64MB, else
// 10MB chunks) with a Content-Range per chunk.
const CHUNK = 10 * 1024 * 1024; // 10 MB
export async function directPostFile({ title, buffer, privacy = 'SELF_ONLY', mime = 'video/mp4' }) {
  const token = await accessToken();
  const size = buffer.length;
  if (!size) throw new Error('empty_video');
  // A video under 64MB may be sent as a single chunk; otherwise split into 10MB chunks.
  const single = size < 64 * 1024 * 1024;
  const chunkSize = single ? size : CHUNK;
  const totalChunks = single ? 1 : Math.ceil(size / chunkSize);

  const initRes = await fetch(INIT, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: { title: String(title || '').slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: totalChunks },
    }),
  });
  const j = await initRes.json();
  const publishId = j.data && j.data.publish_id;
  const uploadUrl = j.data && j.data.upload_url;
  if (!publishId || !uploadUrl) throw new Error((j.error && (j.error.message || j.error.code)) || 'post_init_failed');

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, size) - 1;
    const part = buffer.subarray(start, end + 1);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': mime,
        'content-length': String(part.length),
        'content-range': `bytes ${start}-${end}/${size}`,
      },
      body: part,
    });
    if (put.status >= 300) throw new Error(`chunk_upload_failed_${put.status}`);
  }
  return { publishId };
}

export async function postStatus(publishId) {
  const token = await accessToken();
  const r = await fetch(STATUS, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const j = await r.json();
  return j.data || j;
}
