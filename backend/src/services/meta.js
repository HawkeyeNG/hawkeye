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
    s.igLinked = Boolean(j.instagram_business_account);
    s.ok = true;
  } catch (e) { s.ok = false; s.error = String(e.message || e); }
  return s;
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
  if (!config.metaIgUserId) throw new Error('no_ig_user_id');
  if (!mediaUrl) throw new Error('media_url_required');
  const params = mediaType === 'video'
    ? { media_type: 'REELS', video_url: mediaUrl, caption }
    : { image_url: mediaUrl, caption };
  const container = await graph(`${config.metaIgUserId}/media`, params);
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
  const pub = await graph(`${config.metaIgUserId}/media_publish`, { creation_id: creationId });
  return { ig: { id: pub.id || null, creationId } };
}
