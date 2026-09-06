/**
 * Delete bucket objects that no evidence row references.
 *
 *   BLOB_DRIVER=s3 node scripts/sweep_orphans.mjs               # dry run
 *   BLOB_DRIVER=s3 node scripts/sweep_orphans.mjs --apply
 *   BLOB_DRIVER=s3 node scripts/sweep_orphans.mjs --min-age-h 48 --apply
 *
 * WHY. A presigned URL can be issued, the phone can PUT to it, and the
 * submission can then fail or be abandoned — leaving an object nothing points
 * at, forever. Bounded per observer by the presign rate limit and the signed
 * 8 MB length, so it is a cost leak rather than a safety problem, but at
 * election-night volume "forever" adds up.
 *
 * ═══ THIS SCRIPT DELETES EVIDENCE IF IT IS WRONG ═══
 *
 * Every guard below exists because the failure mode is not "a few stale files
 * survive" — it is "the photos behind signed reports are gone, and the ledger
 * entries that reference them can never be verified again". The bias is
 * overwhelmingly toward keeping things.
 *
 *   1. The referenced set is built from the LIVE SCHEMA, not a hard-coded table
 *      list. There are two tables today (submissions, collation_reports); a
 *      third added later would otherwise be silently unprotected, which is
 *      exactly the kind of mistake nobody notices until an audit fails.
 *   2. It REFUSES to run if the database has no evidence rows at all. A failed
 *      query, an empty test database or a wrong DB_PATH would otherwise mean
 *      "nothing is referenced" and delete the entire bucket.
 *   3. Objects younger than --min-age-h (default 24) are never touched: an
 *      upload in flight, or a report queued in an outbox for hours, has its
 *      photos in the bucket before the row exists.
 *   4. If orphans exceed --max-fraction (default 0.25) of the bucket it stops
 *      and asks for --force. A sweep that wants to delete most of the bucket is
 *      far more likely to be a bug than a real result.
 *   5. Every deletion is verified with a HEAD, and it re-checks the reference
 *      set immediately before each delete.
 */
import crypto from 'node:crypto';
import { db } from '../src/db.js';
import { headBlob, DRIVER, _signedHeaders, isBlobKey } from '../src/services/blobstore.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(argv[i + 1])) ? Number(argv[i + 1]) : dflt;
};
const MIN_AGE_H = num('--min-age-h', 24);
const MAX_FRACTION = num('--max-fraction', 0.25);

if (DRIVER !== 's3') {
  console.error(`BLOB_DRIVER is "${DRIVER}" — this sweeps a bucket, not local disk.`);
  process.exit(2);
}

const S3 = {
  endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'auto',
  key: process.env.S3_ACCESS_KEY_ID || '',
  secret: process.env.S3_SECRET_ACCESS_KEY || '',
};

// ---- 1. what the evidence chain references, from the live schema -----------
function referencedKeys() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const sources = [];
  for (const { name } of tables) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all()
      .map((c) => c.name)
      .filter((c) => /sha256/i.test(c));
    if (cols.length) sources.push({ table: name, cols });
  }
  const keys = new Set();
  let rows = 0;
  for (const s of sources) {
    const list = db.prepare(`SELECT ${s.cols.join(', ')} FROM ${s.table}`).all();
    rows += list.length;
    for (const r of list) {
      for (const c of s.cols) {
        const v = r[c];
        if (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) keys.add(`${v.toLowerCase()}.jpg`);
      }
    }
  }
  return { keys, sources, rows };
}

const { keys: referenced, sources, rows } = referencedKeys();
console.log('reference sources (discovered from the schema):');
for (const s of sources) console.log(`  ${s.table.padEnd(24)} ${s.cols.join(', ')}`);
console.log(`\n${rows} evidence row(s) referencing ${referenced.size} distinct object(s)`);

// GUARD 2 — the one that prevents deleting everything.
if (rows === 0) {
  console.error('\nREFUSING: this database has no evidence rows at all.');
  console.error('Every object in the bucket would look orphaned. Check DB_PATH.');
  process.exit(1);
}

// ---- 2. what is actually in the bucket -------------------------------------
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

