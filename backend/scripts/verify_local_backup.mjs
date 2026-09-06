/**
 * Is the local backup actually a backup?
 *
 *   node scripts/verify_local_backup.mjs /mnt/hawkeye-backup
 *   node scripts/verify_local_backup.mjs /mnt/hawkeye-backup --quick
 *   node scripts/verify_local_backup.mjs /mnt/hawkeye-backup --sample 500
 *   node scripts/verify_local_backup.mjs --self-test
 *
 * THE FILENAME IS THE CHECKSUM. Every evidence object is stored as
 * `<sha256>.jpg`, so a local copy can be verified against nothing but itself:
 * hash the bytes, compare to the name. No manifest to trust, no second system
 * to agree with, and it catches silent corruption on the drive as readily as a
 * truncated download.
 *
 * WHAT IT CHECKS
 *   1. every photo the EVIDENCE CHAIN references exists locally  — the question
 *      that actually matters, asked of the database, not of the backup
 *   2. every local file hashes to its own name                    — integrity
 *   3. the database snapshot is present and is a valid gzip
 *
 * --quick skips the hashing and checks existence and size only. Use it for a
 * weekly cron; run the full hash monthly, because bit rot is exactly what the
 * quick check cannot see.
 *
 * --self-test proves the verifier can FAIL: it builds a sandbox containing one
 * good file, one corrupt file and one missing file, and asserts it reports
 * exactly those. A verifier that always passes is worse than none, because it
 * will be believed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const QUICK = argv.includes('--quick');
const SAMPLE = Number(argv[argv.indexOf('--sample') + 1]) || 0;
const DEST = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));

const KEY_RE = /^([0-9a-f]{64})\.(jpg|jpeg|png|webp|mp4|mov|webm)$/i;

function hashFile(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * The core check, factored out so --self-test drives exactly the same code the
 * real run does. A self-test that exercises a different path proves nothing.
 */
function checkDir(evidenceDir, { quick = false, sample = 0, referenced = null } = {}) {
  const out = { total: 0, checked: 0, corrupt: [], foreign: [], missing: [], skipped: 0 };
  if (!fs.existsSync(evidenceDir)) return { ...out, absent: true };

  let files = fs.readdirSync(evidenceDir).filter((f) => !f.startsWith('.'));
  out.total = files.length;
  if (sample && sample < files.length) {
    const step = files.length / sample;
    files = Array.from({ length: sample }, (_, i) => files[Math.floor(i * step)]);
    out.skipped = out.total - files.length;
  }

  for (const f of files) {
    const p = path.join(evidenceDir, f);
    const m = KEY_RE.exec(f);
    if (!m) { out.foreign.push(f); continue; }
    out.checked += 1;
    if (quick) {
      if (fs.statSync(p).size === 0) out.corrupt.push(`${f}: zero bytes`);
      continue;
    }
    const actual = hashFile(p);
    if (actual !== m[1].toLowerCase()) out.corrupt.push(`${f}: bytes hash to ${actual.slice(0, 16)}…`);
  }

  if (referenced) {
    const have = new Set(fs.readdirSync(evidenceDir));
    for (const k of referenced) if (!have.has(k)) out.missing.push(k);
  }
  return out;
}

// ---------------------------------------------------------------- self test
if (SELF_TEST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-selftest-'));
  const ev = path.join(dir, 'evidence');
  fs.mkdirSync(ev);

  const good = Buffer.from('a genuine evidence photo');
  const goodKey = `${crypto.createHash('sha256').update(good).digest('hex')}.jpg`;
  fs.writeFileSync(path.join(ev, goodKey), good);

  // A file whose NAME says one thing and whose BYTES say another — silent
  // corruption, the failure this whole check exists to catch.
  const corruptKey = `${crypto.createHash('sha256').update('what it claims to be').digest('hex')}.jpg`;
  fs.writeFileSync(path.join(ev, corruptKey), Buffer.from('but this is what is actually there'));

  const missingKey = `${crypto.createHash('sha256').update('never copied across').digest('hex')}.jpg`;
  fs.writeFileSync(path.join(ev, 'not-content-addressed.txt'), 'stray');

  const r = checkDir(ev, { referenced: [goodKey, missingKey] });
  const ok =
    r.corrupt.length === 1 && r.corrupt[0].startsWith(corruptKey)
    && r.missing.length === 1 && r.missing[0] === missingKey
    && r.foreign.length === 1 && r.foreign[0] === 'not-content-addressed.txt'
    && r.checked === 2;

  console.log('self-test:');
  console.log(`  corrupt detected : ${r.corrupt.length} (want 1)`);
  console.log(`  missing detected : ${r.missing.length} (want 1)`);
  console.log(`  foreign detected : ${r.foreign.length} (want 1)`);
  console.log(`  files hashed     : ${r.checked} (want 2)`);
  // CONTROL: the good file must NOT be reported. A checker that flags
  // everything catches corruption too, and is equally useless.
  const flaggedGood = r.corrupt.some((c) => c.startsWith(goodKey));
  console.log(`  good file left alone: ${flaggedGood ? 'NO — it flags everything' : 'yes'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${ok && !flaggedGood ? 'SELF-TEST PASSED — the verifier can fail' : 'SELF-TEST FAILED'}`);
  process.exit(ok && !flaggedGood ? 0 : 1);
}

