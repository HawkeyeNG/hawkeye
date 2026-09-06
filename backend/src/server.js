import express from 'express';
import { config, envFileStatus } from './config.js';
import {
  DRIVER as blobDriver, isBlobKey, publicUrl as blobPublicUrl,
  getBlob as getBlobBytes, assertConfigured as assertBlobConfigured,
} from './services/blobstore.js';
import { db } from './db.js';
import { bootstrapData } from './services/register.js';
import { observersRouter } from './routes/observers.js';
import { pollingUnitsRouter } from './routes/pollingUnits.js';
import { submissionsRouter } from './routes/submissions.js';
import { nationalRouter } from './routes/national.js';
import { telegramRouter } from './routes/telegram.js';
import { mappingRouter } from './routes/mapping.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { trainingRouter } from './routes/training.js';
import { integrityRouter } from './routes/integrity.js';
import { incidentsRouter } from './routes/incidents.js';
import { adminRouter } from './routes/admin.js';
import { collationRouter } from './routes/collation.js';
import { assistantRouter } from './routes/assistant.js';
import { docketRouter } from './routes/docket.js';
import { politicalRouter } from './routes/political.js';
import { pushRouter } from './routes/push.js';
import { notificationsRouter } from './routes/notifications.js';
import { tiktokRouter } from './routes/tiktok.js';
import { metaRouter } from './routes/meta.js';
import { socialRouter } from './routes/social.js';
import { practiceRouter } from './routes/practice.js';
import { resolveDueCases } from './services/docket.js';
import { securityHeaders, makeLimiter, concurrencyLimit } from './services/security.js';
import { runForensics, recheckCollations } from './services/integrity.js';
import { runBackup } from './services/backup.js';
import { irevScan } from './services/irev.js';
import { runAnchor } from './services/anchor.js';
import { pushConfigured, prunePermanentlyUndeliverable, freshUndeliverable } from './services/push.js';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// Origin lock (dormant until a secret is set in .env): GO54 fronts the origin
// with its own proxy, so an Apache IP allowlist can't tell our Cloudflare zone's
// traffic from direct scans — instead the edge stamps a secret header on every
// request and we reject anything without it.
//
// TWO HEADERS, because the two edges disagree on the name and only one of them
// lets us choose it:
//   Cloudflare  X-Origin-Auth        set by a Transform Rule (we pick the name)
//   Shield      Shield-Proxy-Secret  Defenses -> Proxy Header; the NAME IS FIXED
//                                    by Google and cannot be changed
// Accepting both is what makes Project Shield usable as a second edge at all.
// Without it, cutting over to Shield would 403 every request — which is the
// failure docs/PROJECT-SHIELD-VS-CLOUDFLARE.md was written to prevent.
//
// Each header is only honoured if ITS OWN secret is configured, so setting one
// never weakens the other, and an unset secret can never be matched by a missing
// header. The lock arms if either is present.
if (config.originAuthSecret || config.shieldProxySecret) {
  app.use((req, res, next) => {
    if (config.originAuthSecret
      && req.headers['x-origin-auth'] === config.originAuthSecret) return next();
    if (config.shieldProxySecret
      && req.headers['shield-proxy-secret'] === config.shieldProxySecret) return next();
    res.status(403).json({ error: 'origin_locked' });
  });
}

