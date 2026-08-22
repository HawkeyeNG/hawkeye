/**
 * Does this phone have an account on THIS backend, and can it sign in?
 *
 *   node scripts/check_account.mjs +2348167000004
 *
 * Answers the question that actually matters when a sign-in fails: is the
 * account missing, inactive, or simply without a password — three different
 * causes that the app reports identically as a failure to sign in.
 *
 * Reads only. It never takes, checks or prints a password, and the phone is
 * shown hashed, which is the only form the database holds anyway.
 */
import crypto from 'node:crypto';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { normalizePhone } from '../src/routes/observers.js';

const raw = process.argv[2];
if (!raw) { console.error('usage: node scripts/check_account.mjs <phone>'); process.exit(2); }

const phone = normalizePhone(raw);
if (!phone) {
  console.error(`"${raw}" is not a valid Nigerian number by normalizePhone() — sign-in would 400 before`);
  console.error('it reached the database. Expected 0[789][01]XXXXXXXX or +234[789][01]XXXXXXXX.');
  process.exit(1);
}

const hash = crypto.createHmac('sha256', config.phoneSalt).update(phone).digest('hex');
const row = db.prepare('SELECT id, status, password_hash, created_at FROM observers WHERE phone_hash = ?').get(hash);

console.log(`normalised : ${phone}`);
console.log(`phone_hash : ${hash.slice(0, 16)}…`);
console.log(`database   : ${config.dbPath}`);
console.log(`observers  : ${db.prepare('SELECT COUNT(*) c FROM observers').get().c}`);
console.log();

if (!row) {
  console.log('NOT FOUND on this backend.');
  console.log('  Sign-in returns 401 password_login_unavailable — correctly, since there is no');
  console.log('  such account here. An account created against production does not exist in a');
  console.log('  local database; they are separate stores.');
  process.exit(0);
}

console.log(`FOUND — observer #${row.id}`);
console.log(`  status        : ${row.status}${row.status === 'active' ? '' : '  <-- must be active to sign in'}`);
console.log(`  has password  : ${row.password_hash ? 'yes' : 'NO  <-- password sign-in unavailable; OTP only'}`);
console.log(`  created       : ${new Date(row.created_at).toISOString().slice(0, 10)}`);
