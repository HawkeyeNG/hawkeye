#!/usr/bin/env node
// Seed FLAGGED TEST OBSERVERS into the STAGING database and write the k6
// fixtures file. Run it ON THE STAGING HOST, from the repo root, with staging's
// own backend/.env:
//
//   APP_ENV=staging node scripts/loadtest/seed/seed_staging.mjs \
//     --i-am-on-staging --host staging.hawkeye.com.ng \
//     --count 60000 --auth 2000 --out scripts/loadtest/.fixtures/staging.json
//
// It REFUSES unless every one of these holds, so it cannot write into prod and
// cannot bless a server that could send a real message:
//   APP_ENV=staging and config.env !== 'production'
//   SMS_PROVIDER=console, SMS OTP off, and NO Sendchamp / Termii / BulkSMS /
//   WhatsApp Cloud credentials in the environment
//   --i-am-on-staging given explicitly
//
// Test observers are marked is_staff=1 (excluded from every public count).
// Upload observers have phone_hash "loadtest:<n>" (no phone at all). Auth
// observers get the real HMAC of a 0700 5xxxxxx number, because /login looks
// the phone up, plus a known test password.
//
// Reset staging by RESTORING THE PRE-TEST SNAPSHOT, never by deleting rows:
// submissions are a hash chain and deletes would break it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const die = (m) => { console.error(`seed_staging: REFUSED: ${m}`); process.exit(2); };

if (!flag('--i-am-on-staging')) die('pass --i-am-on-staging (this writes to the local database)');
if (process.env.APP_ENV !== 'staging') die('APP_ENV must be exactly "staging"');

const { config } = await import('../../../backend/src/config.js');
if (config.env === 'production') die('config.env is production');
if (config.smsProvider !== 'console') die(`SMS_PROVIDER is "${config.smsProvider}", must be "console"`);
if (config.smsOtpEnabled) die('SMS_OTP_ENABLED is on');
for (const [name, v] of Object.entries({
  SENDCHAMP_API_KEY: config.sendchampApiKey,
  TERMII_API_KEY: config.termiiApiKey,
  BULKSMS_NG_API_TOKEN: config.bulksmsNgApiToken,
  WA_CLOUD_TOKEN: config.waCloudToken,
  WA_PHONE_NUMBER_ID: config.waPhoneNumberId,
})) if (v) die(`${name} is set; staging must have no real messaging credentials`);

const host = String(opt('--host', '')).toLowerCase();
if (!host) die('--host is required (the hostname k6 will target, e.g. staging.hawkeye.com.ng)');
if (/(^|\.)hawkeye\.com\.ng$/.test(host) && host !== 'staging.hawkeye.com.ng') die(`${host} is a production name`);
const COUNT = Math.max(1, Number(opt('--count', 1000)));
const AUTH = Math.max(1, Number(opt('--auth', 200)));
const OUT = path.resolve(opt('--out', 'scripts/loadtest/.fixtures/staging.json'));
const PASSWORD = `loadtest-${crypto.randomBytes(6).toString('hex')}`;

const { db, parties, contests } = await import('../../../backend/src/db.js');
const { reportingOpen } = await import('../../../backend/src/services/scope.js');

// The races the upload test files must be open NOW on staging (edit the dates
// in staging's own backend/src/data/contests.json; never commit that edit).
for (const code of ['PRES', 'SEN', 'REP']) {
  const c = contests.find((x) => x.code === code);
  if (!c) die(`contest ${code} missing`);
  if (!reportingOpen(c)) console.warn(`seed_staging: WARNING ${code} is not open for reporting (date ${c.date}); uploads will get 403 reporting_not_open`);
}
if (config.uploadMode !== 'direct') console.warn('seed_staging: WARNING UPLOAD_MODE is not direct; run k6 with --upload-path proxy or fix staging');

const pus = db.prepare(`
  SELECT pu_code AS code, COALESCE(lat, approx_lat) AS lat, COALESCE(lng, approx_lng) AS lng
    FROM polling_units
   WHERE COALESCE(lat, approx_lat) IS NOT NULL
     AND senatorial IS NOT NULL AND senatorial != ''
     AND federal_constituency IS NOT NULL AND federal_constituency != ''
   ORDER BY random() LIMIT ?`).all(Math.min(COUNT, 20000));
if (!pus.length) die('no polling units with coordinates and districts; load the register first');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwtHS256(claims) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', config.jwtSecret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
const didHash = (d) => crypto.createHmac('sha256', config.jwtSecret).update(d).digest('hex').slice(0, 24);
const phoneHash = (p) => crypto.createHmac('sha256', config.phoneSalt).update(p).digest('hex');
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' });
  const publicJwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  return { publicJwk, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}

const now = Date.now();
const iat = Math.floor(now / 1000);
const exp = iat + 3 * 86400;
const ins = db.prepare(`INSERT INTO observers (phone_hash, public_key_jwk, reputation, status, created_at, device_id, is_staff, password_hash)
  VALUES (?, ?, 1.0, 'active', ?, ?, 1, ?)
  ON CONFLICT(phone_hash) DO UPDATE SET public_key_jwk = excluded.public_key_jwk, device_id = excluded.device_id,
    is_staff = 1, status = 'active', password_hash = excluded.password_hash
  RETURNING id`);

// One password hash for the whole auth pool: this measures scrypt at login,
// not the seed's patience.
const salt = crypto.randomBytes(16).toString('hex');
const pwHash = `${salt}:${crypto.scryptSync(PASSWORD, salt, 32).toString('hex')}`;

const upload = [];
const auth = [];
db.transaction(() => {
  for (let i = 0; i < COUNT; i++) {
    const deviceId = crypto.randomBytes(32).toString('hex');
    const k = keypair();
    const { id } = ins.get(`loadtest:${i}`, JSON.stringify(k.publicJwk), now, deviceId, null);
    upload.push({
      token: jwtHS256({ sub: String(id), did: didHash(deviceId), via: 'loadtest', iat, exp }),
      deviceId, pkcs8: k.pkcs8, pu: pus[i % pus.length],
    });
  }
  for (let j = 0; j < AUTH; j++) {
    const local = `0700${String(5_000_000 + j).padStart(7, '0')}`;
    const deviceId = crypto.randomBytes(32).toString('hex');
    const k = keypair();
    ins.get(phoneHash(`+234${local.slice(1)}`), JSON.stringify(k.publicJwk), now, deviceId, pwHash);
    auth.push({ phone: local, password: PASSWORD, deviceId, publicJwk: k.publicJwk });
  }
})();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  attest: { host, env: config.env, otpStub: true, checkedAt: Date.now(), uploadMode: config.uploadMode },
  parties: parties.map((p) => p.code),
  pus,
  upload,
  auth,
}));
fs.chmodSync(OUT, 0o600);
console.log(`seed_staging: ${upload.length} upload + ${auth.length} auth test observers (is_staff=1) -> ${OUT}`);
console.log('seed_staging: the file holds staging-only tokens and keys. Do not commit or share it.');