app.use(securityHeaders);
/**
 * MOVED-UP NOTE: this block sits ABOVE every route on purpose. It was first
 * placed down beside the static handlers, where the OPTIONS preflight passed
 * (nothing else answers OPTIONS) while ordinary GETs did not — the API routers
 * had already replied and returned before the middleware ran. A CORS check that
 * passes its preflight and then fails every real request is the worst version
 * of this bug, because the preflight is what people test.
 *
 * DEV-ONLY CORS, for running the native app in a desktop browser.
 *
 * `npm run web` in native/ serves the real React Native app through
 * react-native-web at localhost:8081 — or another port, since 8081 is inside
 * a Windows reserved range and cannot be bound there. On a phone the app's
 * API calls are not browser requests and the same-origin policy does not
 * apply; through react-native-web they are, and every call is cross-origin.
 *
 * With no Access-Control-Allow-Origin the browser blocks the response before
 * any app code sees it, and the app can only report "network error, try again"
 * — indistinguishable from the connection actually being down, which is exactly
 * how this presented. (Production also answers the OPTIONS preflight with a
 * 404, so the request never even reaches a handler.)
 *
 * LOCALHOST ONLY, AND NOT IN PRODUCTION. Widening CORS on a public
 * election-integrity API is not something to do for developer convenience, so
 * this is gated twice: the origin must be a loopback address, and the process
 * must not be running in production. A deployed instance therefore behaves
 * exactly as it does today.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
if (config.env !== 'production') {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && LOOPBACK_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      // Echo whatever the preflight asks for, rather than keeping a list by hand.
      // The app sends x-device-id on /login and /verify (device binding) and that
      // was missing here, so the preflight passed and the real request was blocked
      // — surfacing in the app as 'Network error - try again' with NOTHING in the
      // server log, because a blocked response never reaches a handler. Any header
      // added later would fail the same silent way. Safe to reflect: this block is
      // already gated to loopback origins on a non-production process.
      const asked = req.headers['access-control-request-headers'];
      res.setHeader(
        'Access-Control-Allow-Headers',
        asked || 'content-type, authorization, x-device-id, x-observer-token, x-admin-pass',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      // Terminate the preflight here: falling through reaches the SPA catch-all,
      // which answers 404 and fails the browser's check.
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  });
}

app.use(express.json({ limit: '100kb' }));

// Rate limits — CGNAT-aware: Nigerian carriers put THOUSANDS of users behind one
// public IP, so per-IP caps must be generous or an influencer-driven signup surge
// / election-day crowd gets blocked. These are coarse anti-flood backstops only;
// real DDoS/bot defence is Cloudflare in front. Per-identity abuse is handled
// elsewhere (per-phone OTP TTL+attempts, one-report-per-device-per-race, etc.).
app.use('/api/observers/register', makeLimiter({ windowMs: 600_000, max: 600, name: 'register' }));
app.use('/api/observers/verify', makeLimiter({ windowMs: 600_000, max: 800, name: 'verify' }));
app.use('/api/observers/resume', makeLimiter({ windowMs: 600_000, max: 1500, name: 'resume' }));
app.use('/api/observers/telegram-verify', makeLimiter({ windowMs: 600_000, max: 800, name: 'tg-verify' }));
app.use('/api/admin', makeLimiter({ windowMs: 600_000, max: 60, name: 'admin' })); // owner-only
// Upload paths run sharp/OCR — cap concurrency so a burst can't exhaust the
// shared host's CPU/RAM regardless of source IP spread.
app.use('/api/submissions', concurrencyLimit(4, 'submissions'), makeLimiter({ windowMs: 600_000, max: 500, name: 'submissions' }));
app.use('/api/incidents', concurrencyLimit(4, 'incidents'), makeLimiter({ windowMs: 600_000, max: 300, name: 'incidents' }));
app.use('/api/mappings', makeLimiter({ windowMs: 600_000, max: 600, name: 'mappings' }));
app.use('/api/collations', makeLimiter({ windowMs: 600_000, max: 300, name: 'collations' }));
app.use('/api/assistant', concurrencyLimit(3, 'assistant'), makeLimiter({ windowMs: 600_000, max: 120, name: 'assistant' }));
app.use('/api', makeLimiter({ windowMs: 600_000, max: 8000, name: 'api' }));

// `push` says only whether the three FCM env vars are present — a boolean, no
// secret. It exists so "did my .env actually land" is answerable without a
// deploy log. Whether the credential WORKS is /api/push/health (owner-only).
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'hawkeye',
    env: config.env,
    push: pushConfigured(),
    // Whether SMS OTP can actually be delivered right now. The sign-in form
    // reads this to decide whether to OFFER SMS at all: hard-coding the radio in
    // the page means the website, the APK and every cached copy can each
    // disagree with what the server can deliver, and offering a channel that
    // silently arrives over WhatsApp is worse than not offering it. One boolean,
    // no secret — same contract as `push` above.
    smsOtp: config.smsOtpEnabled,
    // Kept after the APP_ENV hunt that added it: a .env that silently fails to
    // load is indistinguishable from one whose values simply lost to the real
    // environment, and config.js swallows the error by design. One boolean here
    // turns "why is my config being ignored" into a single curl. No values.
    envFile: envFileStatus.loaded,
  }));
app.use('/api/observers', observersRouter);
app.use('/api', pollingUnitsRouter);
app.use('/api', submissionsRouter);
app.use('/api', nationalRouter);
app.use('/api', telegramRouter);
app.use('/api', mappingRouter);
app.use('/api', subscriptionsRouter);
app.use('/api', trainingRouter);
app.use('/api', integrityRouter);
app.use('/api', incidentsRouter);
app.use('/api', adminRouter);
app.use('/api', collationRouter);
app.use('/api', assistantRouter);
app.use('/api', docketRouter);
app.use('/api', politicalRouter);
app.use('/api', pushRouter);
app.use('/api', notificationsRouter);
app.use('/api', tiktokRouter);
app.use('/api', metaRouter);
app.use('/api', socialRouter);
app.use('/api', practiceRouter);
// Training sheet images: the originals are ~3-4 MB phone photos (3072x4096),
// far more than a labeller's screen needs, so serving them raw made the page
// crawl. Serve a cached ~1500px JPEG for VIEWING (built on first request, then
// instant). The OCR endpoint still reads the full-res original, so scoring is
// unaffected.
const trainRoot = path.join(path.dirname(config.dbPath), 'training');
const thumbRoot = path.join(trainRoot, '_view');
app.get(/^\/training\/(.+\.(?:jpe?g|png))$/i, async (req, res, next) => {
  const file = path.basename(req.params[0]);
  const src = path.join(trainRoot, file);
  if (!fs.existsSync(src)) return next();
  const thumb = path.join(thumbRoot, file.replace(/\.[^.]+$/, '.jpg'));
  try {
    if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(src).mtimeMs) {
      fs.mkdirSync(thumbRoot, { recursive: true });
      await sharp(src).rotate().resize({ width: 1500, withoutEnlargement: true })
        .jpeg({ quality: 76, mozjpeg: true }).toFile(thumb);
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.type('jpeg').sendFile(thumb);
  } catch { return next(); } // fall through to the original on any failure
});
/**
 * AUDIT-INTERNAL FILES ARE NOT PUBLIC.
 *
 * The line below serves the whole training directory, which is right for the
 * sheet images — they are INEC's own published documents — and wrong for the
 * audit's working notes. Three files written by the review console hold
 * material that belongs to an internal evidence base, not to the open web:
 *
 *   illegible.json   findings about the quality of the published record, with
 *                    the reviewer's name and the time they said it
 *   label_meta.json  free-text notes a labeller typed while reading a sheet
 *   streams.json     which sheets the audit singled out as suspect, which is a
 *                    map of where we think the problems are before any human
 *                    has confirmed a single one
 *
 * They are reachable through GET /api/training/meta, behind the admin
 * passphrase. Blocked with 404 rather than 403 so the endpoint does not
 * advertise that the files exist.
 *
 * NOTE: truth.json, sets.json, approved.json, dropped.json and boxes.json
 * remain public — they predate this and both review pages fetch them without
 * credentials. That is a deliberate limit on this change, not an endorsement.
 */
