/**
 * DOES APP STORE CONNECT HAVE A VERSION RECORD THIS BUILD CAN ATTACH TO?
 *
 * The failure this exists to make loud, in full, because it is invisible from
 * every surface a person would think to check:
 *
 *   Lite's marketing version comes from android/app/build.gradle's versionName
 *   (1.2). The App Store Connect version record was created with Apple's
 *   default, 1.0.0, and nobody changed it. ASC only offers a build to a version
 *   record whose versionString matches the build's CFBundleShortVersionString,
 *   so builds 6-11 all uploaded, all validated, all reached TestFlight, and NOT
 *   ONE of them could be attached to the store listing. The listing icon is
 *   taken from the attached build, so the App Store page showed no icon — and
 *   the symptom looked like an icon bug, which is what it was chased as.
 *
 *   Nothing reports this. altool is happy (TestFlight does not care about the
 *   version record). The build shows VALID. The console shows the version
 *   record and the builds on different screens, neither mentioning the other.
 *
 * WARNS, DOES NOT FAIL. Uploading a build whose version has no store record is
 * perfectly legitimate — it is what you do while testing before the store
 * version is set up. Failing the build would block that. But it says so in a
 * way that cannot be mistaken for noise, and names the exact fix.
 *
 * Read-only: two GETs, no mutation. The signing key is never printed.
 *
 * Usage: node scripts/check_asc_version.mjs <bundleId> <marketingVersion>
 * Needs ASC_KEY_ID, ASC_ISSUER_ID and either ASC_KEY_PATH or ASC_PRIVATE_KEY.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [bundleId, version] = process.argv.slice(2);
if (!bundleId || !version) {
  console.log('usage: check_asc_version.mjs <bundleId> <marketingVersion>');
  process.exit(2);
}

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const KEY = process.env.ASC_PRIVATE_KEY
  || (process.env.ASC_KEY_PATH ? fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8') : null);

// Missing credentials must not look like a clean result. This check answering
// "nothing to report" when it never ran is precisely the shape of failure it
// was written to prevent.
if (!KEY_ID || !ISSUER || !KEY) {
  console.log('::warning::App Store Connect version check SKIPPED — ASC credentials not available to this job.');
  console.log('  This check did NOT run. It has not told you the version is fine.');
  process.exit(0);
}

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
const body = b64({ iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const signer = crypto.createSign('SHA256');
signer.update(`${head}.${body}`);
const jwt = `${head}.${body}.${signer.sign({ key: KEY, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;

async function api(path) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

try {
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  const app = apps.data?.[0];
  if (!app) {
    console.log(`::warning::No App Store Connect app found for ${bundleId} — cannot check the version record.`);
    process.exit(0);
  }
  const versions = await api(`/v1/apps/${app.id}/appStoreVersions?limit=20`);
  const records = (versions.data ?? []).map((v) => ({
    v: v.attributes?.versionString,
    state: v.attributes?.appStoreState ?? v.attributes?.state,
  }));

  console.log(`  app: ${app.attributes?.name} (${bundleId})`);
  console.log(`  this build's marketing version: ${version}`);
  console.log(`  version records on App Store Connect: ${records.map((r) => `${r.v} [${r.state}]`).join(', ') || '(none)'}`);

  if (records.some((r) => r.v === version)) {
    console.log(`  ok: a ${version} version record exists — this build can be attached to the listing.`);
    process.exit(0);
  }

  const editable = records.find((r) => /PREPARE_FOR_SUBMISSION|DEVELOPER_REJECTED|REJECTED|METADATA_REJECTED/.test(r.state || ''));
  console.log('::warning::No App Store Connect version record matches this build — it cannot be attached to the listing.');
  console.log('');
  console.log(`  This build is marketing version ${version}. App Store Connect has ${records.map((r) => r.v).join(', ') || 'no version'}.`);
  console.log('  ASC only offers a build to a version whose number MATCHES the build, so this one will');
  console.log('  not appear in the version\'s build picker. TestFlight is unaffected — testers still get it.');
  console.log('  The visible symptom is a listing with NO APP ICON, because the icon comes from the');
  console.log('  attached build.');
  console.log('');
  if (editable) {
    console.log(`  FIX: App Store Connect -> ${app.attributes?.name} -> the ${editable.v} version ->`);
    console.log(`       change the version number to ${version}, save, then pick this build under Build.`);
  } else {
    console.log(`  FIX: create a ${version} version in App Store Connect, then pick this build under Build.`);
  }
  console.log(`  (Or change versionName in mobile/android/app/build.gradle if ${version} is the mistake.)`);
} catch (e) {
  // A check that cannot reach the API must say so, not pass quietly.
  console.log(`::warning::App Store Connect version check could not run: ${e.message}`);
}
