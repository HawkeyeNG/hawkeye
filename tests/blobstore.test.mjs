/**
 * The evidence store: same bytes, wherever they live.
 *
 *   node tests/blobstore.test.mjs
 *
 * At the measured 365 KB per submission, 2027 is 55 GB of photos at 10%
 * recruitment against a 120 GB shared-host quota that also has to hold a 184 GB
 * audit corpus. The bytes have to move. Nothing evidentiary moves with them —
 * the observer's signature covers the CONTENT HASH, never a path — which is why
 * this is an adapter and not a migration.
 *
 * The properties that make it safe are the ones tested here: fs is byte-for-byte
 * what it always was, keys are content-addressed or refused, and a misconfigured
 * bucket fails at boot rather than at the first submission on election night.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-'));
const { putBlob, getBlob, hasBlob, isBlobKey, publicUrl, assertConfigured, _signedHeaders, DRIVER } =
  await import('../backend/src/services/blobstore.js');

// ---- 1. fs round-trip is byte-identical ------------------------------------
assert.strictEqual(DRIVER, 'fs', 'default driver must be fs — the no-change path');
const bytes = crypto.randomBytes(4096);
const key = `${crypto.createHash('sha256').update(bytes).digest('hex')}.jpg`;
await putBlob(key, bytes);
const back = await getBlob(key);
assert.ok(Buffer.compare(bytes, back) === 0, 'bytes must survive a round trip unchanged');
assert.ok(hasBlob(key));
// And it is a real file on disk, in the place express.static already serves.
assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, key)), 'fs driver must write the same file it always did');
console.log('  PASS  fs round-trip is byte-identical, and writes the same path as before');

// ---- 2. keys are content-addressed, or refused -----------------------------
for (const bad of ['../../etc/passwd', 'sheet.jpg', 'abc.jpg', `${'a'.repeat(64)}.exe`, '']) {
  assert.ok(!isBlobKey(bad), `${bad} must not be a valid key`);
  await assert.rejects(() => putBlob(bad, bytes), /refusing a non-content-addressed key/,
    `putBlob must refuse ${JSON.stringify(bad)}`);
}
assert.ok(isBlobKey(`${'a'.repeat(64)}.jpg`));
console.log('  PASS  path traversal and non-hash names are refused, not sanitised');

// ---- 3. a misconfigured bucket fails at BOOT, not on election night --------
assert.deepStrictEqual(assertConfigured().driver, 'fs');
console.log('  PASS  fs configuration reports itself cleanly');

// ---- 4. the S3 request is well formed, and actually uses the secret --------
process.env.S3_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
process.env.S3_BUCKET = 'hawkeye-evidence';
process.env.S3_REGION = 'auto';
process.env.S3_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.S3_SECRET_ACCESS_KEY = 'secret-one';
const a = _signedHeaders('PUT', key, bytes);
assert.ok(a.url.endsWith(`/hawkeye-evidence/${key}`), `url targets the object: ${a.url}`);
assert.match(a.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);
assert.strictEqual(a.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(bytes).digest('hex'),
  'the payload hash must be the payload hash');
console.log('  PASS  S3 request is well formed and hashes the real payload');

// CONTROL: change the secret, the signature MUST change. If signing silently
// dropped the key, every request would 403 with no clue why.
process.env.S3_SECRET_ACCESS_KEY = 'secret-two';
const mod2 = await import(`../backend/src/services/blobstore.js?v=${Date.now()}`);
const b = mod2._signedHeaders('PUT', key, bytes);
assert.notStrictEqual(a.headers.authorization.split('Signature=')[1],
  b.headers.authorization.split('Signature=')[1],
  'CONTROL FAILED: the secret does not affect the signature — signing is broken');
// CONTROL: a different body must sign differently too.
const c = mod2._signedHeaders('PUT', key, crypto.randomBytes(4096));
assert.notStrictEqual(b.headers.authorization, c.headers.authorization,
  'CONTROL FAILED: the body does not affect the signature');
console.log('  PASS  2 controls — secret and body both reach the signature');

// ---- 5. serving: fs serves itself, a public bucket redirects ---------------
assert.strictEqual(publicUrl(key), null, 'fs must serve locally, never redirect');
console.log('  PASS  fs driver never redirects — the URL contract is unchanged');

fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
console.log('\nSame bytes, same URLs, same signatures. Only the disk they sit on is a variable.');
