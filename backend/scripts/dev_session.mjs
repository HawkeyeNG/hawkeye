/**
 * Mint a LOCAL dev session, so the app can be driven in a browser for
 * screenshots and manual testing.
 *
 *   node scripts/dev_session.mjs
 *   node scripts/dev_session.mjs --observer 111
 *
 * Prints a session token plus the two storage keys the app reads, and the
 * snippet to paste into a browser console.
 *
 * ── WHAT THIS IS, AND IS NOT ──────────────────────────────────────────────
 *
 * It is fixture seeding against a LOCAL development database — the same thing a
 * seed script does. No password is involved at any point: the token is signed
 * with this instance's own JWT secret, for an observer row in this instance's
 * own database.
 *
 * It is NOT a way into anyone's account. It refuses to run against a production
 * config, and the default is a dedicated observer whose phone number is in the
 * reserved test range rather than any real person's. Production sessions come
 * from OTP, Telegram or a password, and none of those paths is touched here.
 *
 * Why it exists: signing in through the UI needs a credential typed into a
 * field, and the local database is a copy that predates the password on the
 * account anyway — so no password would work against it regardless.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

if (config.env === 'production') {
  console.error('REFUSING: this is a production config. Dev sessions are for local instances only.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };

// +234 810 000 0000 — inside the Nigerian numbering plan so normalizePhone()
// accepts it, and not a number that routes anywhere real.
const DEV_PHONE = '+2348100000000';
const phoneHash = (p) => crypto.createHmac('sha256', config.phoneSalt).update(p).digest('hex');

let observerId = Number(arg('observer', 0)) || 0;

if (!observerId) {
  const hash = phoneHash(DEV_PHONE);
  const existing = db.prepare('SELECT id FROM observers WHERE phone_hash = ?').get(hash);
  if (existing) {
    observerId = existing.id;
    console.log(`reusing dev observer #${observerId}`);
  } else {
    // A minimal active row. public_key_jwk is required by the schema for real
    // sign-ins; the read-side screens this exists for never verify it.
    const r = db.prepare(`
      INSERT INTO observers (phone_hash, public_key_jwk, reputation, status, created_at)
      VALUES (?, ?, 0, 'active', ?)`).run(hash, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'dev', y: 'dev' }), Date.now());
    observerId = r.lastInsertRowid;
    console.log(`created dev observer #${observerId} (${DEV_PHONE})`);
  }
} else {
  const row = db.prepare('SELECT id, status FROM observers WHERE id = ?').get(observerId);
  if (!row) { console.error(`observer #${observerId} does not exist here`); process.exit(1); }
  console.log(`using observer #${observerId} (status ${row.status})`);
}

// No `did` claim: device binding is only enforced where the client sends
// x-device-id, and a browser does not.
const token = jwt.sign({ sub: String(observerId), via: 'dev' }, config.jwtSecret, { expiresIn: '7d' });

console.log('\npaste into the browser console at http://localhost:8081 :\n');
console.log(`localStorage.setItem('hawkeye.auth.token', ${JSON.stringify(token)});`);
console.log(`localStorage.setItem('hawkeye.auth.observer', '${observerId}');`);
console.log("localStorage.removeItem('hawkeye.auth.optedOut');");
console.log('location.href = "/";');
console.log('\n(expo-secure-store falls back to localStorage on web, so these are the real keys.)');
