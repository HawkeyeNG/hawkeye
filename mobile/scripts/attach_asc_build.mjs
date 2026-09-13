/** node tmp/asc_attach.mjs <bundleId> <versionString>  — attach the newest matching build */
import fs from 'node:fs';
import crypto from 'node:crypto';
const [bundleId, version] = process.argv.slice(2);
const KEY = fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const h = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
const p = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const sig = crypto.createSign('SHA256').update(`${h}.${p}`).sign({ key: KEY, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const jwt = `${h}.${p}.${sig}`;
const api = async (path, init) => {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init, headers: { authorization: `Bearer ${jwt}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : {};
};
const app = (await api(`/v1/apps?filter[bundleId]=${bundleId}`)).data[0];
const ver = (await api(`/v1/apps/${app.id}/appStoreVersions?limit=20`)).data
  .find((v) => v.attributes.versionString === version);
if (!ver) { console.log(`no ${version} record`); process.exit(1); }
const builds = (await api(`/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${version}&sort=-version&limit=5`)).data;
if (!builds.length) { console.log(`no builds for ${version}`); process.exit(1); }
const b = builds[0];
console.log(`attaching build ${b.attributes.version} (${b.attributes.processingState}) to ${version}`);
if (b.attributes.processingState !== 'VALID') { console.log('build not VALID yet — rerun later'); process.exit(1); }
await api(`/v1/appStoreVersions/${ver.id}/relationships/build`, {
  method: 'PATCH', body: JSON.stringify({ data: { type: 'builds', id: b.id } }),
});
console.log(`DONE: ${version} now has build ${b.attributes.version}`);
