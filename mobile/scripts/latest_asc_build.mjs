/**
 * WHAT BUILD NUMBER HAS LITE ALREADY USED?
 *
 * ios-lite-release.yml takes build_number as a required input and App Store
 * Connect rejects a re-used CFBundleVersion — after the archive, the signing and
 * the upload, which is a slow way to learn you picked a number twice. The run
 * history does not show the input either, so the only reliable answer is Apple's.
 *
 * It does NOT report device family, because App Store Connect does not expose
 * that on the build resource — and a column of question marks is worse than no
 * column. Device family is what makes ASC demand 13-inch iPad screenshots:
 * `cap add ios` ships TARGETED_DEVICE_FAMILY = "1,2", so every Lite build up to
 * 20 claimed iPad. The place that is actually checked is the archive itself, by
 * the "iPhone only" step in ios-lite-release.yml, which fails the build if the
 * setting did not take.
 *
 * Read-only: GETs only. The signing key is never printed.
 *
 * Usage: node scripts/latest_asc_build.mjs [bundleId]
 * Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (or ASC_PRIVATE_KEY).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const bundleId = process.argv[2] || 'ng.com.hawkeye.lite';
const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const KEY = process.env.ASC_PRIVATE_KEY
  || (process.env.ASC_KEY_PATH ? fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8') : null);

if (!KEY_ID || !ISSUER || !KEY) {
  console.error('need ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (or ASC_PRIVATE_KEY)');
  process.exit(2);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
const payload = b64({ iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const sig = crypto.createSign('SHA256')
  .update(`${header}.${payload}`)
  .sign({ key: KEY, dsaEncoding: 'ieee-p1363' })
  .toString('base64url');
const jwt = `${header}.${payload}.${sig}`;

const api = async (path) => {
  const r = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const apps = await api(`apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
if (!apps.data?.length) {
  console.error(`no app for bundle id ${bundleId}`);
  process.exit(1);
}
const app = apps.data[0];
console.log(`${app.attributes.name}  (${bundleId})`);

const builds = await api(`builds?filter[app]=${app.id}&limit=10&sort=-version`);
if (!builds.data?.length) {
  console.log('  no builds uploaded yet');
  process.exit(0);
}

// Device family is NOT exposed on the build resource, so it cannot be reported
// here — the honest place to check it is the archive itself, which the
// "iPhone only" step in ios-lite-release.yml asserts at build time.
console.log('  build  uploaded             state');
for (const b of builds.data) {
  const a = b.attributes;
  console.log(`  ${String(a.version).padEnd(6)} ${String(a.uploadedDate).slice(0, 16).padEnd(20)} `
    + `${a.processingState}`);
}

const highest = Math.max(...builds.data
  .map((b) => Number(b.attributes.version))
  .filter((n) => Number.isFinite(n)));
console.log(`\nhighest build number used: ${highest}`);
console.log(`next free build_number:    ${highest + 1}`);
