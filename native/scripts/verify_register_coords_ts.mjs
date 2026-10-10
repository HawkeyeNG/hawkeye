#!/usr/bin/env node
/**
 * GATE for offline near-me: the phone's answer (src/lib/register-coords.ts,
 * nearbyFromPacks) must equal what the two server endpoints would return for
 * the same fix, computed here from the DATABASE with the server's own trust
 * functions — not from the files under test.
 *
 *   HAWKEYE_DB=<prod snapshot> node native/scripts/verify_register_coords_ts.mjs [--reg DIR] [--per-state N]
 *
 * Reference = GET /api/polling-units and GET /api/mapping/nearby, minus the
 * nearby route's `LIMIT 400` before sorting (the phone sorts everything), and
 * limited to the sample's own state, since that is the pack a phone holds.
 * Distances may differ by 1 m (the file stores degrees ×1e6), so a row within
 * 2 m of a radius, or tied with the last row of a full list, may be on either side.
 *
 * CONTROL: the same comparison against coordinates shifted by 0.01° must FAIL —
 * a gate that passes on wrong data is not a gate.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const REPO = path.resolve(NATIVE, '..');
const Database = require(path.join(REPO, 'backend', 'node_modules', 'better-sqlite3'));
const { trustedPin, trustedCrowd, publicUnit } = await import(pathToFileURL(path.join(REPO, 'backend', 'src', 'services', 'pin-trust.js')).href);
const { haversineM } = await import(pathToFileURL(path.join(REPO, 'backend', 'src', 'services', 'geo.js')).href);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
const REG = path.resolve(arg('--reg', path.join(REPO, 'app', 'reg')));
const PER_STATE = Number(arg('--per-state', 30));
const DB_PATH = process.env.HAWKEYE_DB || path.join(REPO, 'backend', 'storage', 'hawkeye.db');

const out = mkdtempSync(path.join(tmpdir(), 'regcoords-'));
let mod;
try {
  // register-pack.ts imports '@/lib/i18n' for two error strings, which tsc
  // cannot resolve outside the app: it reports that and STILL emits, so the
  // exit code is ignored and the emitted files are what is checked.
  try {
    execFileSync(
      path.join(NATIVE, 'node_modules', '.bin', 'tsc'),
      ['src/lib/register-coords.ts', 'src/lib/register-pack.ts', '--outDir', out, '--target', 'es2020', '--module', 'es2020',
       '--moduleResolution', 'bundler', '--skipLibCheck', '--ignoreConfig', '--lib', 'es2020,dom'],
      { cwd: NATIVE, stdio: 'pipe' },
    );
  } catch (e) {
    const msg = (e.stdout || e.stderr || e).toString();
    const real = msg.split(/\r?\n/).filter((l) => /error TS/.test(l) && !/TS2307.*@\/lib\/i18n/.test(l));
    if (real.length) throw new Error(real.join(' | '));
  }
  // Node's ESM loader needs the extension spelled out, and a stand-in for i18n.
  const fix = (name, from, to) => { const f = path.join(out, name); writeFileSync(f, readFileSync(f, 'utf8').replace(from, to)); };
  fix('register-coords.js', "'./register-pack'", "'./register-pack.js'");
  fix('register-pack.js', "'@/lib/i18n'", "'./i18n-stub.js'");
  writeFileSync(path.join(out, 'i18n-stub.js'), 'export const t = (k) => k;');
  writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
  mod = { ...(await import(pathToFileURL(path.join(out, 'register-coords.js')).href)), ...(await import(pathToFileURL(path.join(out, 'register-pack.js')).href)) };
} catch (e) {
  console.error('compile failed: ' + (e.message || e).toString());
  rmSync(out, { recursive: true, force: true });
  process.exit(2);
}
const { decodeCoords, nearbyFromPacks, decodeState, REGISTER_RADIUS_M, REGISTER_MAX_ROWS, MAPPING_MAX_ROWS } = mod;

const manifest = JSON.parse(readFileSync(path.join(REG, 'manifest.json'), 'utf8'));
if (!manifest.coords) { console.error(`FATAL: ${REG}/manifest.json has no coords — build with --coords`); process.exit(2); }
const db = new Database(DB_PATH, { readonly: true });
const all = db.prepare(`SELECT pu_code, name, ward, lga, state, lat, lng, coords_source, crowd_lat, crowd_lng,
  approx_lat, approx_lng, approx_radius_m FROM polling_units ORDER BY pu_code`).all();
const byState = new Map();
for (const u of all) { const k = u.pu_code.slice(0, 2); if (!byState.has(k)) byState.set(k, []); byState.get(k).push(u); }

// A fixed sequence, so a failure reproduces.
let seed = 20261010;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

function reference(units, lat, lng, radius) {
  const reg = units.map((u) => {
    const p = trustedPin(db, u) ?? trustedCrowd(db, u);
    return p ? { code: u.pu_code, d: Math.round(haversineM(lat, lng, p.lat, p.lng)), tier: publicUnit(db, u).locationTier } : null;
  }).filter((u) => u && u.d <= REGISTER_RADIUS_M).sort((a, b) => a.d - b.d).slice(0, REGISTER_MAX_ROWS);
  const map = units.map((u) => {
    const pin = u.lat != null ? trustedPin(db, u) : null;
    const la = pin ? pin.lat : u.approx_lat, ln = pin ? pin.lng : u.approx_lng;
    if (la == null || ln == null) return null;
    return { code: u.pu_code, d: Math.round(haversineM(lat, lng, la, ln)),
      tier: pin ? (u.coords_source === 'crowd_mapped' ? 'crowd' : 'verified') : 'approx', r: pin ? null : u.approx_radius_m };
  }).filter((u) => u && u.d <= radius).sort((a, b) => a.d - b.d).slice(0, MAPPING_MAX_ROWS);
  return { reg, map };
}

/** Rows that differ, ignoring the ones the 1 m rounding is allowed to move. */
function differences(want, got, radius, max) {
  const bad = [];
  const edge = (list) => (list.length >= max ? list[list.length - 1].d : Infinity);
  const cut = Math.min(edge(want), edge(got));
  const g = new Map(got.map((r) => [r.code, r])), w = new Map(want.map((r) => [r.code, r]));
  const onTheLine = (r) => r.d >= radius - 2 || r.d >= cut - 1;
  for (const r of want) {
    const o = g.get(r.code);
    if (!o) { if (!onTheLine(r)) bad.push(`missing ${r.code} @${r.d}m`); continue; }
    if (Math.abs(o.d - r.d) > 1 || o.tier !== r.tier || (r.r ?? null) !== (o.r ?? null)) bad.push(`differs ${r.code}: want ${JSON.stringify(r)} got ${JSON.stringify(o)}`);
  }
  for (const r of got) if (!w.has(r.code) && !onTheLine(r)) bad.push(`extra ${r.code} @${r.d}m`);
  return bad;
}

