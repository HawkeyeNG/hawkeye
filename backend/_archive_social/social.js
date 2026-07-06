// Social publishing for approved incidents (@HawkEyeNGBot). Triggered ONLY manually
// from the owner review console — never automatically. X/Twitter is fully wired
// (OAuth 1.0a: media upload + tweet create); Instagram/TikTok remain scaffolds.
// With no tokens set, every network reports 'skipped:no_tokens' and the incident
// is still published to the on-site public feed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { postVideo as tiktokPost, status as tiktokStatus } from './tiktok.js';

const PUBLIC_BASE = 'https://hawkeye.com.ng';
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

function caption(incident) {
  const KIND = {
    violence: 'Violence', ballot_snatching: 'Ballot snatching', vote_buying: 'Vote-buying',
    intimidation: 'Voter intimidation', bvas_failure: 'BVAS failure', late_materials: 'Late materials',
    obstruction: 'Obstruction of observers', other: 'Irregularity',
  };
  const where = incident.state ? ` in ${incident.state}` : '';
  const desc = (incident.description || '').slice(0, 200);
  return `⚠️ ${KIND[incident.kind] || 'Incident'} reported${where}. ${desc}\n\nReported via Hawkeye observers. #HawkEyeNGBot #NigeriaDecides`;
}

// ---------- OAuth 1.0a (user context) ----------
const enc = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function xCreds() {
  const s = config.social;
  return { consumerKey: s.xApiKey, consumerSecret: s.xApiSecret, token: s.xAccessToken, tokenSecret: s.xAccessSecret };
}
function hasX() {
  const c = xCreds();
  return c.consumerKey && c.consumerSecret && c.token && c.tokenSecret;
}
// `signed` = params to fold into the signature (query params, or urlencoded body
// fields). For multipart bodies pass {} — only the oauth_* params are signed.
function authHeader(method, baseUrl, signed = {}) {
  const c = xCreds();
  const oauth = {
    oauth_consumer_key: c.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.token,
    oauth_version: '1.0',
  };
  const all = { ...signed, ...oauth };
  const paramStr = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&');
  const base = [method.toUpperCase(), enc(baseUrl), enc(paramStr)].join('&');
  const key = `${enc(c.consumerSecret)}&${enc(c.tokenSecret)}`;
  const sig = crypto.createHmac('sha1', key).update(base).digest('base64');
  const header = { ...oauth, oauth_signature: sig };
  return 'OAuth ' + Object.keys(header).sort().map((k) => `${enc(k)}="${enc(header[k])}"`).join(', ');
}

const UPLOAD = 'https://upload.twitter.com/1.1/media/upload.json';

async function uploadImage(buffer, mime) {
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: mime }));
  const r = await fetch(UPLOAD, { method: 'POST', headers: { authorization: authHeader('POST', UPLOAD) }, body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(`media ${r.status}: ${JSON.stringify(j).slice(0, 120)}`);
  return j.media_id_string;
}

async function uploadVideo(buffer, mime) {
  // INIT (urlencoded — params signed)
  const initP = { command: 'INIT', total_bytes: String(buffer.length), media_type: mime, media_category: 'tweet_video' };
  let r = await fetch(UPLOAD, {
    method: 'POST',
    headers: { authorization: authHeader('POST', UPLOAD, initP), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(initP),
  });
  let j = await r.json();
  if (!r.ok) throw new Error(`init ${r.status}: ${JSON.stringify(j).slice(0, 120)}`);
  const mediaId = j.media_id_string;

  // APPEND (multipart — only oauth signed), 4 MB chunks
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < buffer.length; i += CHUNK, seg++) {
    const form = new FormData();
    form.append('command', 'APPEND');
    form.append('media_id', mediaId);
    form.append('segment_index', String(seg));
    form.append('media', new Blob([buffer.subarray(i, i + CHUNK)], { type: 'application/octet-stream' }));
    r = await fetch(UPLOAD, { method: 'POST', headers: { authorization: authHeader('POST', UPLOAD) }, body: form });
    if (!r.ok) throw new Error(`append ${seg} ${r.status}`);
  }

  // FINALIZE + poll STATUS until video processing completes
  const finP = { command: 'FINALIZE', media_id: mediaId };
  r = await fetch(UPLOAD, {
    method: 'POST',
    headers: { authorization: authHeader('POST', UPLOAD, finP), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(finP),
  });
  j = await r.json();
  if (!r.ok) throw new Error(`finalize ${r.status}`);
  let info = j.processing_info;
  for (let tries = 0; info && info.state !== 'succeeded' && tries < 20; tries++) {
    if (info.state === 'failed') throw new Error('video processing failed');
    await new Promise((res) => setTimeout(res, (info.check_after_secs || 3) * 1000));
    const q = { command: 'STATUS', media_id: mediaId };
    const sr = await fetch(`${UPLOAD}?${new URLSearchParams(q)}`, { headers: { authorization: authHeader('GET', UPLOAD, q) } });
    info = (await sr.json()).processing_info;
  }
  return mediaId;
}

async function postTweet(text, mediaIds) {
  const url = 'https://api.twitter.com/2/tweets';
  const body = { text };
  if (mediaIds?.length) body.media = { media_ids: mediaIds };
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: authHeader('POST', url), 'content-type': 'application/json' }, // JSON body not signed
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`tweet ${r.status}: ${JSON.stringify(j).slice(0, 140)}`);
  return j.data?.id;
}

