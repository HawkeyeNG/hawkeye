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

// ---- presigned PUT: the client uploads, the origin never sees the bytes -----
//
// WHY THIS EXISTS. putBlob() above sends the bytes from the SERVER, which means
// every photo crosses the origin twice: inbound from the observer, then
// outbound to the bucket. GO54 confirmed in writing on 2026-09-06 that inbound
// counts toward the 150 GB monthly allowance ("providers measure traffic at the
// network interface level, not just what is served out"). So switching
// BLOB_DRIVER to s3 as it stands FIXES the 120 GB disk cap and roughly DOUBLES
// the bandwidth problem. That is the opposite of the intended effect.
//
// A presigned URL moves the transfer off the origin entirely: the phone PUTs
// straight to R2 and the origin handles only a few hundred bytes of JSON.
//
// INTEGRITY IS NOT WEAKENED, and this is the part worth being careful about.
// The URL is signed for ONE key and ONE checksum:
//   * the key is the content hash the client claims (`<sha256>.jpg`), and
//   * `x-amz-checksum-sha256` is a SIGNED header, so the client cannot drop o
//     alter it without invalidating the signature.
// R2 verifies the body against that checksum and rejects a mismatch with 400.
// An object therefore cannot exist at key X unless its bytes hash to X — which
// is exactly the property the ledger relies on, and it is now enforced by the
// storage layer rather than by the origin having read the file.
//
// WHAT IS GENUINELY LOST is analysis, not integrity. The origin can no longe
// compute the perceptual dhash, extract ORB venue features, or OCR the sheet at
// submission time, because it does not have the pixels. Those must move to a
// worker that pulls from the bucket (R2 egress is free) — see
// docs/DIRECT-UPLOAD.md. Duplicate detection changes from a synchronous
// rejection into a prompt asynchronous flag. That is a real behaviour change
// and must be a decision, not a side effect.

/**
 * A presigned PUT URL for one content-addressed key.
 *
 * @param {string} key       `<sha256>.jpg`
 * @param {string} sha256Hex the same hash, hex — bound into the signature
 * @param {number} expiresIn seconds; keep short, the client uploads immediately
 */
export function presignPut(key, sha256Hex, expiresIn = 300) {
  if (!isBlobKey(key)) throw new Error(`blobstore: refusing a non-content-addressed key: ${key}`);
  if (!/^[0-9a-f]{64}$/i.test(String(sha256Hex || ''))) {
    throw new Error('blobstore: presignPut needs a hex sha256');
  }
  // The key IS the hash, so a mismatch here would sign a URL that can never be
  // satisfied — fail now rather than at the phone on election night.
  if (key.slice(0, 64).toLowerCase() !== String(sha256Hex).toLowerCase()) {
    throw new Error('blobstore: presignPut key does not match its sha256');
  }
  const S3 = s3();
  const missing = ['endpoint', 'bucket', 'key', 'secret'].filter((f) => !S3[f]);
  if (missing.length) throw new Error(`blobstore: presignPut needs ${missing.join(', ')}`);

  const checksumB64 = Buffer.from(String(sha256Hex), 'hex').toString('base64');
  const url = new URL(`${S3.endpoint.replace(/\/+$/, '')}/${S3.bucket}/${key}`);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const scope = `${date}/${S3.region}/s3/aws4_request`;

  // host is implicit in the request; the checksum header is what makes the URL
  // usable for these bytes and no others.
  const signedHeaderNames = 'host;x-amz-checksum-sha256';
  const q = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${S3.key}/${scope}`,
    'X-Amz-Date': now,
    'X-Amz-Expires': String(Math.max(1, Math.floor(expiresIn))),
    'X-Amz-SignedHeaders': signedHeaderNames,
  });
  // Query string must be sorted by key for the canonical request.
  const canonicalQuery = [...q.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k2, v]) => `${encodeURIComponent(k2)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonical = [
    'PUT',
    url.pathname,
    canonicalQuery,
    `host:${url.host}`,
    `x-amz-checksum-sha256:${checksumB64}`,
    '',
    signedHeaderNames,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(Buffer.from(canonical))].join('\n');
  let k = hmac(`AWS4${S3.secret}`, date);
  for (const part of [S3.region, 's3', 'aws4_request']) k = hmac(k, part);
  const sig = crypto.createHmac('sha256', k).update(toSign).digest('hex');

  return {
    url: `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${sig}`,
    method: 'PUT',
    // The client MUST send these verbatim or the signature fails / R2 rejects.
    headers: { 'x-amz-checksum-sha256': checksumB64 },
    expiresIn,
    key,
  };
}

/**
 * Does this object exist, and how big is it? HEAD transfers no body, so
 * confirming an upload costs the origin a few hundred bytes rather than a photo.
 */
export async function headBlob(key) {
  if (!isBlobKey(key)) throw new Error(`blobstore: refusing a non-content-addressed key: ${key}`);
  if (DRIVER === 'fs') {
    const p = fsPath(key);
    return fs.existsSync(p) ? { exists: true, size: fs.statSync(p).size } : { exists: false, size: 0 };
  }
  const { url, headers } = signedHeaders('HEAD', key, null);
  const r = await fetch(url, { method: 'HEAD', headers });
  if (r.status === 404) return { exists: false, size: 0 };
  if (!r.ok) throw new Error(`blobstore: HEAD ${key} -> ${r.status}`);
  return { exists: true, size: Number(r.headers.get('content-length') || 0) };
}

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
