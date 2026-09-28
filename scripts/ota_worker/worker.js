// Hawkeye native OTA: the manifest dispatcher for self-hosted Expo Updates (design D9).
//
// WHY A WORKER AND NOT PLAIN R2. Every response body is static and signed ahead of time by
// scripts/ota_publish_self.sh (no nonce, nothing per request). Two things are not static:
//   1. Selection. Every build asks ONE url (app.json updates.url) and says which update it can run
//      only in request headers: expo-platform, expo-runtime-version, expo-channel-name. R2 cannot
//      route on headers, and a Cloudflare URL-rewrite rule cannot build a path from header values.
//   2. Protocol headers. The client rejects a response without `expo-protocol-version`
//      ("Legacy manifests are no longer supported"); R2 cannot set arbitrary response headers.
// So this Worker only maps headers -> an R2 key and adds the protocol headers. It holds no key
// and signs nothing: if it were compromised it could not forge an update, only withhold one or
// replay an older signed one (which the client ignores unless it is newer than what it runs).
// Assets are normally NOT served here: they are immutable, content-addressed objects fetched
// straight from the bucket's public custom domain (free, cached by Cloudflare). If the Worker is
// ever deployed as the hostname's Custom Domain instead of a /manifest route, it serves
// /assets/* and /updates/* from the binding too (each then counts as a Worker request).
//
// R2 layout (bucket bound as OTA_BUCKET):
//   manifests/<channel>/<runtime>/<platform>   the CURRENT response: a signed multipart/mixed
//                                              body (manifest, or a rollBackToEmbedded directive)
//   updates/<channel>/<runtime>/<platform>/<id>/...   the archive of every published response
//   assets/<sha256-hex>.<ext>                         bundles and images, immutable
// No object for the key = 204: "no update", the client keeps what it runs.
//
// Deploy: scripts/ota_worker/wrangler.toml (route updates.hawkeye.com.ng/manifest*).
// Tested locally by scripts/ota_test.sh through `node scripts/ota_manifest.mjs serve`.

const PLATFORMS = new Set(['ios', 'android']);
const RUNTIME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/; // "1.0.9"; never a slash, so never another key
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_CHANNEL = 'production';
// Edge copy of each manifest, per data centre. A publish or a rollback reaches every device
// within this many seconds; R2 reads stay near zero however many devices check on launch.
const EDGE_TTL_SECONDS = 60;

function protocolHeaders(extra) {
  return {
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
    // The body varies by request headers under one URL: nothing downstream may cache it.
    'cache-control': 'private, max-age=0',
    ...extra,
  };
}

function fail(status, message) {
  return new Response(`${message}\n`, {
    status,
    headers: protocolHeaders({ 'content-type': 'text/plain; charset=utf-8' }),
  });
}

async function lookup(env, ctx, cacheUrl, key) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheUrl);
    if (hit) return hit;
  }
  const obj = await env.OTA_BUCKET.get(key);
  // A missing key is cached too (as an empty 200 marked x-ota-none): a device base checking on
  // every launch must not turn into one R2 read per launch while nothing is published.
  const res = obj
    ? new Response(obj.body, {
        headers: {
          'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || '',
          'cache-control': `public, max-age=${EDGE_TTL_SECONDS}`,
        },
      })
    : new Response('', {
        headers: { 'x-ota-none': '1', 'cache-control': `public, max-age=${EDGE_TTL_SECONDS}` },
      });
  if (cache) {
    const copy = res.clone();
    const put = cache.put(cacheUrl, copy);
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

// Only needed if the Worker is deployed as the hostname's Custom Domain (every path) instead of a
// route on /manifest in front of the bucket's custom domain: then it serves the objects itself.
const OBJECT_PATH = /^\/((?:assets|updates)\/[0-9A-Za-z._/-]{1,300})$/;
async function object(request, env, key) {
  if (key.includes('..') || key.includes('//')) return fail(404, 'not found');
  const obj = await env.OTA_BUCKET.get(key);
  if (!obj) return fail(404, 'not found');
  const m = obj.httpMetadata || {};
  const headers = { 'content-type': m.contentType || 'application/octet-stream' };
  if (m.cacheControl) headers['cache-control'] = m.cacheControl;
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'GET only');
    const objectPath = OBJECT_PATH.exec(url.pathname);
    if (objectPath) return object(request, env, objectPath[1]);
    if (url.pathname !== '/manifest') return fail(404, 'not found');

    const h = request.headers;
    if (h.get('expo-protocol-version') !== '1') return fail(406, 'expo-protocol-version: 1 required');
    // Only the multipart form is published: it is the only one that carries the signature in
    // the body (the JSON form needs an expo-signature RESPONSE header) and directives.
    if (!/(^|,)\s*multipart\/mixed\b/i.test(h.get('accept') || '')) return fail(406, 'accept must include multipart/mixed');
    const platform = h.get('expo-platform') || '';
    if (!PLATFORMS.has(platform)) return fail(400, 'expo-platform must be ios or android');
    const runtime = h.get('expo-runtime-version') || '';
    if (!RUNTIME.test(runtime)) return fail(400, 'bad expo-runtime-version');
    const channel = h.get('expo-channel-name') || DEFAULT_CHANNEL;
    if (!CHANNEL.test(channel)) return fail(400, 'bad expo-channel-name');

    const key = `manifests/${channel}/${runtime}/${platform}`;
    const res = await lookup(env, ctx, `https://${url.host}/__ota_cache/${key}`, key);
    const type = res.headers.get('content-type') || '';
    if (res.headers.get('x-ota-none') === '1') return new Response(null, { status: 204, headers: protocolHeaders() });
    if (!/^multipart\/mixed;\s*boundary=/i.test(type)) return fail(500, 'published object is not multipart/mixed');
    return new Response(request.method === 'HEAD' ? null : res.body, {
      status: 200,
      headers: protocolHeaders({ 'content-type': type }),
    });
  },
};
