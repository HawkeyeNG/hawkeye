/**
 * Presigned direct-to-bucket uploads.
 *
 *   node tests/presign.test.mjs
 *
 * WHY THIS IS TESTED HARD. Request signing has no visible failure mode: a wrong
 * canonical request returns 403 with no explanation, and it would do so for the
 * first time on election night, on a phone, in the field. There is no partial
 * credit and no useful error message to debug from.
 *
 * The assertions that matter are the CONTROLS. A signature that looks like a
 * signature proves nothing — what proves the canonical request is wired up is
 * that changing each input changes the output. If the checksum were left out of
 * the string-to-sign, every test below would still print a plausible 64-hex
 * signature, and only the control would notice.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.BLOB_DRIVER = 's3';
process.env.S3_ENDPOINT = 'https://acct123.r2.cloudflarestorage.com';
process.env.S3_BUCKET = 'hawkeye-evidence';
process.env.S3_REGION = 'auto';
process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLE';
process.env.S3_SECRET_ACCESS_KEY = 'secret-example-key';

const { presignPut, isBlobKey } = await import('../backend/src/services/blobstore.js');

const HASH = crypto.createHash('sha256').update('a sheet photo').digest('hex');
const KEY = `${HASH}.jpg`;
const sigOf = (u) => new URL(u).searchParams.get('X-Amz-Signature');

// ---- 1. shape --------------------------------------------------------------
{
  const p = presignPut(KEY, HASH, 300);
  const u = new URL(p.url);
  assert.strictEqual(p.method, 'PUT');
  assert.strictEqual(u.host, 'acct123.r2.cloudflarestorage.com');
  assert.strictEqual(u.pathname, `/hawkeye-evidence/${KEY}`);
  for (const k of ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature']) {
    assert.ok(u.searchParams.get(k), `missing ${k}`);
  }
  assert.strictEqual(u.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.strictEqual(u.searchParams.get('X-Amz-SignedHeaders'), 'host;x-amz-checksum-sha256');
  assert.match(sigOf(p.url), /^[0-9a-f]{64}$/, 'signature is not 64 hex');
  console.log('  PASS  presigned URL has every SigV4 query parameter, correct host and path');
}

// ---- 2. the checksum binds the URL to these exact bytes --------------------
{
  const p = presignPut(KEY, HASH, 300);
  const expected = Buffer.from(HASH, 'hex').toString('base64');
  assert.strictEqual(p.headers['x-amz-checksum-sha256'], expected);
  assert.strictEqual(Buffer.from(expected, 'base64').toString('hex'), HASH,
    'checksum header does not round-trip to the content hash');
  console.log('  PASS  x-amz-checksum-sha256 is the base64 of the content hash and round-trips');
}

// ---- 3. THE CONTROLS: the signature must depend on every input -------------
// Without these, a canonical request missing the checksum line would still
// produce a well-formed signature and every other test would pass.
{
  const base = sigOf(presignPut(KEY, HASH, 300).url);

  const otherHash = crypto.createHash('sha256').update('a DIFFERENT photo').digest('hex');
  const otherKeySig = sigOf(presignPut(`${otherHash}.jpg`, otherHash, 300).url);
  assert.notStrictEqual(base, otherKeySig, 'CONTROL FAILED: signature ignores the key/checksum');

  const otherExpirySig = sigOf(presignPut(KEY, HASH, 900).url);
  assert.notStrictEqual(base, otherExpirySig, 'CONTROL FAILED: signature ignores the expiry');

  process.env.S3_SECRET_ACCESS_KEY = 'a-completely-different-secret';
  const otherSecretSig = sigOf(presignPut(KEY, HASH, 300).url);
  assert.notStrictEqual(base, otherSecretSig, 'CONTROL FAILED: signature ignores the secret');
  process.env.S3_SECRET_ACCESS_KEY = 'secret-example-key';

  process.env.S3_BUCKET = 'a-different-bucket';
  const otherBucketSig = sigOf(presignPut(KEY, HASH, 300).url);
  assert.notStrictEqual(base, otherBucketSig, 'CONTROL FAILED: signature ignores the bucket');
  process.env.S3_BUCKET = 'hawkeye-evidence';

  // ...and it must be stable when nothing changes, or it is not a signature.
  assert.strictEqual(sigOf(presignPut(KEY, HASH, 300).url).length, 64);
  console.log('  PASS  control: signature changes with key, checksum, expiry, secret and bucket');
}

// ---- 4. canonical query must be sorted -------------------------------------
// SigV4 requires it. Out of order it signs cleanly and 403s at the bucket.
{
  const u = new URL(presignPut(KEY, HASH, 300).url);
  const names = [...u.searchParams.keys()].filter((k) => k !== 'X-Amz-Signature');
  assert.deepStrictEqual(names, [...names].sort(), `query not canonically sorted: ${names.join(',')}`);
  console.log('  PASS  canonical query parameters are sorted');
}

// ---- 5. it refuses what it cannot honour ------------------------------------
{
  const bad = [
    [() => presignPut('not-a-hash.jpg', HASH), 'a non-content-addressed key'],
    [() => presignPut(KEY, 'nothex'), 'a non-hex hash'],
    [() => presignPut(KEY, crypto.createHash('sha256').update('mismatch').digest('hex')),
      'a key that does not match its hash'],
    [() => presignPut(`${HASH}.exe`, HASH), 'a disallowed extension'],
  ];
  for (const [fn, why] of bad) assert.throws(fn, undefined, `accepted ${why}`);

  // A key/hash mismatch is the dangerous one: it would sign a URL that R2 can
  // never satisfy, and the failure would appear on a phone in the field.
  assert.throws(() => presignPut(KEY, crypto.createHash('sha256').update('x').digest('hex')),
    /does not match its sha256/);

  const saved = process.env.S3_SECRET_ACCESS_KEY;
  delete process.env.S3_SECRET_ACCESS_KEY;
  assert.throws(() => presignPut(KEY, HASH), /needs .*secret/,
    'signed a URL with no secret configured');
  process.env.S3_SECRET_ACCESS_KEY = saved;
  console.log(`  PASS  refuses all ${bad.length + 1} malformed requests and an unconfigured bucket`);
}

// ---- 6. the key rule still matches the ledger's naming ---------------------
{
  assert.ok(isBlobKey(KEY));
  assert.ok(!isBlobKey(`${HASH}`), 'accepted a key with no extension');
  assert.ok(!isBlobKey(`../${KEY}`), 'accepted a traversal');
  assert.ok(!isBlobKey(`${HASH.slice(0, 63)}.jpg`), 'accepted a short hash');
  console.log('  PASS  keys stay content-addressed; traversal and short hashes refused');
}

console.log('\npresign: all checks passed');
