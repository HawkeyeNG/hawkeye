/**
 * The RN direct-upload path must degrade to multipart on every failure.
 *
 *   node tests/rn-direct-upload.test.mjs
 *
 * The native app has no test runner, and adding Jest to an Expo project to
 * cover one module is not a trade worth making. But `direct-upload.ts` has
 * exactly ONE external import (expo-file-system) and otherwise uses global
 * fetch, so it can be compiled and exercised for real: this transpiles the
 * actual source with tsc, swaps that single import for a stub, and runs the
 * same failure matrix the web twin gets in tests/... via the browser.
 *
 * WHY IT MATTERS MORE HERE THAN ON THE WEB. The native client is shipped
 * through two app stores. A web mistake is fixed by a deploy; a native one
 * waits on review. And the thing being tested is the property that the whole
 * design leans on — that an observer at a polling unit never loses a report
 * because a storage optimisation was unavailable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.join(HERE, '..', 'native');
const SRC = path.join(NATIVE, 'src', 'lib', 'direct-upload.ts');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-direct-'));

// ---- compile the REAL file -------------------------------------------------
// The one external import is swapped for a stub BEFORE compiling: tsc cannot
// resolve expo-file-system outside the app, and it is the only thing standing
// between this module and plain Node. Done by an explicit, asserted replacement
// so that if the module ever stops matching, the test fails loudly rather than
// quietly testing a stub of itself.
const tsSrc = fs.readFileSync(SRC, 'utf8');
const IMPORT_RE = /^import \{ File \} from ['"]expo-file-system['"];?$/m;
assert.ok(IMPORT_RE.test(tsSrc), 'expo-file-system import not found — did the module change?');
const STUB = `
const FILES = globalThis.__TEST_FILES__;
class File {
  uri;
  constructor(uri) { this.uri = uri; }
  async arrayBuffer() {
    const v = FILES[this.uri];
    if (!v) throw new Error('no such file: ' + this.uri);
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  }
}`;
// @ts-nocheck on the SCRATCH copy only: this compile is transpilation, and the
// stub above deliberately is not typed. The real type check is `npx tsc
// --noEmit` in native/, which covers this module properly.
fs.writeFileSync(path.join(OUT, 'direct-upload.ts'),
  '// @ts-nocheck\n' + tsSrc.replace(IMPORT_RE, STUB));

// Compiled from a scratch directory: tsc refuses file arguments when a
// tsconfig.json sits in the working directory (TS5112), and native/ has one.
try {
  execFileSync(path.join(NATIVE, 'node_modules', '.bin', 'tsc'), [
    'direct-upload.ts',
    '--outDir', OUT,
    '--target', 'es2022',
    '--module', 'esnext',
    '--moduleResolution', 'bundler',
    '--skipLibCheck',
  ], { cwd: OUT, stdio: 'pipe' });
} catch (e) {
  // execFileSync throws with stdout as a Buffer; printed raw it is a wall of
  // byte codes and tells you nothing. Say what tsc actually said.
  console.error('tsc failed:\n' + String(e.stdout || '') + String(e.stderr || ''));
  process.exit(1);
}

const compiled = path.join(OUT, 'direct-upload.js');

globalThis.__TEST_FILES__ = {
  'file:///sheet.jpg': new Uint8Array([1, 2, 3, 4, 5]),
  'file:///venue.jpg': new Uint8Array([9, 8, 7]),
};
const { uploadDirect } = await import(pathToFileURL(compiled).href);

const ARGS = {
  token: 't', deviceId: 'd',
  sheetUri: 'file:///sheet.jpg', venueUri: 'file:///venue.jpg',
  sheetSha256: 'a'.repeat(64), venueSha256: 'b'.repeat(64),
};

const realFetch = globalThis.fetch;
let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  if (!ok) fails++;
};
const res = (status, body = '{}') => new Response(body, { status });

// ---- every failure must fall back -----------------------------------------
globalThis.fetch = async () => res(409);
check('409 (proxy mode) falls back', await uploadDirect(ARGS), null);

globalThis.fetch = async () => res(500);
check('presign 500 falls back', await uploadDirect(ARGS), null);

globalThis.fetch = async () => { throw new TypeError('Network request failed'); };
check('network error falls back', await uploadDirect(ARGS), null);

globalThis.fetch = async () => res(200, JSON.stringify({ mode: 'proxy' }));
check('unexpected body falls back', await uploadDirect(ARGS), null);

const plan = (extra = {}) => JSON.stringify({
  mode: 'direct',
  sheet: { url: 'https://bucket.example/a', headers: { 'x-amz-checksum-sha256': 'AA==' }, alreadyStored: false },
  venue: { url: 'https://bucket.example/b', headers: { 'x-amz-checksum-sha256': 'BB==' }, alreadyStored: false },
  ...extra,
});

globalThis.fetch = async (url, opt) =>
  (String(url).includes('/presign') ? res(200, plan()) : res(400));
check('bucket rejecting the PUT falls back', await uploadDirect(ARGS), null);

// an unreadable photo must not throw out of the module
check('unreadable photo falls back', await uploadDirect({ ...ARGS, sheetUri: 'file:///gone.jpg' }), null);

// ---- CONTROLS: it must be able to succeed, and to skip ---------------------
{
  let puts = 0; let declared = null;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/presign')) { declared = JSON.parse(opt.body); return res(200, plan()); }
    if (opt?.method === 'PUT') { puts++; return res(200); }
    return res(500);
  };
  check('CONTROL: happy path returns true', await uploadDirect(ARGS), true);
  check('CONTROL: it actually PUT both photos', puts, 2);
  // The signed length comes from the real file bytes, so a wrong count here
  // would make R2 reject every upload with a 403 nobody could explain.
  check('declares the true sheet byte count', declared.sheetBytes, 5);
  check('declares the true venue byte count', declared.venueBytes, 3);
}
{
  let puts = 0;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/presign')) {
      return res(200, plan({ sheet: { alreadyStored: true }, venue: { alreadyStored: true } }));
    }
    if (opt?.method === 'PUT') puts++;
    return res(200);
  };
  check('already-stored returns true', await uploadDirect(ARGS), true);
  check('already-stored skips the PUTs', puts, 0);
}
{
  let called = 0;
  globalThis.fetch = async () => { called++; return res(200, plan()); };
  check('no token falls back', await uploadDirect({ ...ARGS, token: '' }), null);
  check('no token makes no request', called, 0);
}

globalThis.fetch = realFetch;
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${fails ? `${fails} FAILURE(S)` : 'rn-direct-upload: all checks passed'}`);
process.exit(fails ? 1 : 0);
