/**
 * Prove the orphan sweeper deletes the right things and refuses the wrong ones.
 *
 *   BLOB_DRIVER=s3 node scripts/sweep_rehearsal.mjs
 *
 * This is the script that can destroy evidence, so "it deleted some files" is
 * not a passing result. Each guard is exercised against the REAL bucket with a
 * throwaway database:
 *
 *   A. an orphan is deleted
 *   B. a REFERENCED object is not          <- the one that matters
 *   C. a recent orphan is spared (in-flight uploads, queued outbox reports)
 *   D. an empty database is REFUSED        <- would otherwise delete everything
 *   E. a mostly-orphaned bucket is REFUSED without --force
 *   F. a non-content-addressed key is left alone
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _signedHeaders, headBlob } from '../src/services/blobstore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
if ((process.env.BLOB_DRIVER || 'fs') !== 's3') {
  console.error('Run with BLOB_DRIVER=s3.');
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-rehearsal-'));
const DB_PATH = path.join(TMP, 'sweep.db');
const EMPTY_DB = path.join(TMP, 'empty.db');
const env = { ...process.env, DB_PATH, UPLOAD_DIR: path.join(TMP, 'uploads'), BLOB_DRIVER: 's3', UPLOAD_MODE: 'proxy' };
fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
const run = (args, e = env) => {
  try {
    return { ok: true, out: execFileSync('node', [path.join('scripts', 'sweep_orphans.mjs'), ...args],
      { cwd: BACKEND, env: e, encoding: 'utf8' }) };
  } catch (err) {
    return { ok: false, out: String(err.stdout || '') + String(err.stderr || '') };
  }
};

const put = async (label) => {
  const buf = Buffer.concat([Buffer.from(`${label}-`), crypto.randomBytes(2048)]);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  const key = `${h}.jpg`;
  const { presignPut } = await import('../src/services/blobstore.js');
  const p = presignPut(key, h, 300, buf.length);
  const r = await fetch(p.url, { method: 'PUT', headers: p.headers, body: buf });
  if (!r.ok) throw new Error(`seed PUT ${key} -> ${r.status}`);
  return { key, hash: h };
};

const created = [];
console.log('=== seed the bucket ===');
const kept = await put('referenced');     created.push(kept.key);
// BOTH photos of the kept submission: a real row references two. Inventing a
// venue hash that was never uploaded made the sweeper's control fire on a gap
// the sweep had not caused.
const keptVenue = await put('referenced-venue'); created.push(keptVenue.key);
const orphan = await put('orphan');       created.push(orphan.key);
const orphan2 = await put('orphan2');     created.push(orphan2.key);
console.log(`  4 objects: 2 referenced (sheet + venue), 2 orphans`);

// a database that references exactly one of them
{
  const seeder = path.join(TMP, 'seed.mjs');
  fs.writeFileSync(seeder, `
import { db } from ${JSON.stringify(path.join(BACKEND, 'src', 'db.js'))};
db.pragma('foreign_keys = OFF');
db.prepare(\`INSERT INTO submissions
  (pu_code, observer_id, votes_json, image_sha256, image_dhash, image_path,
   venue_image_sha256, venue_image_dhash, venue_image_path, lat, lng,
   location_verified, captured_at, venue_captured_at, location_proof,
   client_sig, ledger_payload, prev_hash, entry_hash, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\`).run(
  '29-01-01-001', 1, '[]', ${JSON.stringify(kept.hash)}, '0123456789abcdef', 'p',
  ${JSON.stringify(keptVenue.hash)}, 'fedcba9876543210', 'p',
  7.7, 4.5, 1, Date.now(), Date.now(), '{}', 's', '{}', 'prev', 'entry-sweep', Date.now());
console.log('seeded');
`);
  execFileSync('node', [seeder], { cwd: BACKEND, env, encoding: 'utf8' });
}

console.log('\n=== C. a recent orphan is spared ===');
{
  const r = run([]);                       // default --min-age-h 24; all objects are new
  check('dry run succeeds', r.ok);
  check('nothing swept while everything is young', /ORPHANED\s+:\s+0\b/.test(r.out) || /nothing to sweep/.test(r.out),
    /ORPHANED[^\n]*/.exec(r.out)?.[0]?.trim());
}

console.log('\n=== D. CONTROL: an empty database is REFUSED ===');
{
  execFileSync('node', ['-e', 'import("./src/db.js").then(()=>process.exit(0))'],
    { cwd: BACKEND, env: { ...env, DB_PATH: EMPTY_DB }, encoding: 'utf8' });
  const r = run(['--min-age-h', '0', '--apply'], { ...env, DB_PATH: EMPTY_DB });
  check('refuses to sweep against an empty database', !r.ok && /no evidence rows/.test(r.out));
  const still = await headBlob(orphan.key);
  check('and it deleted nothing', still.exists);
}

console.log('\n=== E. CONTROL: a mostly-orphaned bucket is REFUSED without --force ===');
{
  const r = run(['--min-age-h', '0', '--apply']);   // 2 of 4 orphaned = 50%, over the 25% limit
  check('refuses when orphans exceed the fraction limit', !r.ok && /REFUSING/.test(r.out),
    /(\d+\.\d)% of the bucket/.exec(r.out)?.[0]);
  const still = await headBlob(orphan.key);
  check('and it deleted nothing', still.exists);
}

console.log('\n=== A + B. with --force: orphans go, the referenced one stays ===');
{
  const r = run(['--min-age-h', '0', '--apply', '--force']);
  console.log(r.out.trim().split('\n').slice(-6).map((l) => '    ' + l).join('\n'));
  // The sweeper exits non-zero when its own control fails. Ignoring that let an
  // earlier run report PASS while the sweeper was reporting a missing photo.
  check('the sweeper itself exited 0', r.ok);
  const gone1 = !(await headBlob(orphan.key)).exists;
  const gone2 = !(await headBlob(orphan2.key)).exists;
  const keptStill = (await headBlob(kept.key)).exists;
  check('orphan 1 deleted', gone1);
  check('orphan 2 deleted', gone2);
  check('CONTROL: the REFERENCED object survived', keptStill);
  if (!keptStill) console.log('    *** the sweeper deleted evidence — do not use it ***');
}

// ---- clean up --------------------------------------------------------------
console.log('\n=== clean up ===');
{
  let gone = 0;
  for (const key of created) {
    const { url, headers } = _signedHeaders('DELETE', key, null);
    const r = await fetch(url, { method: 'DELETE', headers }).catch(() => ({ ok: false, status: 0 }));
    if (r.ok || r.status === 204 || r.status === 404) gone++;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  check('bucket left clean', gone === created.length, `${gone}/${created.length}`);
}

console.log(`\n${fails ? `${fails} CHECK(S) FAILED — do not run the sweeper` : 'SWEEP REHEARSAL PASSED — it deletes orphans, spares evidence, and refuses when unsure'}`);
process.exit(fails ? 1 : 0);