function run(shift) {
  let samples = 0, rows = 0, withReg = 0;
  const bad = [];
  for (const [code, info] of Object.entries(manifest.coords.states)) {
    const state = decodeState(new Uint8Array(gunzipSync(readFileSync(path.join(REG, manifest.states[code].file)))));
    const coords = decodeCoords(new Uint8Array(gunzipSync(readFileSync(path.join(REG, info.file)))));
    if (coords.pack !== manifest.states[code].sha) bad.push(`state ${code}: coords bound to pack ${coords.pack}`);
    if (shift) for (let i = 0; i < coords.unitCount; i++) { coords.pinLat[i] += shift; coords.envLat[i] += shift; coords.crowdLat[i] += shift; }
    const units = byState.get(code) || [];
    const pinned = units.filter((u) => u.lat != null);
    const pool = pinned.length ? pinned : units.filter((u) => u.approx_lat != null);
    for (let k = 0; k < PER_STATE && pool.length; k++) {
      const u = pool[Math.floor(rnd() * pool.length)];
      // Stand 0–400 m from a real unit, the way an observer does.
      const lat = (u.lat ?? u.approx_lat) + (rnd() - 0.5) * 0.007, lng = (u.lng ?? u.approx_lng) + (rnd() - 0.5) * 0.007;
      for (const radius of [800, 5000]) {
        const want = reference(units, lat, lng, radius);
        const got = nearbyFromPacks([{ state, coords }], lat, lng, radius);
        const gReg = got.register.units.map((r) => ({ code: r.pu_code, d: r.distanceM, tier: r.locationTier }));
        const gMap = got.mapping.units.map((r) => ({ code: r.puCode, d: r.distanceM, tier: r.status, r: r.approxRadiusM }));
        for (const b of differences(want.reg, gReg, REGISTER_RADIUS_M, REGISTER_MAX_ROWS)) if (bad.length < 12) bad.push(`[${code} reg] ${b}`); else bad.push('');
        for (const b of differences(want.map, gMap, radius, MAPPING_MAX_ROWS)) if (bad.length < 12) bad.push(`[${code} map ${radius}] ${b}`); else bad.push('');
        rows += want.reg.length + want.map.length;
        if (want.reg.length) withReg++;
      }
      samples++;
    }
  }
  return { samples, rows, withReg, bad };
}

try {
  const real = run(0);
  console.log(`offline near-me vs server logic: ${real.samples} fixes in ${Object.keys(manifest.coords.states).length} states, ${real.rows} reference rows, ${real.withReg} lookups with a unit inside ${REGISTER_RADIUS_M} m`);
  const control = run(0.01);
  console.log(`CONTROL (coordinates shifted 0.01°): ${control.bad.length} differences ${control.bad.length ? '— correctly detected' : '— NOT DETECTED'}`);
  if (real.bad.length || !control.bad.length || !real.rows) {
    console.error(`FAILED: ${real.bad.length} difference(s)`);
    for (const b of real.bad.filter(Boolean)) console.error('  ' + b);
    process.exit(1);
  }
  console.log('OK: offline == online at every sampled fix');
} finally {
  rmSync(out, { recursive: true, force: true });
  db.close();
}
