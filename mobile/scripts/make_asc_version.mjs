/**
 * Create an App Store Connect version record. One POST, guarded:
 *  - refuses if a record with that versionString already exists
 *  - refuses if an editable record exists (you would rename it, not add one)
 * Usage: node tmp/asc_make_version.mjs <bundleId> <versionString>
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [bundleId, version] = process.argv.slice(2);
const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const KEY = fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8');

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
const body = b64({ iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const s = crypto.createSign('SHA256');
s.update(`${head}.${body}`);
const jwt = `${head}.${body}.${s.sign({ key: KEY, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;

async function api(path, init) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${txt.slice(0, 600)}`);
  return txt ? JSON.parse(txt) : {};
}

const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
const app = apps.data?.[0];
if (!app) { console.log(`no app for ${bundleId}`); process.exit(1); }
console.log(`app: ${app.attributes?.name} (${app.id})`);

const vs = await api(`/v1/apps/${app.id}/appStoreVersions?limit=20`);
const recs = (vs.data ?? []).map((v) => ({
  id: v.id, v: v.attributes?.versionString, state: v.attributes?.appStoreState ?? v.attributes?.state,
}));
console.log('existing: ' + (recs.map((r) => `${r.v} [${r.state}]`).join(', ') || '(none)'));

if (recs.some((r) => r.v === version)) { console.log(`ok: ${version} already exists — nothing to do.`); process.exit(0); }

const editable = recs.find((r) => /PREPARE_FOR_SUBMISSION|DEVELOPER_REJECTED|METADATA_REJECTED/.test(r.state || ''));
if (editable) {
  console.log(`renaming editable record ${editable.v} -> ${version}`);
  await api(`/v1/appStoreVersions/${editable.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'appStoreVersions', id: editable.id, attributes: { versionString: version } } }),
  });
  console.log(`DONE: ${version} is now the editable version record.`);
  process.exit(0);
}

const made = await api('/v1/appStoreVersions', {
  method: 'POST',
  body: JSON.stringify({
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: version },
      relationships: { app: { data: { type: 'apps', id: app.id } } },
    },
  }),
});
console.log(`DONE: created ${made.data?.attributes?.versionString} [${made.data?.attributes?.appStoreState}] id=${made.data?.id}`);