const AUDIT_INTERNAL = new Set(['illegible.json', 'label_meta.json', 'streams.json']);
app.use('/training', (req, res, next) => {
  if (AUDIT_INTERNAL.has(path.basename(req.path))) {
    return res.status(404).json({ error: 'not_found' });
  }
  return next();
});
// truth.json / sets.json and any non-image path fall through to the raw files.
app.use('/training', express.static(trainRoot));

// Evidence photos/videos are public audit artifacts — content-addressed,
// immutable. Harden the responses: nosniff + a sandbox CSP so a polyglot
// upload (a video that's also valid HTML/JS) can never execute as a document
// on our origin; media still loads fine as an <img>/<video> resource.
// CONTENT-ADDRESSED EVIDENCE, WHEREVER IT LIVES. Mounted BEFORE the static
// handler below so a `<sha256>.jpg` is answered from the blobstore while
// everything else under /uploads (incidents/, social/) still comes off disk.
//
// With BLOB_DRIVER=fs this does nothing at all — it falls straight through to
// the same express.static that has always served these files, byte for byte.
// With a bucket that has a public base, the origin never touches the bytes: it
// redirects and the CDN and the client do the rest. The URL a visitor uses does
// not change either way, which is what keeps the two shipped store apps and
// every installed PWA working.
app.get('/uploads/:key', async (req, res, next) => {
  const { key } = req.params;
  if (blobDriver === 'fs' || !isBlobKey(key)) return next();
  const url = blobPublicUrl(key);
  // 302, not 301: the bucket is an implementation detail we may move again, and
  // a permanent redirect would be cached in browsers we cannot reach.
  if (url) return res.redirect(302, url);
  try {
    const buf = await getBlobBytes(key);
    res.type('image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    return res.send(buf);
  } catch (e) {
    // A miss here is a genuinely absent object, not a routing problem — falling
    // through to express.static would turn it into a confusing 404 from a
    // directory that was never going to hold it.
    return res.status(404).json({ error: 'not_found' });
  }
});

app.use('/uploads', express.static(config.uploadDir, {
  immutable: true,
  maxAge: '1y',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  },
}));

