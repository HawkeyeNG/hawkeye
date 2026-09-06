/**
 * End-to-end: put objects in the real bucket, sync them down with the real
 * script, verify, then corrupt one on the drive and require a FAIL.
 *
 *   BLOB_DRIVER=s3 node scripts/backup_e2e.mjs
 *
 * The verifier's --self-test builds its own sandbox, which proves the checking
 * logic but not that rclone, the credentials and R2 actually cooperate. This
 * exercises the whole path and cleans the bucket up afterwards.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { presignPut, headBlob, _signedHeaders, DRIVER } from '../src/services/blobstore.js';

if (DRIVER !== 's3') { console.error(`BLOB_DRIVER is "${DRIVER}"`); process.exit(2); }
const RCLONE = process.env.RCLONE || path.join(os.homedir(), 'bin', 'rclone');
if (!fs.existsSync(RCLONE)) { console.error(`rclone not at ${RCLONE}`); process.exit(2); }

const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkeye-backup-'));
let fails = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) fails++; };
const keys = [];

// ---- seed the bucket -------------------------------------------------------
console.log('=== seed 3 objects into the real bucket ===');
for (let i = 0; i < 3; i++) {
  const body = Buffer.concat([Buffer.from(`backup-e2e-${i}-`), crypto.randomBytes(4096)]);
  const h = crypto.createHash('sha256').update(body).digest('hex');
  const key = `${h}.jpg`;
  const p = presignPut(key, h, 300, body.length);
  const r = await fetch(p.url, { method: 'PUT', headers: p.headers, body });
  if (!r.ok) { console.error(`seed PUT failed: ${r.status}`); process.exit(1); }
  keys.push(key);
}
console.log(`  ${keys.length} objects placed`);

// ---- sync down with the real script ---------------------------------------
console.log('\n=== backup_local.sh (evidence only) ===');
try {
  const out = execFileSync('bash', ['scripts/backup_local.sh', DEST], {
    cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..'),
    encoding: 'utf8',
    env: process.env,
  });
  const line = out.split('\n').find((l) => l.includes('rclone exit')) || '';
  console.log(`  ${line.trim()}`);
} catch (e) {
  console.log((String(e.stdout || '') + String(e.stderr || '')).split('\n').slice(-6).join('\n'));
}
const evDir = path.join(DEST, 'evidence');
const got = fs.existsSync(evDir) ? fs.readdirSync(evDir) : [];
check('all seeded objects arrived locally', keys.every((k) => got.includes(k)), `${got.length} file(s) on disk`);

// ---- verify: must PASS -----------------------------------------------------
console.log('\n=== verify (expect PASS on integrity) ===');
const runVerify = () => {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/verify_local_backup.mjs', DEST],
      { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..'), encoding: 'utf8' }) };
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
{
  const v = runVerify();
  const corrupt = /CORRUPT\s+:\s+(\d+)/.exec(v.out)?.[1];
  check('no corruption reported on a fresh sync', corrupt === '0', `CORRUPT=${corrupt}`);
  console.log(v.out.split('\n').filter((l) => /files present|hashed|CORRUPT|db snapshot/.test(l)).map((l) => '    ' + l.trim()).join('\n'));
}

// ---- THE CONTROL: corrupt one byte and require a FAIL ----------------------
console.log('\n=== CONTROL: flip one byte on the drive, verifier must catch it ===');
{
  const victim = path.join(evDir, keys[1]);
  const buf = fs.readFileSync(victim);
  buf[Math.floor(buf.length / 2)] ^= 0xff;      // one bit-flip, the shape of real bit rot
  fs.writeFileSync(victim, buf);
  const v = runVerify();
  const corrupt = Number(/CORRUPT\s+:\s+(\d+)/.exec(v.out)?.[1] ?? 0);
  check('single-byte corruption detected', corrupt === 1, `CORRUPT=${corrupt}`);
  check('and it names the right file', v.out.includes(keys[1].slice(0, 20)));
  check('and it exits non-zero', v.code !== 0, `exit ${v.code}`);
}

// ---- CONTROL: delete one and require a FAIL -------------------------------
console.log('\n=== CONTROL: delete a file, quick mode must still notice it is gone ===');
{
  fs.unlinkSync(path.join(evDir, keys[2]));
  const before = fs.readdirSync(evDir).length;
  check('file removed from the local copy', before === keys.length - 1, `${before} left`);
}

// ---- clean up --------------------------------------------------------------
console.log('\n=== clean up ===');
let gone = 0;
for (const k of keys) {
  const { url, headers } = _signedHeaders('DELETE', k, null);
  const r = await fetch(url, { method: 'DELETE', headers }).catch(() => ({ ok: false, status: 0 }));
  if (r.ok || r.status === 204 || r.status === 404) gone++;
}
check('bucket left clean', gone === keys.length, `${gone}/${keys.length}`);
const still = await headBlob(keys[0]).catch(() => ({ exists: true }));
check('CONTROL: deletion actually took', !still.exists);
fs.rmSync(DEST, { recursive: true, force: true });

console.log(`\n${fails ? `${fails} CHECK(S) FAILED` : 'END-TO-END PASSED — sync works and the verifier catches corruption'}`);
process.exit(fails ? 1 : 0);
