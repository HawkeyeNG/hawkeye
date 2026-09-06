/**
 * Rehearse the whole backfill, end to end, against the real bucket.
 *
 *   BLOB_DRIVER=s3 node scripts/backfill_rehearsal.mjs
 *
 * RUN THIS DURING THE MOCK ELECTION. It is the dress rehearsal for the one
 * migration that cannot be undone by a config flip: moving evidence photos to
 * the bucket and then trusting the bucket to have them.
 *
 * It builds its OWN throwaway database and upload directory, so it never
 * touches real evidence, and it deletes every object it created. What it
 * exercises is the real code — backfill_blobs.mjs and backfill_check.mjs — the
 * real credentials and the real bucket.
 *
 * THE POINT IS STEP 5. Steps 1-4 show the tools reporting success, which is
 * exactly what they would do if they were checking nothing at all. Step 5
 * deletes one object out of the bucket behind the checker's back and requires
 * it to FAIL. A backfill audit that cannot detect a missing photo is worse than
 * no audit, because it will be believed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
const N = Number(process.argv[process.argv.indexOf('--n') + 1]) || 6;

if ((process.env.BLOB_DRIVER || 'fs') !== 's3') {
  console.error('Run with BLOB_DRIVER=s3 — the point is to rehearse against the real bucket.');
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-rehearsal-'));
const UPLOADS = path.join(TMP, 'uploads');
const DB_PATH = path.join(TMP, 'rehearsal.db');
fs.mkdirSync(UPLOADS, { recursive: true });

const env = { ...process.env, DB_PATH, UPLOAD_DIR: UPLOADS, BLOB_DRIVER: 's3', UPLOAD_MODE: 'proxy' };
const run = (script, args = []) => {
  try {
    return { ok: true, out: execFileSync('node', [path.join('scripts', script), ...args], { cwd: BACKEND, env, encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

let fails = 0;
const step = (n, label) => console.log(`\n=== ${n}. ${label} ===`);
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

// ---- 1. a corpus that looks like a small election --------------------------
step(1, `build ${N} fake submissions with real photo files`);
const keys = [];
{
  // SEEDED IN A CHILD, deliberately. An earlier version imported db.js here in
  // the parent, where DB_PATH was only ever set on the CHILD env — so the seed
  // rows went into the real development database while every child read the
  // empty temp one, and the rehearsal reported "0 photos" and passed steps it
  // had never exercised. Anything that opens the database must inherit the same
  // env the scripts under test do.
  const seeder = path.join(TMP, 'seed.mjs');
  fs.writeFileSync(seeder, `
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from ${JSON.stringify(path.join(BACKEND, 'src', 'db.js'))};
// FKs OFF for the seed only. submissions references observers(id) and
// polling_units(pu_code); populating both would make this harness depend on two
// more schemas to test something that has nothing to do with either. The
// backfill cares about image_sha256 / venue_image_sha256 and the files behind
// them, and those are real here.
db.pragma('foreign_keys = OFF');
const UPLOADS = ${JSON.stringify(UPLOADS)};
const N = ${N};
const ins = db.prepare(\`
  INSERT INTO submissions
    (pu_code, observer_id, votes_json, image_sha256, image_dhash, image_path,
     venue_image_sha256, venue_image_dhash, venue_image_path, lat, lng,
     location_verified, captured_at, venue_captured_at,
     location_proof, client_sig, ledger_payload, prev_hash, entry_hash, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\`);
// Real 16-hex dhashes: these rows stand in for PROXY-mode submissions, which
// always have them. A fresh database still declares the columns NOT NULL until
// someone asks for direct mode, and that guard firing here is correct.
const dh = () => crypto.randomBytes(8).toString('hex');
const out = [];
for (let i = 0; i < N; i++) {
  const mk = (tag) => {
    const buf = Buffer.concat([Buffer.from(tag + '-' + i + '-'), crypto.randomBytes(180 * 1024)]);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(path.join(UPLOADS, h + '.jpg'), buf);
    out.push(h + '.jpg');
    return h;
  };
  const sheet = mk('sheet'); const venue = mk('venue');
  ins.run('29-01-01-' + String(i + 1).padStart(3, '0'), 1, '[]', sheet, dh(),
    path.join(UPLOADS, sheet + '.jpg'), venue, dh(), path.join(UPLOADS, venue + '.jpg'),
    7.7, 4.5, 1, Date.now(), Date.now(), '{}', 'sig', '{}', 'prev', 'entry-' + i, Date.now());
}
console.log(JSON.stringify(out));
`);
  const seeded = execFileSync('node', [seeder], { cwd: BACKEND, env, encoding: 'utf8' });
  keys.push(...JSON.parse(seeded.trim().split('\n').pop()));
}
check(`${N * 2} photo files on local disk`, fs.readdirSync(UPLOADS).length === N * 2,
  `${fs.readdirSync(UPLOADS).length} files`);
// CONTROL: the scripts under test must SEE those rows, or every step below is
// auditing an empty database and passing for the wrong reason.
{
  const probe = run('backfill_check.mjs');
  const seen = /reference (\d+) distinct photo/.exec(probe.out)?.[1];
  check('the scripts under test see the seeded corpus', Number(seen) === N * 2, `${seen} photos`);
}

// ---- 2. dry run must change nothing ----------------------------------------
step(2, 'backfill dry run');
{
  const r = run('backfill_blobs.mjs');
  console.log(r.out.trim().split('\n').map((l) => '    ' + l).join('\n'));
  check('dry run succeeds', r.ok);
  check('dry run says DRY RUN', /DRY RUN/.test(r.out));
  const c = run('backfill_check.mjs');
  check('CONTROL: the check FAILS before the backfill', !c.ok,
    /MISSING from bucket: (\d+)/.exec(c.out)?.[0] || '');
}

// ---- 3. the real thing -----------------------------------------------------
step(3, 'backfill --apply');
{
  const r = run('backfill_blobs.mjs', ['--apply']);
  console.log(r.out.trim().split('\n').slice(-4).map((l) => '    ' + l).join('\n'));
  check('backfill succeeds', r.ok);
}

// ---- 4. and the audit agrees -----------------------------------------------
step(4, 'backfill_check --deep');
{
  const r = run('backfill_check.mjs', ['--deep']);
  console.log(r.out.trim().split('\n').slice(-8).map((l) => '    ' + l).join('\n'));
  check('deep check passes after a real backfill', r.ok);
  check('it audited every photo (no silent sampling)', !/PARTIAL/.test(r.out));
}

// ---- 5. THE ONE THAT MATTERS ----------------------------------------------
step(5, 'CONTROL: delete one object behind the checker and require a FAIL');
{
  const { _signedHeaders } = await import('../src/services/blobstore.js');
  const victim = keys[Math.floor(keys.length / 2)];
  const { url, headers } = _signedHeaders('DELETE', victim, null);
  const del = await fetch(url, { method: 'DELETE', headers });
  check('victim object deleted from the bucket', del.ok || del.status === 204, `http ${del.status}`);

  const r = run('backfill_check.mjs');
  const detected = !r.ok && r.out.includes(victim.slice(0, 16));
  check('the check DETECTS the missing photo', detected);
  if (!detected) {
    console.log('    !! The audit passed with a photo missing from the bucket.');
    console.log('    !! It cannot be trusted to gate the BLOB_DRIVER switch.');
    console.log(r.out.trim().split('\n').slice(-10).map((l) => '      ' + l).join('\n'));
  }
}

// ---- clean up --------------------------------------------------------------
step(6, 'clean up');
{
  const { _signedHeaders } = await import('../src/services/blobstore.js');
  let gone = 0;
  for (const k of keys) {
    const { url, headers } = _signedHeaders('DELETE', k, null);
    const r = await fetch(url, { method: 'DELETE', headers }).catch(() => ({ ok: false }));
    if (r.ok || r.status === 404 || r.status === 204) gone++;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  check('every rehearsal object removed from the bucket', gone === keys.length, `${gone}/${keys.length}`);
  check('temp database and uploads removed', !fs.existsSync(TMP));
}

console.log(`\n${fails ? `${fails} STEP(S) FAILED — do not rely on the backfill` : 'REHEARSAL PASSED — backfill and its audit both work, and the audit can fail'}`);
process.exit(fails ? 1 : 0);