// X allows up to 4 images OR a single video per post.
async function postToX(incident, media) {
  const items = media.map((m) => ({ ...m, disk: path.join(config.uploadDir, m.file), ext: (m.file.split('.').pop() || '').toLowerCase() }));
  const video = items.find((m) => m.type === 'video');
  const mediaIds = [];
  if (video) {
    mediaIds.push(await uploadVideo(fs.readFileSync(video.disk), MIME[video.ext] || 'video/mp4'));
  } else {
    for (const im of items.filter((m) => m.type === 'image').slice(0, 4)) {
      mediaIds.push(await uploadImage(fs.readFileSync(im.disk), MIME[im.ext] || 'image/jpeg'));
    }
  }
  const id = await postTweet(caption(incident), mediaIds);
  return `posted:${id}`;
}

// Plain text tweet (no media) — used by the daily ledger anchor.
export async function tweetText(text) {
  if (!hasX()) return 'skipped:no_tokens';
  try { return `posted:${await postTweet(text, [])}`; }
  catch (e) { return 'error:' + e.message.slice(0, 80); }
}

// App-only (OAuth2 client_credentials) — validates ONLY the consumer API Key/Secret,
// independent of the access token. Isolates which half of the credential set is bad.
async function consumerValid() {
  const c = xCreds();
  const basic = Buffer.from(`${enc(c.consumerKey)}:${enc(c.consumerSecret)}`).toString('base64');
  try {
    const r = await fetch('https://api.twitter.com/oauth2/token', {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.token_type === 'bearer' ? 'valid' : `invalid (${r.status} ${j.errors?.[0]?.message || j.error || ''})`.slice(0, 80);
  } catch (e) { return 'error:' + e.message.slice(0, 40); }
}

// Verify the X credentials without posting: GET /2/users/me + isolate consumer keys.
export async function verifyX() {
  if (!hasX()) return { configured: false };
  const apiKeys = await consumerValid(); // consumer pair check
  try {
    const url = 'https://api.twitter.com/2/users/me';
    const r = await fetch(url, { headers: { authorization: authHeader('GET', url) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { configured: true, ok: false, apiKeys, error: `${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
    return { configured: true, ok: true, apiKeys, username: j.data?.username, name: j.data?.name };
  } catch (e) { return { configured: true, ok: false, apiKeys, error: e.message.slice(0, 140) }; }
}

// media = [{ file: 'incidents/xx.jpg', type: 'image'|'video' }]
export async function publishToSocial(incident, media = []) {
  const out = {};
  if (hasX()) {
    try { out.x = await postToX(incident, media); }
    catch (e) { out.x = 'error:' + e.message.slice(0, 80); }
  } else {
    out.x = 'skipped:no_tokens';
  }
  out.instagram = config.social.instagramToken ? 'skipped:not_implemented' : 'skipped:no_tokens';

  // TikTok Content Posting — Direct Post the first video via PULL_FROM_URL.
  const video = media.find((m) => m.type === 'video');
  const tk = tiktokStatus();
  if (!tk.configured) out.tiktok = 'skipped:no_tokens';
  else if (!tk.connected) out.tiktok = 'skipped:not_connected';
  else if (!video) out.tiktok = 'skipped:no_video';
  else {
    try { out.tiktok = await tiktokPost(`${PUBLIC_BASE}/uploads/${video.file}`, caption(incident)); }
    catch (e) { out.tiktok = 'error:' + e.message.slice(0, 100); }
  }
  return { text: caption(incident), mediaUrls: media.map((m) => `${PUBLIC_BASE}/uploads/${m.file}`), results: out };
}
