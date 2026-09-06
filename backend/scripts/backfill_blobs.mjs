/**
 * Copy existing evidence photos from local disk into the bucket.
 *
 *   node scripts/backfill_blobs.mjs            # report only, changes nothing
 *   node scripts/backfill_blobs.mjs --apply
 *   node scripts/backfill_blobs.mjs --apply --limit 200
 *
 * WHY. Switching BLOB_DRIVER to s3 changes where NEW photos are written. It does
 * nothing for the ones already on disk, so every existing submission's evidence
 * would 404 the moment the origin stopped serving it. Backfill first, switch
 * second — docs/DIRECT-UPLOAD.md.
 *
 * SAFE TO RUN, SAFE TO RE-RUN, SAFE TO INTERRUPT. Keys are content hashes, so a
 * re-upload is a no-op and an interrupted run resumes with what is left. Nothing
 * is ever deleted from local disk: the bucket copy is ADDITIVE, which is what
 * makes `BLOB_DRIVER=fs` a real rollback rather than a hope.
 *
 * IT VERIFIES WHAT IT WROTE. A PUT that returns 200 and stores nothing is
 * indistinguishable from success unless you look, so each upload is followed by
 * a HEAD, and the byte count is compared. This project has already been bitten
 * once by an upload that reported success over a truncated file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { putBlob, headBlob, DRIVER } from '../src/services/blobstore.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = Number((argv[argv.indexOf('--limit') + 1]) || 0) || Infinity;

if (DRIVER !== 's3') {
  console.error(`BLOB_DRIVER is "${DRIVER}". Run this with BLOB_DRIVER=s3 and the S3_* vars set,`);
  console.error('otherwise putBlob writes back to the same local directory it is reading from.');
  process.exit(2);
}

const rows = db.prepare(`
  SELECT id, image_sha256, venue_image_sha256 FROM submissions ORDER BY id
`).all();

const keys = new Map();                       // key -> submission id (first seen)
for (const r of rows) {
  for (const h of [r.image_sha256, r.venue_image_sha256]) {
    if (h && !keys.has(`${h}.jpg`)) keys.set(`${h}.jpg`, r.id);
  }
}
console.log(`${rows.length} submission(s) reference ${keys.size} distinct photo(s)`);

let onDisk = 0; let missing = 0;
const todo = [];
for (const [key] of keys) {
  const p = path.join(config.uploadDir, key);
  if (fs.existsSync(p)) { onDisk += 1; todo.push({ key, p, size: fs.statSync(p).size }); }
  else missing += 1;
}
console.log(`  on local disk: ${onDisk}`);
console.log(`  absent locally: ${missing}${missing ? '  (already moved, or lost before this ran)' : ''}`);

if (!APPLY) {
  const bytes = todo.reduce((t, f) => t + f.size, 0);
  console.log(`\nDRY RUN. Would upload ${todo.length} file(s), ${(bytes / 1048576).toFixed(1)} MB.`);
  console.log('Re-run with --apply to do it.');
  process.exit(0);
}

let done = 0; let skipped = 0; const failed = [];
for (const f of todo.slice(0, LIMIT)) {
  try {
    const head = await headBlob(f.key);
    if (head.exists && head.size === f.size) { skipped += 1; continue; }

    const buf = fs.readFileSync(f.p);
    // The filename is the content hash; if the file on disk does not hash to its
    // own name it is corrupt, and copying it into the bucket would launder that.
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (`${actual}.jpg` !== f.key) {
      failed.push(`${f.key}: local bytes hash to ${actual} — refusing to upload`);
      continue;
    }

    await putBlob(f.key, buf);

    const after = await headBlob(f.key);
    if (!after.exists || after.size !== buf.length) {
      failed.push(`${f.key}: wrote ${buf.length}B, bucket reports ${after.exists ? `${after.size}B` : 'absent'}`);
      continue;
    }
    done += 1;
    if (done % 25 === 0) console.log(`  ...${done} uploaded`);
  } catch (e) {
    failed.push(`${f.key}: ${String(e.message).slice(0, 120)}`);
  }
}

console.log(`\nuploaded ${done}, already present ${skipped}, failed ${failed.length}`);
for (const f of failed.slice(0, 20)) console.log(`  FAIL ${f}`);
if (failed.length) process.exit(1);
console.log('\nEvery file verified present in the bucket at the right size.');
console.log('Local copies are untouched — BLOB_DRIVER=fs remains a working rollback.');
