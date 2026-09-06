/**
 * Prove the bucket works, end to end, before anything depends on it.
 *
 *   BLOB_DRIVER=s3 node scripts/r2_roundtrip.mjs
 *
 * Exercises the real path a phone will take: presign a URL, PUT bytes to it the
 * way an unauthenticated client would, HEAD it, GET it back, and confirm the
 * bytes that came out hash to the key they were stored under.
 *
 * EVERY CHECK HAS A CONTROL. A bucket that accepts everything and a bucket that
 * works look identical from the happy path alone, so this also confirms the
 * bucket REJECTS a body whose checksum does not match the signed one. If that
 * rejection does not happen, the central security claim of the direct-upload
 * design — that an object cannot exist at key X unless its bytes hash to X — is
 * false, and direct mode must not be enabled.
 *
 * Cleans up after itself with a properly signed DELETE, and checks that the
 * deletion took. Evidence buckets should not accumulate test litter.
 */
import crypto from 'node:crypto';
import {
  presignPut, headBlob, getBlob, putBlob, assertConfigured, DRIVER, _signedHeaders,
} from '../src/services/blobstore.js';

if (DRIVER !== 's3') {
  console.error(`BLOB_DRIVER is "${DRIVER}" — run this with BLOB_DRIVER=s3.`);
  process.exit(2);
}
console.log('config:', JSON.stringify(assertConfigured()));

const body = Buffer.from(`hawkeye r2 round trip ${process.pid} ${'x'.repeat(2048)}`);
const hash = crypto.createHash('sha256').update(body).digest('hex');
const key = `${hash}.jpg`;
const cleanup = [key];

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

console.log(`\nkey: ${key}`);

// ---- 1. presign ------------------------------------------------------------
const p = presignPut(key, hash, 300);
check('presign produced a signed URL', /X-Amz-Signature=[0-9a-f]{64}/.test(p.url));
check('checksum header present', !!p.headers['x-amz-checksum-sha256'], p.headers['x-amz-checksum-sha256']);

// ---- 2. PUT as an unauthenticated client -----------------------------------
{
  const r = await fetch(p.url, { method: 'PUT', headers: p.headers, body });
  check('PUT accepted by the bucket', r.ok, `http ${r.status}`);
  if (!r.ok) console.log('        ', (await r.text()).slice(0, 400));
}

// ---- 3. THE CONTROL the whole design rests on ------------------------------
// A URL signed for THESE bytes must not accept OTHER bytes.
{
  const p2 = presignPut(key, hash, 300);
  const r = await fetch(p2.url, {
    method: 'PUT', headers: p2.headers, body: Buffer.from('not the same bytes at all'),
  });
  check('CONTROL: mismatched body is REJECTED', !r.ok, `http ${r.status}`);
  if (r.ok) {
    console.log('        !! the bucket accepted bytes that do not match the signed checksum.');
    console.log('        !! do NOT enable UPLOAD_MODE=direct — key-implies-hash is not enforced.');
  }
}

// ---- 4. HEAD and GET -------------------------------------------------------
{
  const h = await headBlob(key);
  check('HEAD sees the object', h.exists, `${h.size} bytes`);
  check('HEAD size matches', h.size === body.length, `${h.size} vs ${body.length}`);

  const back = await getBlob(key);
  const backHash = crypto.createHash('sha256').update(back).digest('hex');
  check('GET returns identical bytes', back.equals(body));
  check('round-tripped bytes hash to the key', backHash === hash, backHash.slice(0, 16) + '…');
}

// ---- 5. CONTROL: an object never written must not be found -----------------
{
  const ghost = `${crypto.createHash('sha256').update('never uploaded').digest('hex')}.jpg`;
  const h = await headBlob(ghost);
  check('CONTROL: an absent key reports absent', !h.exists);
}

// ---- 6. the server-side write path (used by the backfill) ------------------
{
  const b2 = Buffer.from('server side put ' + process.pid);
  const h2 = crypto.createHash('sha256').update(b2).digest('hex');
  cleanup.push(`${h2}.jpg`);
  await putBlob(`${h2}.jpg`, b2);
  const back = await getBlob(`${h2}.jpg`);
  check('putBlob/getBlob (backfill path) works', back.equals(b2));
}

// ---- 7. clean up -----------------------------------------------------------
{
  const del = async (k) => {
    const { url, headers } = _signedHeaders('DELETE', k, null);
    const r = await fetch(url, { method: 'DELETE', headers });
    return r.ok || r.status === 404;
  };
  const gone = [];
  for (const k of cleanup) gone.push(await del(k).catch(() => false));
  check('test objects deleted', gone.every(Boolean), `${gone.filter(Boolean).length}/${gone.length}`);
  const still = await headBlob(cleanup[0]);
  check('CONTROL: the deletion actually took', !still.exists);
}

console.log(`\n${fails ? `${fails} CHECK(S) FAILED — do not enable direct mode` : 'ALL CHECKS PASSED — the bucket is ready'}`);
process.exit(fails ? 1 : 0);
