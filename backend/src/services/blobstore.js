import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Where evidence photos live.
 *
 * WHY. Every observer submission writes two photos to the origin's disk. At the
 * measured 365 KB per submission (216 KB sheet + 149 KB venue, through the
 * client's own 1500px/q0.76 and 1280px/q0.72 transforms) that is 55 GB at 10%
 * recruitment for 2027 and 554 GB at the ceiling — against a 120 GB shared-host
 * quota that also has to hold a 184 GB audit corpus. Disk is the binding
 * constraint long before bandwidth is.
 *
 * MOVING THE BYTES CHANGES NOTHING EVIDENTIARY, and that is what makes this a
 * storage adapter rather than a migration. The observer's signature covers
 * `imageSha256`/`venueImageSha256` — CONTENT HASHES. No path appears in the
 * signed payload, in `ledger_payload`, in `entry_hash`, or in the Rekor anchor.
 * `submissions.image_path` is a plain column that no hash reads. Anyone
 * verifying the chain fetches the file, hashes it, and compares — which works
 * identically whether the bytes came off local disk or out of a bucket, and
 * would still catch a storage layer that lied.
 *
 * KEYS ARE CONTENT HASHES ALREADY (`<sha256>.jpg`), so the store is immutable by
 * construction: a given key can never hold different bytes, re-uploading is a
 * no-op, and there is no cache-invalidation problem to have.
 *
 * NO NEW DEPENDENCY. `node_modules` on the production host is a symlink into a
 * CloudLinux virtualenv and there is no shell to run npm in, so the S3 request
 * signing is written here rather than installed. It is ~60 lines and the format
 * is stable.
 *
 * ROLLBACK IS ONE VARIABLE. `BLOB_DRIVER=fs` restores exactly today's behaviour,
 * and because the bucket copy is content-addressed and additive, rolling back
 * never destroys anything. Ship with `fs`, backfill, then switch.
 */

export const DRIVER = String(process.env.BLOB_DRIVER || 'fs').toLowerCase();

// READ LAZILY, not at module load. Freezing these at import makes the module
// untestable and, worse, means a value set later in boot is silently ignored —
// the kind of thing that surfaces as a 403 with no explanation. One object per
// upload costs nothing.
const s3 = () => ({
  endpoint: process.env.S3_ENDPOINT || '',      // e.g. https://<acct>.r2.cloudflarestorage.com
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'auto',
  key: process.env.S3_ACCESS_KEY_ID || '',
  secret: process.env.S3_SECRET_ACCESS_KEY || '',
  publicBase: process.env.S3_PUBLIC_BASE || '', // public read URL, if the bucket has one
});

/** A key is a bare content-addressed filename. Anything else is not ours. */
const KEY = /^[0-9a-f]{64}\.(jpg|jpeg|png|webp|mp4|mov|webm)$/i;
export const isBlobKey = (k) => KEY.test(String(k || ''));

const fsPath = (key) => path.join(config.uploadDir, key);

// ---- SigV4, enough of it for GET/PUT/HEAD on one object --------------------
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

function signedHeaders(method, key, body) {
  const S3 = s3();
  const url = new URL(`${S3.endpoint.replace(/\/+$/, '')}/${S3.bucket}/${key}`);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const payloadHash = body ? sha256hex(body) : sha256hex(Buffer.alloc(0));
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now,
  };
  const signedList = Object.keys(headers).sort().join(';');
  const canonical = [
    method,
    url.pathname,
    '',
    ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`),
    '',
    signedList,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(Buffer.from(canonical))].join('\n');
  let k = hmac(`AWS4${S3.secret}`, date);
  for (const part of [S3.region, 's3', 'aws4_request']) k = hmac(k, part);
  const sig = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope},`
    + `SignedHeaders=${signedList},Signature=${sig}`;
  return { url: url.toString(), headers };
}

// Exported for the test: signing is the part with no visible failure mode — a
// wrong canonical request returns 403, not a clue — so it is checked directly.
export const _signedHeaders = signedHeaders;

// ---- the interface ---------------------------------------------------------

export async function putBlob(key, buffer) {
  if (!isBlobKey(key)) throw new Error(`blobstore: refusing a non-content-addressed key: ${key}`);
  if (DRIVER === 'fs') { fs.writeFileSync(fsPath(key), buffer); return { driver: 'fs', key }; }
  const { url, headers } = signedHeaders('PUT', key, buffer);
  const r = await fetch(url, { method: 'PUT', headers, body: buffer });
  if (!r.ok) throw new Error(`blobstore: PUT ${key} -> ${r.status}`);
  return { driver: 's3', key };
}

export async function getBlob(key) {
  if (!isBlobKey(key)) throw new Error(`blobstore: refusing a non-content-addressed key: ${key}`);
  if (DRIVER === 'fs') return fs.readFileSync(fsPath(key));
  const { url, headers } = signedHeaders('GET', key, null);
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`blobstore: GET ${key} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export function hasBlob(key) {
  if (DRIVER !== 'fs') return null;             // unknown without a round trip
  return isBlobKey(key) && fs.existsSync(fsPath(key));
}

/**
 * Where a browser should be sent for this key, or null to serve it ourselves.
 * With a public bucket the origin never touches the bytes at all.
 */
export function publicUrl(key) {
  const S3 = s3();
  if (DRIVER === 'fs' || !S3.publicBase) return null;
  return `${S3.publicBase.replace(/\/+$/, '')}/${key}`;
}

/** Loud at boot rather than at the first submission on election night. */
export function assertConfigured() {
  if (DRIVER === 'fs') return { driver: 'fs', dir: config.uploadDir };
  const S3 = s3();
  const missing = ['endpoint', 'bucket', 'key', 'secret'].filter((f) => !S3[f]);
  if (missing.length) throw new Error(`blobstore: BLOB_DRIVER=s3 but missing ${missing.join(', ')}`);
  return { driver: 's3', bucket: S3.bucket, endpoint: S3.endpoint, publicBase: S3.publicBase || null };
}
