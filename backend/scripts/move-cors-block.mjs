/**
 * One-shot: move the dev-CORS comment block from beside the static handlers to
 * above the route mounts, and re-attach its middleware.
 *
 *   node scripts/move-cors-block.mjs
 *
 * Done as a script rather than by hand because the block is long and the
 * failure it fixes is an ORDERING bug — the kind that is easy to reintroduce
 * with a careless paste. Idempotent; safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';

const p = path.join(import.meta.dirname, '..', 'src', 'server.js');
let src = fs.readFileSync(p, 'utf8');

const START = '/**\n * MOVED-UP NOTE:';
const END = ' * exactly as it does today.\n */\n';
const i = src.indexOf(START);
const j = src.indexOf(END, i);
if (i === -1 || j === -1) { console.log('block not found — already moved?'); process.exit(0); }

const block = src.slice(i, j + END.length);
src = src.slice(0, i) + src.slice(j + END.length);

const MIDDLEWARE = `const LOOPBACK_ORIGIN = /^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$/;
if (config.env !== 'production') {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && LOOPBACK_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-observer-token, x-admin-pass');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      // Terminate the preflight here: falling through reaches the SPA catch-all,
      // which answers 404 and fails the browser's check.
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  });
}

`;

// Anchor: the body parser, which is the first thing mounted after the app is
// created and well before any router.
const ANCHOR = "app.use(express.json({ limit: '100kb' }));";
if (!src.includes(ANCHOR)) { console.error('anchor not found'); process.exit(1); }
src = src.replace(ANCHOR, `${block}${MIDDLEWARE}${ANCHOR}`);

fs.writeFileSync(p, src);
console.log('moved the dev-CORS block above the route mounts');
