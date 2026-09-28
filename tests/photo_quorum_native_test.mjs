/**
 * D1 PHOTO QUORUM — the native client.
 *
 *   node tests/photo_quorum_native_test.mjs
 *
 * 1. native/src/lib/evidence.ts, compiled for real with tsc and run against a
 *    file system stub backed by a temp directory (its one external import):
 *    a hash-only report's photos are copied into the app's own evidence store,
 *    read back at full size, and kept until 31 July 2027 — with no reference
 *    to the "keep copies on this phone" switch at all.
 * 2. The wiring in submit.ts / outbox.ts / result.tsx, checked structurally
 *    (they import the whole app; the direct-upload half is exercised for real
 *    in tests/rn-direct-upload.test.mjs). Each rule has a mutated-copy CONTROL.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const H = '/home/elrio/hawkeye';
const NATIVE = path.join(H, 'native');
const LIB = path.join(NATIVE, 'src', 'lib');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-evidence-'));
const DOCS = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-docs-'));

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  if (!ok) fails++;
};

// ---- compile the REAL evidence.ts with an fs-backed expo-file-system -------
const src = fs.readFileSync(path.join(LIB, 'evidence.ts'), 'utf8');
const IMPORT_RE = /^import \{ Directory, File, Paths \} from ['"]expo-file-system['"];?$/m;
assert.ok(IMPORT_RE.test(src), 'expo-file-system import not found — did evidence.ts change?');
const STUB = `
import nodeFs from 'node:fs';
import nodePath from 'node:path';
const toPath = (b) => (typeof b === 'string' ? b.replace(/^file:\\/\\//, '') : b.path);
class Directory {
  constructor(base, ...parts) { this.path = nodePath.join(toPath(base), ...parts); this.uri = 'file://' + this.path; }
  get exists() { return nodeFs.existsSync(this.path); }
  create() { nodeFs.mkdirSync(this.path, { recursive: true }); }
}
class File {
  constructor(base, ...parts) { this.path = parts.length ? nodePath.join(toPath(base), ...parts) : toPath(base); this.uri = 'file://' + this.path; }
  get exists() { return nodeFs.existsSync(this.path); }
  get size() { try { return nodeFs.statSync(this.path).size; } catch { return null; } }
  async copy(dest) { if (globalThis.__FAIL_COPY__) throw new Error('disk full'); nodeFs.copyFileSync(this.path, dest.path); }
  async text() { return nodeFs.readFileSync(this.path, 'utf8'); }
  write(s) { nodeFs.writeFileSync(this.path, s); }
  create() { nodeFs.mkdirSync(nodePath.dirname(this.path), { recursive: true }); nodeFs.writeFileSync(this.path, ''); }
  delete() { nodeFs.unlinkSync(this.path); }
}
const Paths = { document: new Directory('file://' + globalThis.__DOCS__) };`;
fs.writeFileSync(path.join(OUT, 'evidence.ts'), '// @ts-nocheck\n' + src.replace(IMPORT_RE, STUB));
try {
  execFileSync(path.join(NATIVE, 'node_modules', '.bin', 'tsc'), [
    'evidence.ts', '--outDir', OUT, '--target', 'es2022', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--skipLibCheck',
  ], { cwd: OUT, stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:\n' + String(e.stdout || '') + String(e.stderr || ''));
  process.exit(1);
}
globalThis.__DOCS__ = DOCS;
const E = await import(pathToFileURL(path.join(OUT, 'evidence.js')).href);

// Two captured photos in the camera cache (as capture-camera leaves them).
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-cache-'));
const shot = (name, bytes) => { const p = path.join(CACHE, name); fs.writeFileSync(p, Buffer.from(bytes)); return 'file://' + p; };
const SHEET = { slot: 'sheet', uri: shot('sheet.jpg', [1, 2, 3, 4, 5, 6, 7]), sha256: 'a'.repeat(64) };
const VENUE = { slot: 'venue', uri: shot('venue.jpg', [9, 8, 7]), sha256: 'b'.repeat(64) };
const KEEP_UNTIL = Date.UTC(2027, 6, 31, 23, 0, 0);
const kept = (sha) => path.join(DOCS, 'evidence', `${sha}.jpg`);

console.log('=== evidence.ts ===');
check('EVIDENCE_KEEP_UNTIL is the end of 31 July 2027 in Lagos', E.EVIDENCE_KEEP_UNTIL, KEEP_UNTIL);
{
  const ok = await E.keepEvidence({ puCode: '24-14-01-020', contest: 'PRES', photos: [SHEET, VENUE], now: Date.UTC(2027, 0, 16) });
  check('keepEvidence resolves true', ok, true);
  check('both photos copied into <document>/evidence/<sha>.jpg at full size',
    [fs.statSync(kept(SHEET.sha256)).size, fs.statSync(kept(VENUE.sha256)).size], [7, 3]);
  // The camera cache can now be reclaimed by the OS: the evidence copy stands alone.
  fs.rmSync(CACHE, { recursive: true, force: true });
  check('...and they survive the camera cache being emptied', fs.existsSync(kept(SHEET.sha256)), true);
  const list = await E.listEvidence();
  check('the index lists both, kept until 31 July 2027',
    list.map((e) => [e.slot, e.keepUntil, e.puCode, e.contest]).sort(),
    [['sheet', KEEP_UNTIL, '24-14-01-020', 'PRES'], ['venue', KEEP_UNTIL, '24-14-01-020', 'PRES']]);
}
{
  const bad = await E.keepEvidence({ puCode: 'x', contest: 'PRES', photos: [{ slot: 'sheet', uri: 'file:///nope/gone.jpg', sha256: 'c'.repeat(64) }] });
  check('a photo that cannot be read is NOT reported as kept (caller uploads)', bad, false);
  const badHash = await E.keepEvidence({ puCode: 'x', contest: 'PRES', photos: [{ slot: 'sheet', uri: SHEET.uri, sha256: 'not-a-hash' }] });
  check('a malformed hash is refused', badHash, false);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-cache2-'));
  const p = path.join(fresh, 's.jpg'); fs.writeFileSync(p, Buffer.from([1, 2]));
  globalThis.__FAIL_COPY__ = true;
  const failed = await E.keepEvidence({ puCode: 'x', contest: 'PRES', photos: [{ slot: 'sheet', uri: 'file://' + p, sha256: 'd'.repeat(64) }] });
  globalThis.__FAIL_COPY__ = false;
  check('a copy that throws (disk full) is NOT reported as kept', failed, false);
  // CONTROL: the same file, copy working, IS kept.
  const worked = await E.keepEvidence({ puCode: 'x', contest: 'PRES', photos: [{ slot: 'sheet', uri: 'file://' + p, sha256: 'd'.repeat(64) }] });
  check('control: the same photo with a working copy IS kept', worked, true);
  fs.rmSync(fresh, { recursive: true, force: true });
}
{
  check('prune on 31 July 2027 deletes nothing', await E.pruneEvidence(Date.UTC(2027, 6, 31, 12)), 0);
  check('...the photos are still there', fs.existsSync(kept(SHEET.sha256)), true);
  const removed = await E.pruneEvidence(Date.UTC(2027, 7, 2));
  check('prune on 2 August 2027 removes the expired entries', removed >= 2, true);
  check('...and their files', fs.existsSync(kept(SHEET.sha256)) || fs.existsSync(kept(VENUE.sha256)), false);
  check('a report kept in September 2027 gets 180 days of its own', E.keepUntil(Date.UTC(2027, 8, 1)), Date.UTC(2027, 8, 1) + 180 * 864e5);
}

// ---- the wiring --------------------------------------------------------------
console.log('\n=== wiring (structure) ===');
const read = (f) => fs.readFileSync(path.join(NATIVE, 'src', f), 'utf8');
const evidenceSrc = src;
const submit = read('lib/submit.ts');
const outbox = read('lib/outbox.ts');
const result = read('app/report/result.tsx');

// Code only: the doc comment names save-to-device.ts to say this is NOT it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const evidenceIgnoresSwitch = (s) => !/save-to-device|isSaveToDeviceEnabled|hawkeye_save_report_media/.test(code(s));
check('evidence.ts never reads the "keep copies" switch (kept regardless)', evidenceIgnoresSwitch(evidenceSrc), true);
check('control: a copy that consults the switch is caught',
  evidenceIgnoresSwitch(evidenceSrc.replace("from 'expo-file-system';", "from 'expo-file-system';\nimport { isSaveToDeviceEnabled } from '@/lib/save-to-device';")), false);

const submitRules = (s) => [
  /withFigures && !input\.dryRun/.test(s), // a rehearsal never offers
  /keep: \(\) =>\s*keepEvidence\(/.test(s), // hash-only only after the copy
  /if \(hashOnly && res\.status === 409\)[\s\S]{0,200}why\.error === 'photo_not_uploaded'[\s\S]{0,80}await plan\(false\)/.test(s),
  /photosOnDevice: hashOnly/.test(s),
];
check('submit.ts: dry runs never offer; keep before hash-only; 409 falls back; result says so', submitRules(submit), [true, true, true, true]);
check('control: removing the 409 fallback is caught', submitRules(submit.replace('await plan(false)', 'null'))[2], false);

const outboxRules = (s) => [
  /keep: \(\) =>\s*keepEvidence\(/.test(s),
  /first\.hashOnly[\s\S]{0,160}isRetryable409\(first\.res\)[\s\S]{0,40}attempt\(job, token, deviceId, false\)/.test(s),
];
check('outbox.ts: keeps before hash-only, falls back on 409 in the same flush', outboxRules(outbox), [true, true]);
check('control: removing the outbox fallback is caught', outboxRules(outbox.replace('attempt(job, token, deviceId, false)', 'first'))[1], false);

check('result.tsx tells the observer, in a translated line',
  /r\.photosOnDevice[\s\S]{0,160}n\.app\.report\.result\.photos-kept-as-evidence/.test(result), true);
const batch = JSON.parse(fs.readFileSync(path.join(H, 'scripts/i18n/batches/d1_native.json'), 'utf8'));
const line = batch['n.app.report.result.photos-kept-as-evidence'];
check('...the key has en/ha/ig/yo, NFC', !!line && ['en', 'ha', 'ig', 'yo'].every((l) => line[l] && line[l] === line[l].normalize('NFC')), true);

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(DOCS, { recursive: true, force: true });
console.log(`\n${fails ? `${fails} FAILURE(S)` : 'photo_quorum_native: all checks passed'}`);
process.exit(fails ? 1 : 0);
