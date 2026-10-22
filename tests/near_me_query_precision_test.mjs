/**
 * NO NEAR-ME URL MAY CARRY THE OBSERVER'S FULL-PRECISION POSITION.
 *
 * Web review L9 and the native review of 2026-10-19: the near-me lookups put
 * the fix in the query string (`?lat=7.7719431&lng=4.5567219`), and query
 * strings are written to the web server's and the edge's access logs — a home
 * address, sent by screens that look themselves up the moment they open. Now
 * every near-me URL is built by ONE helper per codebase, which rounds to 3
 * decimals and adds `slackM` (the server widens its search by it), and the
 * answers are re-measured on the phone from the exact fix:
 *
 *   web     app/register-store.js   nearQuery / nearExact
 *   native  native/src/lib/near-query.ts nearQuery / exactBody,
 *           applied to every online answer by lib/nearby-offline.ts
 *
 * Three parts:
 *   1. a scan of every web page, web script and native source for a near-me
 *      URL that builds its own `lat=${...}` (the old shape, at 11 call sites);
 *   2. the two helpers, and that they agree with each other;
 *   3. native nearbyOrOffline hands the screens re-measured rows.
 * Each has a CONTROL that must catch the old behaviour, or its silence would
 * prove nothing.
 *
 *   node tests/near_me_query_precision_test.mjs
 *   (HK_ROOT=<other checkout> runs it against another tree.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.env.HK_ROOT || '/home/elrio/hawkeye';
const requireN = createRequire(path.join('/home/elrio/hawkeye', 'native', 'package.json'));
const ts = requireN('typescript');

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};

/* ---------------- 1. every near-me URL goes through the helper ---------------- */
console.log('=== 1. no near-me URL builds its own position ===');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
};
const webFiles = fs.readdirSync(path.join(ROOT, 'app')).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join(ROOT, 'app', f));
const nativeFiles = walk(path.join(ROOT, 'native/src'));
const HELPERS = new Set([path.join(ROOT, 'app/register-store.js'), path.join(ROOT, 'native/src/lib/near-query.ts')]);

