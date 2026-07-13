import express from 'express';
import { config } from './config.js';
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
import { pushRouter } from './routes/push.js';
import { notificationsRouter } from './routes/notifications.js';
import { tiktokRouter } from './routes/tiktok.js';
import { metaRouter } from './routes/meta.js';
import { socialRouter } from './routes/social.js';
import { resolveDueCases } from './services/docket.js';
import { securityHeaders, makeLimiter, concurrencyLimit } from './services/security.js';
import { runForensics, recheckCollations } from './services/integrity.js';
import { runBackup } from './services/backup.js';
import { irevScan } from './services/irev.js';
import { runAnchor } from './services/anchor.js';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// Origin lock (dormant until ORIGIN_AUTH_SECRET is set in .env): GO54 fronts
// the origin with its own proxy, so an Apache IP allowlist can't tell our
// Cloudflare zone's traffic from direct scans — instead a CF Transform Rule
// stamps X-Origin-Auth on every request and we reject anything without it.
if (config.originAuthSecret) {
  app.use((req, res, next) => {
    if (req.headers['x-origin-auth'] === config.originAuthSecret) return next();
    res.status(403).json({ error: 'origin_locked' });
  });
}

app.use(securityHeaders);
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

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'hawkeye', env: config.env }));
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
app.use('/api', pushRouter);
app.use('/api', notificationsRouter);
app.use('/api', tiktokRouter);
app.use('/api', metaRouter);
app.use('/api', socialRouter);
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
// truth.json / sets.json and any non-image path fall through to the raw files.
app.use('/training', express.static(trainRoot));

// Evidence photos/videos are public audit artifacts — content-addressed,
// immutable. Harden the responses: nosniff + a sandbox CSP so a polyglot
// upload (a video that's also valid HTML/JS) can never execute as a document
// on our origin; media still loads fine as an <img>/<video> resource.
app.use('/uploads', express.static(config.uploadDir, {
  immutable: true,
  maxAge: '1y',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  },
}));

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
  console.log(
    'NOTE: camera + GPS in the PWA need a secure context — use http://localhost, or an HTTPS tunnel for phones.',
  );
});