/**
 * /get — ONE store link that sends each device to its own store.
 *
 * A broadcast that says "update from the store" needs a different destination
 * per platform, and the alternative was writing the notification twice and
 * targeting each half by platform. That is two chances to send the wrong copy to
 * the wrong people, and it does not survive a third platform. This is one URL in
 * one notification: the device is already telling us what it is, in every
 * request it makes.
 *
 * MUST BE REGISTERED BEFORE express.static, or a file named `get` would win.
 *
 * NOT an App Link. The app claims `/open` only (see app/.well-known/
 * assetlinks.json), so tapping this opens a browser, which hands off to the
 * store app — exactly what is wanted. Do NOT add /get to an intent filter: the
 * app intercepting its own "go to the store" link is a loop.
 *
 * 302, not 301: the store URLs may change, and a permanent redirect would be
 * cached by browsers past our ability to correct it.
 */
const STORE_ANDROID = 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer';
const STORE_IOS = 'https://apps.apple.com/app/id6804218478';
app.get('/get', (req, res) => {
  const ua = String(req.get('user-agent') || '');
  // iPadOS reports itself as Macintosh, so an iPad lands on the install page
  // rather than being guessed at — a wrong store is worse than a page that
  // offers both. Phones are what a push reaches, and they are unambiguous.
  if (/iPhone|iPod/i.test(ua)) return res.redirect(302, STORE_IOS);
  if (/Android/i.test(ua)) return res.redirect(302, STORE_ANDROID);
  // Desktop, iPad, a crawler, or a UA we do not know: the homepage's install
  // section carries both badges and the web-app route, and states plainly which
  // platforms have a store build.
  return res.redirect(302, '/index.html#install');
});

/**
 * /download — where a shared link lands.
 *
 * The in-app Share button (app/share.js, native/src/components/social-row.tsx)
 * sends this one address to everybody, so it has to be an address rather than a
 * filename: hawkeye.com.ng/download reads as a place, survives being typed from
 * memory, and does not change when the page behind it does.
 *
 * BEFORE express.static, and it has to be. `app/download/` is a real directory —
 * it holds the APKs the install dialog links to — so a request for /download
 * resolves to a directory with no index and 404s. The APKs are untouched:
 * /download/hawkeye-1.2-8.apk is a different path and still falls through to
 * the static mount below.
 */
app.get('/download', (_req, res) => res.sendFile(path.join(config.appDir, 'download.html')));

// Observer PWA + public dashboard.
app.use(express.static(config.appDir));

// Friendly 404 for unknown pages; JSON for unknown API routes.
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.status(404).sendFile(path.join(config.appDir, '404.html'));
  }
  res.status(404).json({ error: 'not_found' });
});