// ---------------------------------------------------------------- real run
if (!DEST) {
  console.error('usage: node scripts/verify_local_backup.mjs <destination-dir> [--quick|--sample N]');
  process.exit(2);
}

// What the evidence chain REQUIRES. Asked of the database, because "every file
// I copied is intact" is a different and much weaker claim than "every photo
// the ledger points at is here".
let referenced = null;
try {
  const { db } = await import('../src/db.js');
  const keys = new Set();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const { name } of tables) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all()
      .map((c) => c.name).filter((c) => /sha256/i.test(c));
    if (!cols.length) continue;
    for (const r of db.prepare(`SELECT ${cols.join(', ')} FROM ${name}`).all()) {
      for (const c of cols) {
        const v = r[c];
        if (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) keys.add(`${v.toLowerCase()}.jpg`);
      }
    }
  }
  referenced = [...keys];
  console.log(`the evidence chain references ${referenced.length} distinct photo(s)`);
} catch (e) {
  console.log(`could not read the database (${e.message}) — checking integrity only, not completeness`);
}

const ev = path.join(DEST, 'evidence');
console.log(`checking ${ev}${QUICK ? '  (quick: existence and size only)' : ''}${SAMPLE ? `  (sample ${SAMPLE})` : ''}\n`);
const r = checkDir(ev, { quick: QUICK, sample: SAMPLE, referenced });

if (r.absent) {
  console.error(`FAIL: ${ev} does not exist — has the backup ever run?`);
  process.exit(1);
}

console.log(`  files present    : ${r.total}`);
console.log(`  ${QUICK ? 'checked' : 'hashed '}          : ${r.checked}${r.skipped ? `  (${r.skipped} skipped by --sample)` : ''}`);
console.log(`  CORRUPT          : ${r.corrupt.length}`);
console.log(`  MISSING (referenced but not here): ${r.missing.length}`);
console.log(`  not ours         : ${r.foreign.length}`);
for (const c of r.corrupt.slice(0, 10)) console.log(`    corrupt  ${c}`);
for (const m of r.missing.slice(0, 10)) console.log(`    missing  ${m}`);

// ---- the database snapshot -------------------------------------------------
const dbDir = path.join(DEST, 'db');
let dbOk = false;
if (fs.existsSync(dbDir)) {
  const snaps = fs.readdirSync(dbDir).filter((f) => f.endsWith('.db.gz')).sort();
  const latest = snaps[snaps.length - 1];
  if (latest) {
    try {
      // Decompress it. A .gz that will not open is not a backup, and the only
      // way to know is to open it.
      const buf = zlib.gunzipSync(fs.readFileSync(path.join(dbDir, latest)));
      dbOk = buf.subarray(0, 15).toString() === 'SQLite format 3';
      console.log(`\n  db snapshot      : ${latest} — ${dbOk ? 'valid SQLite' : 'DECOMPRESSED BUT NOT SQLITE'}`);
    } catch (e) {
      console.log(`\n  db snapshot      : ${latest} — FAILED TO DECOMPRESS (${e.message})`);
    }
  } else console.log('\n  db snapshot      : none found');
} else console.log('\n  db snapshot      : db/ directory absent');

const bad = r.corrupt.length + r.missing.length;
if (r.skipped) console.log(`\nNOTE: ${r.skipped} file(s) were NOT checked. This is not a clean bill of health.`);
if (QUICK) console.log('NOTE: --quick did not hash anything. Bit rot is exactly what it cannot see.');
console.log(`\n${bad === 0 && dbOk ? 'PASSED' : 'FAILED'}`);
process.exit(bad === 0 && dbOk ? 0 : 1);
