// TikTok Content Posting integration (Login Kit OAuth + Direct Post).
// Owner connects @HawkEyeNGBot once via OAuth; the token is stored in
// social_tokens and used to Direct-Post approved incident videos. In a sandbox
// (unaudited) app, posts must be SELF_ONLY. Video is pulled by TikTok from a
// public URL on our domain-verified site (PULL_FROM_URL).
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const SCOPE = 'user.info.basic,video.publish';

export function tiktokConfigured() {
  return Boolean(config.tiktok.clientKey && config.tiktok.clientSecret);
}

// CSRF state for the OAuth round-trip (short-lived, in-memory).
const states = new Map();
export function authorizeUrl() {
  const state = crypto.randomBytes(12).toString('hex');
  states.set(state, Date.now() + 600_000);
  const p = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: config.tiktok.redirectUri,
    state,
  });
  return `${AUTH}?${p}`;
}
export function checkState(state) {
  const exp = states.get(state);
  states.delete(state);
  return exp && exp > Date.now();
}

function store(t) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO social_tokens (provider, access_token, refresh_token, open_id, scope, expires_at, refresh_expires_at, updated_at)
    VALUES ('tiktok', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      access_token=excluded.access_token, refresh_token=excluded.refresh_token,
      open_id=excluded.open_id, scope=excluded.scope, expires_at=excluded.expires_at,
      refresh_expires_at=excluded.refresh_expires_at, updated_at=excluded.updated_at`)
    .run(t.access_token, t.refresh_token, t.open_id || null, t.scope || SCOPE,
      now + (t.expires_in || 0) * 1000, now + (t.refresh_expires_in || 0) * 1000, now);
}

async function tokenReq(params) {
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, ...params }),
  });
  const j = await r.json();
  if (j.error && j.error !== 'ok' && !j.access_token) throw new Error(`token ${j.error}: ${j.error_description || ''}`);
  return j;
}

// Exchange the OAuth code for tokens (called from the public callback).
export async function exchangeCode(code) {
  const j = await tokenReq({ code, grant_type: 'authorization_code', redirect_uri: config.tiktok.redirectUri });
  store(j);
  return { open_id: j.open_id, scope: j.scope };
}

// A valid access token, refreshing if within 5 min of expiry.
async function accessToken() {
  const row = db.prepare("SELECT * FROM social_tokens WHERE provider='tiktok'").get();
  if (!row) throw new Error('not_connected');
  if (row.expires_at && row.expires_at - Date.now() > 300_000) return row.access_token;
  const j = await tokenReq({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
  store(j);
  return j.access_token;
}

export function status() {
  const row = db.prepare("SELECT open_id, updated_at FROM social_tokens WHERE provider='tiktok'").get();
  return { configured: tiktokConfigured(), connected: Boolean(row), openId: row?.open_id || null };
}

// Direct-post a video by public URL. Returns 'posted:<publish_id>' or throws.
export async function postVideo(videoUrl, title) {
  const token = await accessToken();
  const r = await fetch(INIT, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: { title: title.slice(0, 2200), privacy_level: 'SELF_ONLY', disable_comment: true },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    }),
  });
  const j = await r.json();
  if (j.error && j.error.code && j.error.code !== 'ok') {
    throw new Error(`${j.error.code}: ${j.error.message || ''}`.slice(0, 120));
  }
  return `posted:${j.data?.publish_id || 'ok'}`;
}
