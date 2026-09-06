/**
 * Did the backfill actually move every photo the ledger references?
 *
 *   BLOB_DRIVER=s3 node scripts/backfill_check.mjs              # audit everything
 *   BLOB_DRIVER=s3 node scripts/backfill_check.mjs --sample 200
 *   BLOB_DRIVER=s3 node scripts/backfill_check.mjs --deep       # also re-hash the bytes
 *
 * RUN THIS DURING THE MOCK ELECTION, after backfill_blobs.mjs and before
 * flipping BLOB_DRIVER=s3 for real. `backfill_blobs.mjs` reports what IT did;
 * this asks the database what the evidence chain NEEDS and checks each of those
 * against the bucket. The two are different questions, and only the second one
 * matters: a backfill that skipped a row it never saw looks like a clean run.
 *
 * WHAT IT CHECKS, per photo the submissions table references:
 *   - present in the bucket
 *   - stored size matches the local copy (when one still exists)
 *   - --deep: the bucket's bytes actually hash to the key they are stored under
 *   - the local copy is still there, so BLOB_DRIVER=fs remains a real rollback
 *
 * NO SILENT CAPS. With --sample it says exactly how many it skipped. A partial
 * audit reported as a clean one is the failure this whole script exists to
 * prevent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { headBlob, getBlob, DRIVER } from '../src/services/blobstore.js';

const argv = process.argv.slice(2);
const DEEP = argv.includes('--deep');
const SAMPLE = Number(argv[argv.indexOf('--sample') + 1]) || 0;

if (DRIVER !== 's3') {
  console.error(`BLOB_DRIVER is "${DRIVER}" — run with BLOB_DRIVER=s3, or this audits local disk against itself.`);
  process.exit(2);
}

const rows = db.prepare(`
  SELECT id, pu_code, contest, image_sha256, venue_image_sha256
  FROM submissions ORDER BY id
`).all();

/** Every distinct photo the evidence chain depends on, and who references it. */
const refs = new Map();                       // key -> [submission ids]
for (const r of rows) {
  for (const h of [r.image_sha256, r.venue_image_sha256]) {
    if (!h) continue;
    const k = `${h}.jpg`;
    if (!refs.has(k)) refs.set(k, []);
    refs.get(k).push(r.id);
  }
}

let keys = [...refs.keys()];
const total = keys.length;
let skipped = 0;
if (SAMPLE && SAMPLE < total) {
  // Deterministic spread, not the first N: the first N are the oldest rows and
  // would hide a failure that only affects recent ones.
  const step = total / SAMPLE;
  keys = Array.from({ length: SAMPLE }, (_, i) => keys[Math.floor(i * step)]);
  skipped = total - keys.length;
}

console.log(`${rows.length} submission(s) reference ${total} distinct photo(s)`);
console.log(`auditing ${keys.length}${skipped ? `  (SKIPPING ${skipped} — this is a PARTIAL audit)` : ' (all of them)'}`);
console.log(`mode: ${DEEP ? 'deep (re-hashing bucket bytes)' : 'shallow (existence + size)'}\n`);

const bad = { missing: [], sizeMismatch: [], hashMismatch: [], localGone: [], error: [] };
let okCount = 0;
let checked = 0;

for (const key of keys) {
  checked += 1;
  if (checked % 100 === 0) console.log(`  ...${checked}/${keys.length}`);
  const local = path.join(config.uploadDir, key);
  const hasLocal = fs.existsSync(local);
  if (!hasLocal) bad.localGone.push(key);       // not fatal, but rollback is thinner

  let head;
  try {
    head = await headBlob(key);
  } catch (e) {
    bad.error.push(`${key}: HEAD ${String(e.message).slice(0, 80)}`);
    continue;
  }
  if (!head.exists) {
    bad.missing.push(`${key} (submissions ${refs.get(key).slice(0, 3).join(',')})`);
    continue;
  }
  if (hasLocal && head.size !== fs.statSync(local).size) {
    bad.sizeMismatch.push(`${key}: bucket ${head.size} vs local ${fs.statSync(local).size}`);
    continue;
  }
  if (DEEP) {
    try {
      const buf = await getBlob(key);
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (`${actual}.jpg` !== key) {
        bad.hashMismatch.push(`${key}: bytes hash to ${actual}`);
        continue;
      }
    } catch (e) {
      bad.error.push(`${key}: GET ${String(e.message).slice(0, 80)}`);
      continue;
    }
  }
  okCount += 1;
}

// CONTROL. If a key that was never uploaded comes back "present", every check
// above is meaningless — the audit would pass on an empty bucket.
const ghost = `${crypto.createHash('sha256').update(`never-uploaded-${process.pid}`).digest('hex')}.jpg`;
const ghostHead = await headBlob(ghost).catch(() => ({ exists: true }));
const controlOk = !ghostHead.exists;

console.log(`\n--- results ---`);
console.log(`  verified in bucket : ${okCount}/${keys.length}`);
console.log(`  MISSING from bucket: ${bad.missing.length}`);
console.log(`  size mismatch      : ${bad.sizeMismatch.length}`);
if (DEEP) console.log(`  hash mismatch      : ${bad.hashMismatch.length}`);
console.log(`  errors             : ${bad.error.length}`);
console.log(`  local copy gone    : ${bad.localGone.length}  (rollback to BLOB_DRIVER=fs would not cover these)`);
console.log(`  control (a never-uploaded key reports absent): ${controlOk ? 'ok' : 'FAILED — the audit cannot detect absence'}`);

for (const [label, list] of Object.entries(bad)) {
  if (!list.length) continue;
  console.log(`\n  ${label}:`);
  for (const x of list.slice(0, 15)) console.log(`    ${x}`);
  if (list.length > 15) console.log(`    ...and ${list.length - 15} more`);
}

const fatal = bad.missing.length + bad.sizeMismatch.length + bad.hashMismatch.length + bad.error.length;
if (skipped) {
  console.log(`\nNOTE: ${skipped} photo(s) were NOT audited. This is not a clean bill of health for the corpus.`);
}
console.log(`\n${fatal === 0 && controlOk
  ? (skipped ? 'SAMPLE PASSED — re-run without --sample before switching' : 'PASSED — every referenced photo is in the bucket')
  : 'FAILED — do not switch BLOB_DRIVER until these are resolved'}`);
process.exit(fatal === 0 && controlOk ? 0 : 1);
