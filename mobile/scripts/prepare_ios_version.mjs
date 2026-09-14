/**
 * Prepare an iOS version for submission: ensure the version record exists,
 * attach the newest VALID build from that train, and set the release notes.
 *
 * It does NOT submit. Submitting is a public act and stays a human one.
 *
 *   node tmp/prep.mjs <bundleId> <version> <notesFile>
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [bundle, version, notesFile] = process.argv.slice(2);
const notes = fs.readFileSync(notesFile, 'utf8').trim();
const KEY = fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const h = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
const p = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
const sig = crypto.createSign('SHA256').update(`${h}.${p}`).sign({ key: KEY, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const jwt = `${h}.${p}.${sig}`;
const api = async (path, init) => {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${jwt}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t.slice(0, 400)}`);
  return t ? JSON.parse(t) : {};
};

const app = (await api(`/v1/apps?filter[bundleId]=${bundle}`)).data[0];
if (!app) { console.log(`no app for ${bundle}`); process.exit(1); }
console.log(`${app.attributes.name} (${bundle})`);

/* --- the version record ------------------------------------------------- */
let ver = (await api(`/v1/apps/${app.id}/appStoreVersions?limit=20`)).data
  .find((v) => v.attributes.versionString === version);
if (!ver) {
  ver = (await api('/v1/appStoreVersions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    }),
  })).data;
  console.log(`  created version record ${version}`);
} else {
  console.log(`  version record ${version} exists [${ver.attributes.appStoreState}]`);
}
const EDITABLE = /PREPARE_FOR_SUBMISSION|DEVELOPER_REJECTED|REJECTED|METADATA_REJECTED|INVALID_BINARY/;
if (!EDITABLE.test(ver.attributes.appStoreState || '')) {
  console.log(`  !! ${ver.attributes.appStoreState} is not editable — stopping before it changes anything`);
  process.exit(1);
}

/* --- the build ----------------------------------------------------------- */
/* From THIS version's train only. Sorting the app's builds would compare "9"
   against "21" as strings and across marketing versions. */
const trains = (await api(`/v1/apps/${app.id}/preReleaseVersions?limit=20`)).data;
const train = trains.find((t) => t.attributes.version === version);
if (!train) { console.log(`  !! no TestFlight train for ${version}`); process.exit(1); }
const builds = (await api(`/v1/preReleaseVersions/${train.id}/builds?limit=50`)).data
  .filter((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired)
  .sort((a, c) => Number(c.attributes.version) - Number(a.attributes.version));
if (!builds.length) { console.log(`  !! no VALID unexpired build in the ${version} train`); process.exit(1); }
const build = builds[0];
await api(`/v1/appStoreVersions/${ver.id}/relationships/build`, {
  method: 'PATCH', body: JSON.stringify({ data: { type: 'builds', id: build.id } }),
});
console.log(`  attached build ${build.attributes.version} (of ${builds.map((b) => b.attributes.version).join(', ')})`);

/* --- the release notes ---------------------------------------------------- */
const locs = (await api(`/v1/appStoreVersions/${ver.id}/appStoreVersionLocalizations`)).data;
for (const l of locs) {
  await api(`/v1/appStoreVersionLocalizations/${l.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: notes } },
    }),
  });
  console.log(`  release notes set for ${l.attributes.locale} (${notes.length} chars)`);
}
console.log('  READY — not submitted. Submitting stays a human action.');