// Global error handler — MUST be last. Without it Express's default handler
// leaks stack traces in the response body whenever NODE_ENV !== 'production'
// (and the host pins NODE_ENV=development). This never leaks internals: the
// real error is logged server-side, the client gets a generic message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[unhandled]', req.method, req.path, err);
  if (res.headersSent) return;
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`Hawkeye backend listening on http://0.0.0.0:${config.port} (${config.env})`);
  // Drop push rows the sender can never deliver to. Logged even at 0, because
  // "pruned 0" and "the prune did not run" are the same silence otherwise, and
  // this exists precisely because an undeliverable row had gone unnoticed.
  try {
    console.log(`[push] pruned ${prunePermanentlyUndeliverable()} permanently undeliverable token(s)`);
    // Loud, because a FRESH undeliverable row means a client is registering
    // tokens the sender cannot use right now — the opposite finding from
    // "cleaned up some old ones", and one a prune count alone would hide.
    const fresh = freshUndeliverable();
    if (fresh.length) {
      console.warn(`[push] ${fresh.length} RECENT undeliverable row(s) — a client is registering raw APNs tokens:`,
        fresh.map((f) => `${f.platform} len=${f.token_len} @${new Date(f.created_at).toISOString().slice(0, 10)}`).join(', '));
    }
  } catch (e) { console.error('[push] prune failed:', e.message); }
  // Age out the alerts feed. Daily as well as at boot, because this process
  // runs for weeks at a time — a boot-only prune would simply never fire.
  const pruneNotes = () => {
    import('./services/notifications.js')
      .then((n) => console.log(`[notifications] pruned ${n.pruneOldNotifications()} older than ${n.NOTIFICATION_RETENTION_DAYS}d`))
      .catch((e) => console.error('[notifications] prune failed:', e.message));
  };
  pruneNotes();
  setInterval(pruneNotes, 24 * 3_600_000);
  // Self-setup on hosts without shell access (register load runs in the background).
  bootstrapData(db).catch((err) => console.error('[bootstrap]', err.message));
  // Cross-unit statistical forensics: run shortly after boot, then hourly.
  const forensics = () => {
    try { runForensics(); recheckCollations(); } catch (e) { console.error('[forensics]', e.message); }
    import('./services/triage.js').then((t) => t.scanIncidentClusters()).catch((e) => console.error('[clusters]', e.message));
  };
  setTimeout(forensics, 60_000);
  setInterval(forensics, 3_600_000);
  // Daily DB snapshot (keeps last 7; pull off-host with scripts/pull_backup.sh).
  const backup = () => runBackup().catch((e) => console.error('[backup]', e.message));
  setTimeout(backup, 120_000);
  setInterval(backup, 24 * 3_600_000);
  // IReV cross-check: idle until IREV_ELECTION_ID is set; then every 2h on
  // election week the crowd results get compared against INEC's own sheets.
  const irev = () => irevScan().catch((e) => console.error('[irev]', e.message));
  setTimeout(irev, 180_000);
  setInterval(irev, 2 * 3_600_000);
  // Daily ledger anchor: chain heads recorded + tweeted (only when they changed).
  const anchor = () => runAnchor().catch((e) => console.error('[anchor]', e.message));
  setTimeout(anchor, 240_000);
  setInterval(anchor, 24 * 3_600_000);
  // Crowd-arbitration resolution pass: cases past their review window resolve
  // mechanically (quorum + supermajority — services/docket.js).
  const docket = () => { try { resolveDueCases(); } catch (e) { console.error('[docket]', e.message); } };
  setTimeout(docket, 300_000);
  setInterval(docket, 3_600_000);
  // Practice sandbox: drop all practice runs once the election's autoDeleteAt
  // passes (a day before Osun). Runs on boot and hourly so it clears itself.
  const purgePractice = () => {
    import('./db.js').then(({ purgePracticeIfExpired }) => {
      const n = purgePracticeIfExpired();
      if (n) console.log(`[practice] window closed — purged ${n} practice run(s)`);
    }).catch(() => {});
  };
  purgePractice();
  setInterval(purgePractice, 3_600_000);
  // Declared races: drop the follows for anything that is over and tell the
  // people who were following it who won. Idempotent — every closure is recorded
  // in race_closures, so this re-reads the same file on every boot and does
  // nothing until a new declaration is written into it. Daily as well as on
  // boot, so a declaration added to the data file reaches observers without
  // waiting for a restart (POST /api/admin/close-races does it on demand).
  const closeRaces = () => import('./services/declarations.js')
    .then((d) => d.closeFinishedRaces())
    .catch((e) => console.error('[declarations]', e.message));
  setTimeout(closeRaces, 20_000);
  setInterval(closeRaces, 24 * 3_600_000);
  console.log(
    'NOTE: camera + GPS in the PWA need a secure context — use http://localhost, or an HTTPS tunnel for phones.',
  );
});
