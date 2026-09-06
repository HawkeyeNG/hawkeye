/**
 * Set (and verify) the bucket CORS policy.
 *
 *   BLOB_DRIVER=s3 node scripts/r2_cors.mjs          # show current policy
 *   BLOB_DRIVER=s3 node scripts/r2_cors.mjs --apply
 *
 * WHY IT IS REQUIRED. In direct mode the PHONE PUTs straight to the bucket with
 * a custom header (x-amz-checksum-sha256), which makes it a preflighted
 * cross-origin request. Without a CORS policy the browser fails at the OPTIONS
 * before a single byte moves — and it fails in a way the origin never sees, so
 * nothing server-side would tell us.
 *
 * The client falls back to multipart on that failure, so the site keeps working;
 * it would just silently never use direct upload, which is the failure mode
 * where you believe a feature is on and it is not.
 *
 * Uses the S3-compatible API with the R2 credentials already in .env, so it
 * needs no account-scoped Cloudflare token.
 */
import crypto from 'node:crypto';

const S3 = {
  endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'auto',
  key: process.env.S3_ACCESS_KEY_ID || '',
  secret: process.env.S3_SECRET_ACCESS_KEY || '',
};
for (const [k, v] of Object.entries(S3)) {
  if (!v) { console.error(`missing S3_${k.toUpperCase()}`); process.exit(2); }
}

const APPLY = process.argv.includes('--apply');

// Origins that must be able to PUT:
//   hawkeye.com.ng          the website and the installed PWA
//   https://localhost       Capacitor on Android
//   capacitor://localhost   Capacitor on iOS
// The RN app is NOT a browser and is not subject to CORS, but listing these
// costs nothing and a missing origin fails invisibly.
const POLICY = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>https://hawkeye.com.ng</AllowedOrigin>
    <AllowedOrigin>https://www.hawkeye.com.ng</AllowedOrigin>
    <AllowedOrigin>https://localhost</AllowedOrigin>
    <AllowedOrigin>capacitor://localhost</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <AllowedHeader>x-amz-checksum-sha256</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

/** SigV4 for a BUCKET-level request with a query string (?cors=). */
function signed(method, body) {
  const url = new URL(`${S3.endpoint}/${S3.bucket}`);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const payloadHash = sha256hex(body ? Buffer.from(body) : Buffer.alloc(0));
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname,
    'cors=',                                   // the only query parameter
    ...names.map((h) => `${h}:${headers[h]}`),
    '',
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(Buffer.from(canonical))].join('\n');
  let k = hmac(`AWS4${S3.secret}`, date);
  for (const p of [S3.region, 's3', 'aws4_request']) k = hmac(k, p);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope},`
    + `SignedHeaders=${names.join(';')},Signature=${crypto.createHmac('sha256', k).update(toSign).digest('hex')}`;
  return { url: `${url.toString()}?cors=`, headers };
}

async function get() {
  const { url, headers } = signed('GET', null);
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.text() };
}

const before = await get();
console.log(`current policy: http ${before.status}`);
console.log(before.body.trim().slice(0, 600) || '  (none)');

if (!APPLY) {
  console.log('\nDRY RUN — would apply:\n');
  console.log(POLICY);
  console.log('\nRe-run with --apply.');
  process.exit(0);
}

{
  const { url, headers } = signed('PUT', POLICY);
  const r = await fetch(url, { method: 'PUT', headers: { ...headers, 'content-type': 'application/xml' }, body: POLICY });
  console.log(`\nPUT ?cors -> http ${r.status}`);
  if (!r.ok) { console.log((await r.text()).slice(0, 600)); process.exit(1); }
}

// VERIFY BY READING IT BACK. A 200 on the write is not evidence the policy is
// in force — and unlike most checks here, a wrong CORS policy fails only in a
// browser, where no server log will ever show it.
const after = await get();
console.log(`\nread back: http ${after.status}`);
console.log(after.body.trim().slice(0, 800));

const ok = after.status === 200
  && after.body.includes('hawkeye.com.ng')
  && /<AllowedMethod>PUT<\/AllowedMethod>/.test(after.body)
  && after.body.includes('x-amz-checksum-sha256');
console.log(`\ncontains our origin, PUT, and the checksum header: ${ok ? 'yes' : 'NO'}`);
// Control: the read-back must differ from the empty/absent "before", or we are
// just looking at the same nothing twice.
console.log(`changed from before: ${before.body.trim() !== after.body.trim() ? 'yes' : 'NO — nothing took effect'}`);
process.exit(ok ? 0 : 1);
