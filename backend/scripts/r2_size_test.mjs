/**
 * Does the signed content-length actually bind? Ask R2, do not assume.
 *
 *   BLOB_DRIVER=s3 node scripts/r2_size_test.mjs
 *
 * Signing a header only helps if the service verifies it. If R2 ignores the
 * signed content-length, the cap is decorative and direct mode still accepts an
 * object of any size — the exact finding this is meant to close.
 */
import crypto from 'node:crypto';
import {
  presignPut, headBlob, MAX_BLOB_BYTES, DRIVER, _signedHeaders,
} from '../src/services/blobstore.js';

if (DRIVER !== 's3') { console.error(`BLOB_DRIVER is "${DRIVER}"`); process.exit(2); }

let fails = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) fails++; };
const cleanup = [];

const body = Buffer.from('size-bound test ' + process.pid + ' ' + 'y'.repeat(4096));
const hash = crypto.createHash('sha256').update(body).digest('hex');
const key = `${hash}.jpg`;
cleanup.push(key);

console.log(`MAX_BLOB_BYTES = ${MAX_BLOB_BYTES}\nkey = ${key}\n`);

// 1. the honest case must still work
{
  const p = presignPut(key, hash, 300, body.length);
  check('signed headers include content-length',
    /content-length/.test(new URL(p.url).searchParams.get('X-Amz-SignedHeaders') || ''),
    new URL(p.url).searchParams.get('X-Amz-SignedHeaders'));
  const r = await fetch(p.url, { method: 'PUT', headers: p.headers, body });
  check('correct body + correct length is ACCEPTED', r.ok, `http ${r.status}`);
  if (!r.ok) console.log('        ', (await r.text()).slice(0, 300));
}

// 2. THE CONTROL: a URL signed for N bytes must not accept M bytes.
// Different bytes AND a different length — signed for the short body's length.
{
  const big = Buffer.concat([body, Buffer.alloc(4096, 1)]);
  const bigHash = crypto.createHash('sha256').update(big).digest('hex');
  const bigKey = `${bigHash}.jpg`;
  cleanup.push(bigKey);
  // Sign for a LENGTH THAT LIES: claim the short length for the long body.
  const p = presignPut(bigKey, bigHash, 300, body.length);
  const r = await fetch(p.url, { method: 'PUT', headers: p.headers, body: big });
  check('CONTROL: body longer than the signed length is REJECTED', !r.ok, `http ${r.status}`);
  if (r.ok) {
    console.log('        !! R2 ignored the signed content-length — the size cap is decorative.');
    const h = await headBlob(bigKey);
    console.log('        !! stored anyway:', h.size, 'bytes');
  }
}

// 3. the cap is enforced before signing, too
{
  const h = crypto.createHash('sha256').update('x').digest('hex');
  let threw = false;
  try { presignPut(`${h}.jpg`, h, 300, MAX_BLOB_BYTES + 1); } catch { threw = true; }
  check('presign refuses a length over the cap', threw);
  let threw2 = false;
  try { presignPut(`${h}.jpg`, h, 300, 0); } catch { threw2 = true; }
  check('presign refuses a zero length', threw2);
  // CONTROL: a legal length must still sign, or the two above prove nothing.
  let ok = false;
  try { presignPut(`${h}.jpg`, h, 300, 1234); ok = true; } catch { /* */ }
  check('CONTROL: a legal length still signs', ok);
}

// cleanup
{
  const del = async (k) => {
    const { url, headers } = _signedHeaders('DELETE', k, null);
    const r = await fetch(url, { method: 'DELETE', headers });
    return r.ok || r.status === 404;
  };
  const gone = [];
  for (const k of cleanup) gone.push(await del(k).catch(() => false));
  check('cleaned up', gone.every(Boolean), `${gone.filter(Boolean).length}/${gone.length}`);
}

console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASSED — the signed length binds'}`);
process.exit(fails ? 1 : 0);
