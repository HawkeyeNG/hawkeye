#!/usr/bin/env node
/**
 * Prove the NATIVE pack decoder agrees with the database, and with the web one.
 *
 * src/lib/register-pack.ts is a second implementation of the format in
 * backend/scripts/build_register_packs.mjs. Two implementations drift; that is
 * what implementations do. The failure mode is not a crash — a drifted decoder
 * shows an observer a real-looking unit list with the wrong codes in it.
 *
 * So this compiles the TypeScript and runs it in Node against the same packs
 * the web uses, checking every unit of a small state and a large one, plus a
 * search corpus against app/register-store.js's own answers via the API.
 *
 *   node scripts/verify_register_pack_ts.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const REPO = path.resolve(NATIVE, '..');
const Database = require(path.join(REPO, 'backend', 'node_modules', 'better-sqlite3'));

// Compile the one module under test to plain JS in a temp dir.
const out = mkdtempSync(path.join(tmpdir(), 'regpack-'));
try {
  execFileSync(
    path.join(NATIVE, 'node_modules', '.bin', 'tsc'),
    ['src/lib/register-pack.ts', '--outDir', out, '--target', 'es2020', '--module', 'es2020',
     '--moduleResolution', 'bundler', '--skipLibCheck', '--ignoreConfig', '--lib', 'es2020,dom'],
    { cwd: NATIVE, stdio: 'pipe' },
  );
} catch (e) {
  console.error('tsc failed:\n' + (e.stdout || e.stderr || e).toString());
  process.exit(1);
}

const mod = await import(path.join(out, 'register-pack.js'));
const db = new Database(path.join(REPO, 'backend', 'storage', 'hawkeye.db'), { readonly: true });
const manifest = JSON.parse(readFileSync(path.join(REPO, 'app', 'reg', 'manifest.json'), 'utf8'));

const codes = Object.keys(manifest.states);
const smallest = codes.slice().sort((a, b) => manifest.states[a].bytes - manifest.states[b].bytes)[0];
const largest = codes.slice().sort((a, b) => manifest.states[b].bytes - manifest.states[a].bytes)[0];

let failed = 0;
for (const code of [smallest, largest]) {
  const info = manifest.states[code];
  const gz = readFileSync(path.join(REPO, 'app', 'reg', info.file));
  const pack = mod.decodeState(new Uint8Array(gunzipSync(gz)));
  mod.buildSearchIndex(pack);

  const truth = db
    .prepare('SELECT pu_code,name,ward,lga FROM polling_units WHERE substr(pu_code,1,2)=? ORDER BY pu_code')
    .all(code);
  const byCode = new Map(truth.map((r) => [r.pu_code, r]));

  let bad = 0;
  const samples = [];
  for (let i = 0; i < pack.unitCount; i++) {
    const u = mod.materialise(pack, i, info.name);
    const t = byCode.get(u.pu_code);
    if (!t) { bad++; if (samples.length < 3) samples.push(`code not in DB: ${u.pu_code}`); continue; }
    if (t.name !== u.name || t.ward !== u.ward || t.lga !== u.lga) {
      bad++;
      if (samples.length < 3) samples.push(`${u.pu_code}: ${JSON.stringify(t.name)} != ${JSON.stringify(u.name)}`);
    }
    byCode.delete(u.pu_code);
  }
  const ok = bad === 0 && byCode.size === 0 && pack.unitCount === truth.length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${info.name.padEnd(12)} ${pack.unitCount}/${truth.length} units, ${bad} mismatches, ${byCode.size} missing`);
  samples.forEach((s) => console.log('       ' + s));
  if (!ok) failed++;

  // Corruption must be refused, not rendered.
  const raw = new Uint8Array(gunzipSync(gz));
  const flipped = raw.slice(); flipped[mod.HEADER_BYTES + 8] ^= 1;
  for (const [label, buf] of [['flipped byte', flipped], ['truncated', raw.slice(0, raw.length - 4)]]) {
    try { mod.decodeState(buf); console.log(`FAIL  ${label} was ACCEPTED`); failed++; }
    catch { /* expected */ }
  }
}

// The search must agree with the API, the same gate the web decoder passes.
const API = process.env.API || 'http://localhost:8430/api/register/search';
const stateCode = largest;
const stateName = manifest.states[stateCode].name;
const gz = readFileSync(path.join(REPO, 'app', 'reg', manifest.states[stateCode].file));
const pack = mod.decodeState(new Uint8Array(gunzipSync(gz)));
pack.stateName = stateName;
mod.buildSearchIndex(pack);

const rows = db.prepare('SELECT name, pu_code, ward FROM polling_units WHERE state = ?').all(stateName);
const corpus = [];
for (let i = 0; i < 60; i++) {
  const r = rows[Math.floor((i * 7919) % rows.length)];
  corpus.push(r.name.slice(0, 12), r.name.split(/\s+/)[0], r.pu_code, r.pu_code.slice(0, 8), r.ward.slice(0, 10));
}
for (const t of ['primary school', 'open space', 'market', 'town hall', 'st.', 'a/c']) corpus.push(t);

let same = 0, checked = 0;
const diffs = [];
for (const q of corpus.filter((x) => x && x.trim().length >= 3)) {
  const mine = mod.search(pack, q, { limit: 10, stateName }).units.map((u) => u.pu_code);
  let theirs;
  try {
    const res = await fetch(`${API}?q=${encodeURIComponent(q)}&state=${encodeURIComponent(stateName)}&limit=10`);
    theirs = ((await res.json()).units || []).map((u) => u.pu_code);
  } catch {
    console.log('\n(API not reachable — skipping the search comparison; start backend/src/server.js to include it)');
    break;
  }
  checked++;
  if (mine.join(',') === theirs.join(',')) same++;
  else if (diffs.length < 5) diffs.push({ q, mine, theirs });
}
if (checked) {
  console.log(`\nsearch vs API: ${same}/${checked} identical top-10 (${stateName})`);
  diffs.forEach((d) => console.log(`  q=${JSON.stringify(d.q)}\n    native: ${d.mine.join(' ')}\n    api   : ${d.theirs.join(' ')}`));
  if (same !== checked) failed++;
}

rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