function signedGet(query) {
  const url = new URL(`${S3.endpoint}/${S3.bucket}`);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const payloadHash = sha256hex(Buffer.alloc(0));
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now };
  const names = Object.keys(headers).sort();
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonical = ['GET', url.pathname, canonicalQuery,
    ...names.map((h) => `${h}:${headers[h]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(Buffer.from(canonical))].join('\n');
  let k = hmac(`AWS4${S3.secret}`, date);
  for (const p of [S3.region, 's3', 'aws4_request']) k = hmac(k, p);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope},`
    + `SignedHeaders=${names.join(';')},Signature=${crypto.createHmac('sha256', k).update(toSign).digest('hex')}`;
  return { url: `${url.toString()}?${canonicalQuery}`, headers };
}

const xml = (body, tag) => [...body.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);

async function listAll() {
  const out = [];
  let token = null;
  for (let page = 0; page < 10_000; page++) {
    const q = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
    if (token) q.set('continuation-token', token);
    const { url, headers } = signedGet(q);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`ListObjectsV2 -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.text();
    const keys = xml(body, 'Key');
    const dates = xml(body, 'LastModified');
    const sizes = xml(body, 'Size');
    for (let i = 0; i < keys.length; i++) {
      out.push({ key: keys[i], modified: Date.parse(dates[i]), size: Number(sizes[i]) });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(body)) break;
    token = xml(body, 'NextContinuationToken')[0];
    if (!token) break;
  }
  return out;
}

const objects = await listAll();
const totalBytes = objects.reduce((t, o) => t + o.size, 0);
console.log(`bucket holds ${objects.length} object(s), ${(totalBytes / 1048576).toFixed(1)} MB`);

// ---- 3. the orphans --------------------------------------------------------
const cutoff = Date.now() - MIN_AGE_H * 3600_000;
const orphans = [];
const tooYoung = [];
const foreign = [];
for (const o of objects) {
  if (referenced.has(o.key)) continue;
  // A key that is not content-addressed was not written by us. Report it and
  // leave it alone — guessing about someone else's object is not this script's
  // job.
  if (!isBlobKey(o.key)) { foreign.push(o); continue; }
  if (!(o.modified < cutoff)) { tooYoung.push(o); continue; }
  orphans.push(o);
}

const orphanBytes = orphans.reduce((t, o) => t + o.size, 0);
console.log(`\n  referenced        : ${objects.length - orphans.length - tooYoung.length - foreign.length}`);
console.log(`  too young (<${MIN_AGE_H}h) : ${tooYoung.length}  (an upload in flight, or a report still in an outbox)`);
console.log(`  not ours (skipped): ${foreign.length}`);
console.log(`  ORPHANED          : ${orphans.length}  (${(orphanBytes / 1048576).toFixed(1)} MB)`);

for (const o of orphans.slice(0, 10)) {
  console.log(`    ${o.key}  ${(o.size / 1024).toFixed(0)} KB  ${new Date(o.modified).toISOString()}`);
}
if (orphans.length > 10) console.log(`    ...and ${orphans.length - 10} more`);

if (!orphans.length) {
  console.log('\nnothing to sweep');
  process.exit(0);
}

// GUARD 4 — a sweep that wants most of the bucket is probably a bug.
const fraction = orphans.length / objects.length;
if (fraction > MAX_FRACTION && !FORCE) {
  console.error(`\nREFUSING: ${(fraction * 100).toFixed(1)}% of the bucket looks orphaned `
    + `(limit ${(MAX_FRACTION * 100).toFixed(0)}%).`);
  console.error('That is more likely a bug — a partial database, a wrong DB_PATH — than a real result.');
  console.error('Investigate, then re-run with --force if it is genuinely correct.');
  process.exit(1);
}

if (!APPLY) {
  console.log(`\nDRY RUN. Would delete ${orphans.length} object(s), ${(orphanBytes / 1048576).toFixed(1)} MB.`);
  console.log('Re-run with --apply.');
  process.exit(0);
}

// Snapshot a sample of REFERENCED objects before touching anything, so the
// control at the end measures what THIS SWEEP did. An earlier version simply
// checked that referenced objects exist, which reported a PRE-EXISTING gap as
// though the sweep had caused it — an alarm that fires for the wrong reason is
// one nobody trusts the second time. Gaps that predate a sweep are
// backfill_check.mjs's job, not this script's.
const sample = [...referenced].slice(0, 25);
const presentBefore = [];
for (const k of sample) {
  if ((await headBlob(k).catch(() => ({ exists: false }))).exists) presentBefore.push(k);
}
console.log(`\nsampled ${sample.length} referenced object(s); ${presentBefore.length} present before the sweep`);

// ---- 4. delete, re-checking each one ---------------------------------------
let deleted = 0;
const failed = [];
for (const o of orphans) {
  // GUARD 5 — re-check immediately before deleting. Cheap, and the listing may
  // be minutes old by now on a large bucket.
  if (referencedKeys().keys.has(o.key)) {
    console.log(`  skip (now referenced): ${o.key}`);
    continue;
  }
  const { url, headers } = _signedHeaders('DELETE', o.key, null);
  const r = await fetch(url, { method: 'DELETE', headers });
  if (!r.ok && r.status !== 204 && r.status !== 404) { failed.push(`${o.key}: http ${r.status}`); continue; }
  const still = await headBlob(o.key).catch(() => ({ exists: true }));
  if (still.exists) { failed.push(`${o.key}: still present after DELETE`); continue; }
  deleted += 1;
  if (deleted % 50 === 0) console.log(`  ...${deleted}/${orphans.length}`);
}

console.log(`\ndeleted ${deleted}/${orphans.length}, reclaimed ~${(orphanBytes / 1048576).toFixed(1)} MB`);
for (const f of failed.slice(0, 15)) console.log(`  FAIL ${f}`);

// CONTROL: nothing that was present AND referenced may have gone. This is the
// failure the whole script exists to prevent, so it is measured rather than
// assumed — and measured as a difference, so a pre-existing gap cannot be
// mistaken for damage this sweep did.
const lost = [];
for (const k of presentBefore) {
  if (!(await headBlob(k).catch(() => ({ exists: false }))).exists) lost.push(k);
}
console.log(`control (referenced objects that survived): ${presentBefore.length - lost.length}/${presentBefore.length}`);
if (lost.length) {
  console.error('*** THE SWEEP DELETED REFERENCED EVIDENCE ***');
  for (const k of lost.slice(0, 10)) console.error(`    ${k}`);
}
process.exit(failed.length || lost.length ? 1 : 0);
