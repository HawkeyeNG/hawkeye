// Meta (Facebook Page + Instagram Business) posting via the Graph API. Posts
// Hawkeye's OWN content to its OWN Page/IG account. Credential-gated: no-ops until
// META_PAGE_TOKEN (+ META_PAGE_ID / META_IG_USER_ID) are set. The Page token,
// derived from a long-lived user token, is effectively non-expiring — so unlike
// TikTok there is no interactive OAuth step here; the owner supplies the token.
//
// Media must be a PUBLIC url (IG has no direct file upload) — host on
// hawkeye.com.ng/media/. Meta's fetcher is `facebookexternalhit`, which is NOT in
// the Cloudflare AI-bot block, so this works with bot protection left on.
import { config } from '../config.js';

const base = () => `https://graph.facebook.com/${config.metaGraphVersion}`;

export const metaEnabled = () => Boolean(config.metaPageToken && (config.metaPageId || config.metaIgUserId));

// Resolve the Instagram Business user id. Prefer an explicit META_IG_USER_ID; else
// auto-derive it from the Page's linked instagram_business_account (cached). This
// is the correct IG id — NOT the Facebook Page id, which is a common mix-up.
let cachedIgId = null;
export async function resolveIgId() {
  if (config.metaIgUserId) return config.metaIgUserId;
  if (cachedIgId) return cachedIgId;
  if (!config.metaPageId) return null;
  const j = await graph(config.metaPageId, { fields: 'instagram_business_account' }, 'GET');
  cachedIgId = (j.instagram_business_account && j.instagram_business_account.id) || null;
  return cachedIgId;
}

async function graph(path, params, method = 'POST') {
  const body = new URLSearchParams({ ...params, access_token: config.metaPageToken });
  const url = `${base()}/${path}`;
  const r = method === 'GET'
    ? await fetch(`${url}?${body.toString()}`)
    : await fetch(url, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code || ''}${j.error.error_subcode ? '/' + j.error.error_subcode : ''}: ${j.error.message || 'graph_error'}`);
  return j;
}

export async function metaStatus() {
  const s = { enabled: metaEnabled(), pageId: config.metaPageId || null, igUserId: config.metaIgUserId || null, hasToken: Boolean(config.metaPageToken) };
  if (!s.enabled) return s;
  try {
    // Live probe: confirm the token resolves the Page + linked IG account.
    const j = await graph(config.metaPageId || 'me', { fields: 'name,instagram_business_account' }, 'GET');
    s.pageName = j.name;
    const igId = (j.instagram_business_account && j.instagram_business_account.id) || null;
    s.igLinked = Boolean(igId);
    s.igUserId = config.metaIgUserId || igId; // auto-derived if not set explicitly
    if (igId) cachedIgId = igId;
    s.ok = true;
  } catch (e) { s.ok = false; s.error = String(e.message || e); }
  return s;
}

// Diagnostic: which IG-link field is populated + what scopes the token has. The
// Content Publishing API needs `instagram_business_account` (not the newer
// `connected_instagram_account`) and `instagram_basic`+`instagram_content_publish`.
export async function metaDiag() {
  const out = {};
  // What does the token resolve to? (Page id+name for a Page token; a user for a
  // user token.) Diagnoses "wrong token type / wrong page" without exposing it.
  try { out.me = await graph('me', { fields: 'id,name' }, 'GET'); }
  catch (e) { out.meError = String(e.message || e); }
  out.configuredPageId = config.metaPageId || null;
  try { out.page = await graph(config.metaPageId, { fields: 'name,instagram_business_account,connected_instagram_account' }, 'GET'); }
  catch (e) { out.pageError = String(e.message || e); }
  try { out.permissions = (await graph('me/permissions', {}, 'GET')).data; }
  catch (e) { out.permError = String(e.message || e); }
  return out;
}

// Facebook Page. text/link -> /feed ; image -> /photos ; video -> /videos.
export async function postFacebook({ message = '', mediaUrl = '', mediaType = 'text', link = '' }) {
  if (!config.metaPageId) throw new Error('no_page_id');
  if (mediaType === 'video' && mediaUrl) {
    const j = await graph(`${config.metaPageId}/videos`, { file_url: mediaUrl, description: message });
    return { fb: { id: j.id || j.post_id || null } };
  }
  if (mediaType === 'image' && mediaUrl) {
    const j = await graph(`${config.metaPageId}/photos`, { url: mediaUrl, caption: message });
    return { fb: { id: j.post_id || j.id || null } };
  }
  const j = await graph(`${config.metaPageId}/feed`, link ? { message, link } : { message });
  return { fb: { id: j.id || null } };
}

// Instagram Business — 2 steps: create media container, then publish. Video/Reels
// containers process asynchronously, so poll status_code until FINISHED first.
export async function postInstagram({ caption = '', mediaUrl = '', mediaType = 'image' }) {
  const igId = await resolveIgId();
  if (!igId) throw new Error('instagram_not_linked_to_page');
  if (!mediaUrl) throw new Error('media_url_required');
  const params = mediaType === 'video'
    ? { media_type: 'REELS', video_url: mediaUrl, caption }
    : { image_url: mediaUrl, caption };
  const container = await graph(`${igId}/media`, params);
  const creationId = container.id;
  if (!creationId) throw new Error('container_failed');

  if (mediaType === 'video') {
    for (let i = 0; i < 30; i++) { // up to ~90s
      await new Promise((r) => setTimeout(r, 3000));
      const st = await graph(creationId, { fields: 'status_code' }, 'GET');
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`ig_container_${st.status_code}`);
      if (i === 29) throw new Error('ig_container_timeout');
    }
  }
  const pub = await graph(`${igId}/media_publish`, { creation_id: creationId });
  return { ig: { id: pub.id || null, creationId } };
}
