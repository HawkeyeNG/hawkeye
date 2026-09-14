/**
 * Submit a prepared iOS version for App Store review.
 *
 * The modern flow is three calls: open a reviewSubmission for the app, put the
 * version in it as an item, then flip `submitted`. The older
 * appStoreVersionSubmissions endpoint is gone for apps on this path.
 *
 *   node tmp/submit.mjs <bundleId> <version>
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [bundle, version] = process.argv.slice(2);
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
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : {};
};

const app = (await api(`/v1/apps?filter[bundleId]=${bundle}`)).data[0];
const ver = (await api(`/v1/apps/${app.id}/appStoreVersions?limit=20`)).data
  .find((v) => v.attributes.versionString === version);
if (!ver) { console.log(`no ${version} record`); process.exit(1); }
console.log(`${app.attributes.name} ${version} [${ver.attributes.appStoreState}]`);
if (ver.attributes.appStoreState !== 'PREPARE_FOR_SUBMISSION') {
  console.log('  not in PREPARE_FOR_SUBMISSION — nothing submitted'); process.exit(1);
}

/* Reuse an open submission if one exists; opening a second is an error. */
let sub = (await api(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES`))
  .data?.[0];
if (!sub) {
  sub = (await api('/v1/reviewSubmissions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    }),
  })).data;
  console.log(`  opened review submission ${sub.id}`);
} else {
  console.log(`  reusing open submission ${sub.id} [${sub.attributes.state}]`);
}

const items = (await api(`/v1/reviewSubmissions/${sub.id}/items`)).data || [];
if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === ver.id)) {
  await api('/v1/reviewSubmissionItems', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } },
        },
      },
    }),
  });
  console.log('  added the version to the submission');
} else {
  console.log('  version already in the submission');
}

const done = await api(`/v1/reviewSubmissions/${sub.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } }),
});
console.log(`  SUBMITTED — state now ${done.data?.attributes?.state}`);