const ENDPOINT = /\/api\/(polling-units|mapping\/nearby)\?/g;
/** The query must open with the helper's output: `${nq}` (assigned from nearQuery in the same file) or a nearQuery(...) call. */
function scan(file, src) {
  const sites = [], bad = [];
  for (const m of src.matchAll(ENDPOINT)) {
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const line = src.slice(0, m.index).split('\n').length;
    sites.push(line);
    const viaCall = /^\$\{\s*(?:[\w.]+\.)?nearQuery\(/.test(after);
    const viaVar = /^\$\{\s*nq\s*\}/.test(after) && /\bnq\s*=\s*[^;\n]*nearQuery\(/.test(src);
    if (!viaCall && !viaVar) bad.push(`${path.relative(ROOT, file)}:${line}  ${after.split('\n')[0].slice(0, 60)}`);
  }
  // Anywhere else: a URL query that writes lat=${...} by hand.
  if (!HELPERS.has(file)) {
    for (const m of src.matchAll(/[?&]lat=\$\{/g)) {
      bad.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}  hand-built lat=\${...}`);
    }
  }
  return { sites, bad };
}
const web = webFiles.map((f) => ({ f, ...scan(f, fs.readFileSync(f, 'utf8')) }));
const nat = nativeFiles.map((f) => ({ f, ...scan(f, fs.readFileSync(f, 'utf8')) }));
const count = (xs) => xs.reduce((n, x) => n + x.sites.length, 0);
const bad = [...web, ...nat].flatMap((x) => [...new Set(x.bad)]);
check(`the scan sees the web call sites (${count(web)} found, >= 9 expected)`, count(web) >= 9);
check(`the scan sees the native call sites (${count(nat)} found, >= 10 expected)`, count(nat) >= 10);
check('every near-me URL states its position through nearQuery()', bad.length === 0, bad.join('\n        '));
{
  // CONTROLS: the old shape is caught, in a template and in a native fetch;
  // the new shape passes, including the `${nq}` form only when nq IS nearQuery.
  const oldWeb = 'apiTry(`/api/polling-units?lat=${lat}&lng=${lng}`)';
  const oldNat = 'fetch(`${BASE}/api/mapping/nearby?lat=${f.lat}&lng=${f.lng}&radiusM=${R}`)';
  const fake = path.join(ROOT, 'app', '__control__.js');
  check('CONTROL the old web call is flagged', scan(fake, oldWeb).bad.length > 0);
  check('CONTROL the old native call is flagged', scan(fake, oldNat).bad.length > 0);
  check('CONTROL a hand-built lat= on any other endpoint is flagged', scan(fake, 'fetch(`/api/x?lat=${a}`)').bad.length > 0);
  check('CONTROL ${nq} counts only when nq comes from nearQuery', scan(fake, 'const nq = `lat=${a}`; get(`/api/polling-units?${nq}`)').bad.length > 0
    && scan(fake, 'const nq = store.nearQuery(a, b); get(`/api/polling-units?${nq}`)').bad.length === 0);
  check('CONTROL the new native call passes', scan(fake, 'fetch(`${BASE}/api/polling-units?${nearQuery(f.lat, f.lng)}`)').bad.length === 0);
}

/* ---------------- 2. the helpers ---------------- */
console.log('\n=== 2. the helpers round, re-measure, and agree with each other ===');
const store = createRequire(import.meta.url)(path.join(ROOT, 'app/register-store.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-nearq-'));
const transpile = (rel, rewrite = (s) => s) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = path.join(tmp, path.basename(rel).replace(/\.tsx?$/, '.mjs'));
  fs.writeFileSync(out, rewrite(js));
  return out;
};
let nq = null;
try { nq = await import(transpile('native/src/lib/near-query.ts')); } catch (e) { console.log(`        (native/src/lib/near-query.ts: ${e.code || e.message})`); }
check('web: register-store.js exports nearQuery and nearExact', typeof store.nearQuery === 'function' && typeof store.nearExact === 'function');
check('native: lib/near-query.ts exports nearQuery and exactBody', !!nq && typeof nq.nearQuery === 'function' && typeof nq.exactBody === 'function');

const P = { lat: 7.7719431, lng: 4.5567219 }; // a real fix's precision
const decimals = (q) => Math.max(...[...q.matchAll(/(?:^|&)(?:lat|lng)=-?\d+(?:\.(\d+))?/g)].map((m) => (m[1] || '').length));
if (store.nearQuery) {
  const q = store.nearQuery(P.lat, P.lng);
  check('web: at most 3 decimals on the wire, and the slack is stated', decimals(q) <= 3 && /(^|&)slackM=80(&|$)/.test(q), q);
  check('web: the stated point is within the 80 m slack of the fix', (() => {
    const sp = Object.fromEntries(new URLSearchParams(q));
    return haversine(P.lat, P.lng, Number(sp.lat), Number(sp.lng)) <= Number(sp.slackM);
  })(), q);
}
if (nq) check('native and web state the identical query', store.nearQuery && nq.nearQuery(P.lat, P.lng) === store.nearQuery(P.lat, P.lng), nq.nearQuery(P.lat, P.lng));
// The worst case over a grid of Nigerian latitudes: the slack must cover it.
{
  let worst = 0;
  for (let la = 4; la <= 14; la += 0.01) for (const dx of [0.0004999, -0.0004999]) {
    const lat = la + dx, lng = 8 + dx;
    const sp = Object.fromEntries(new URLSearchParams(store.nearQuery ? store.nearQuery(lat, lng) : ''));
    if (store.nearQuery) worst = Math.max(worst, haversine(lat, lng, Number(sp.lat), Number(sp.lng)));
  }
  check(`the slack covers the worst rounding in Nigeria (worst ${worst.toFixed(1)} m <= 80)`, worst > 70 && worst <= 80);
}

function haversine(aLat, aLng, bLat, bLng) {
  const R = Math.PI / 180, dLat = (bLat - aLat) * R, dLng = (bLng - aLng) * R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
// A server answer as the server writes it for the ROUNDED point: distances from Q.
const Q = { lat: 7.772, lng: 4.557 };
const m = (north, east) => ({ lat: P.lat + north / 111194.93, lng: P.lng + east / (111194.93 * Math.cos(P.lat * Math.PI / 180)) });
const own = m(4, 3), west = m(0, -470), far = m(0, -540), crowd = m(480, 0);
const regBody = {
  radiusM: 500, maxRows: 40, capped: false,
  units: [
    { pu_code: 'A-OWN', lat: own.lat, lng: own.lng, crowd_lat: null, crowd_lng: null },
    { pu_code: 'B-WEST', lat: west.lat, lng: west.lng },
    { pu_code: 'C-FAR', lat: far.lat, lng: far.lng },
    { pu_code: 'D-CROWD', lat: null, lng: null, crowd_lat: crowd.lat, crowd_lng: crowd.lng },
  ].map((u) => ({ ...u, distanceM: Math.round(haversine(Q.lat, Q.lng, u.lat ?? u.crowd_lat, u.lng ?? u.crowd_lng)) })),
};
const exactOf = (u) => Math.round(haversine(P.lat, P.lng, u.lat ?? u.crowd_lat, u.lng ?? u.crowd_lng));
const expect = regBody.units.filter((u) => exactOf(u) <= 500).map((u) => `${u.pu_code}@${exactOf(u)}`).sort((a, b) => Number(a.split('@')[1]) - Number(b.split('@')[1])).join();
const show = (b) => (Array.isArray(b) ? b : b.units).map((u) => `${u.pu_code || u.puCode}@${u.distanceM}`).join();
check('CONTROL the fixture\'s server distances are measured from the rounded point (they differ)', show(regBody) !== show({ units: regBody.units.map((u) => ({ ...u, distanceM: exactOf(u) })) }));
check('CONTROL C-FAR is past 500 m of the fix, so dropping it is the right answer', exactOf(regBody.units[2]) > 500);
if (store.nearExact) {
  const before = JSON.stringify(regBody);
  const w = store.nearExact(regBody, P.lat, P.lng);
  check('web nearExact: distances from the exact fix, rows past radiusM dropped, nearest first', show(w) === expect, `${show(w)} vs ${expect}`);
  check('web nearExact: the envelope fields ride along, and the input is not mutated', w.radiusM === 500 && w.maxRows === 40 && w.capped === false && JSON.stringify(regBody) === before);
  check('web nearExact: a bare array (old server) and a failure body pass through', Array.isArray(store.nearExact(regBody.units, P.lat, P.lng)) && store.nearExact({ error: 'x' }, P.lat, P.lng).error === 'x' && store.nearExact(null, 1, 2) === null);
  const mapBody = { units: [{ puCode: 'M-1', lat: far.lat, lng: far.lng, distanceM: 1 }, { puCode: 'M-2', lat: m(0, -900).lat, lng: m(0, -900).lng, distanceM: 2 }] };
  check('web nearExact: a mapping answer is trimmed to the radius asked', show(store.nearExact(mapBody, P.lat, P.lng, 800)) === `M-1@${exactOf(mapBody.units[0])}`, show(store.nearExact(mapBody, P.lat, P.lng, 800)));
  if (nq) check('native exactBody gives the same rows as web nearExact', show(nq.exactBody(regBody, P.lat, P.lng)) === show(w)
    && show(nq.exactBody(mapBody, P.lat, P.lng, 800)) === show(store.nearExact(mapBody, P.lat, P.lng, 800)));
}

/* ---------------- 3. native nearbyOrOffline re-measures ---------------- */
console.log('\n=== 3. native nearbyOrOffline hands the screens exact distances ===');
let no = null;
try {
  const stub = path.join(tmp, 'register-stub.mjs');
  fs.writeFileSync(stub, 'export const offlineNearby = async () => null; export const unitFromPacks = async () => null;\n');
  const nqPath = nq ? path.join(tmp, 'near-query.mjs') : null;
  const file = transpile('native/src/lib/nearby-offline.ts', (js) => js
    .replace(/from ['"]@\/lib\/register['"]/g, `from '${stub}'`)
    .replace(/from ['"]@\/lib\/near-query['"]/g, `from '${nqPath}'`));
  no = await import(file);
} catch (e) { console.log(`        (nearby-offline.ts: ${e.message})`); }
check('native: nearby-offline.ts loads and re-exports nearQuery for the screens', !!no && typeof no.nearQuery === 'function');
if (no) {
  const res = (body) => ({ ok: true, status: 200, json: async () => body });
  const mapBody = { units: [{ puCode: 'M-1', lat: far.lat, lng: far.lng, distanceM: 1 }, { puCode: 'M-2', lat: m(0, -900).lat, lng: m(0, -900).lng, distanceM: 2 }] };
  const [located, envelope, offline] = await no.nearbyOrOffline(P.lat, P.lng, 800, Promise.resolve([res(regBody), res(mapBody)]), 50, 100);
  const lb = await located.json(), eb = await envelope.json();
  check('the register answer reaches the screen re-measured and trimmed', show(lb) === expect && offline === false, show(lb));
  check('the mapping answer reaches the screen trimmed to the radius asked', show(eb) === `M-1@${exactOf(mapBody.units[0])}`, show(eb));
  const [l2, e2] = await no.nearbyOrOffline(P.lat, P.lng, 800, Promise.resolve([{ ok: false, status: 503, json: async () => ({}) }, null]), 50, 100);
  check('a failed lookup is handed back as it came (status kept, nothing invented)', l2 && l2.ok === false && l2.status === 503 && e2 === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
