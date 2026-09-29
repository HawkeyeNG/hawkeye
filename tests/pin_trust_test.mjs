/**
 * A PIN THAT CONTRADICTS ITS OWN ENVELOPE IS NOT A POSITION (2026-09-29).
 *
 * An observer at Games Village, Abuja picked 37-02-09-003 "Kukwaba I / Kukwaba
 * Market" (Kubwa, Bwari — ~20 km away) and was refused as "about 436 km" away,
 * under a "Verified location" badge. Its pin (12.7052, 6.0749) is in Bakura,
 * Zamfara: the INEC locator crawl numbers FCT 15, the register numbers it 37,
 * so every state from Gombe to FCT was loaded with its predecessor's pins.
 *
 * Checked here, with the production row's own numbers, on all three layers:
 *   - backend/src/services/pin-trust.js      (API serialiser, geofence input)
 *   - backend/src/services/location-standing.js (the submission gate)
 *   - backend/src/services/locator-state-fix.js (the data fix: plan, apply, idempotent)
 *   - native/src/lib/geofence.ts             (the client's refusal + badge)
 * Every "rejected" claim has a CONTROL that must stay accepted, or the test
 * could pass by rejecting everything.
 *
 *   node tests/pin_trust_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireB = createRequire(path.join(ROOT, 'backend', 'package.json'));
const requireN = createRequire(path.join(ROOT, 'native', 'package.json'));
const Database = requireB('better-sqlite3');
const ts = requireN('typescript');

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? `   ${JSON.stringify(got)}` : ''}`);
  if (!ok) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-pin-'));
process.env.DB_PATH = path.join(tmp, 'unused.db');
const { pointAgrees, publicUnit, trustedPin } = await import(path.join(ROOT, 'backend/src/services/pin-trust.js'));
const { locationStanding } = await import(path.join(ROOT, 'backend/src/services/location-standing.js'));
const fix = await import(path.join(ROOT, 'backend/src/services/locator-state-fix.js'));

/* A register in miniature: the production rows (as served on 2026-09-29), an
   unshifted-state control, a shifted unit with no envelope, and a pinless
   unit the shifted load never reached. */
const db = new Database(':memory:');
db.exec(`CREATE TABLE polling_units (pu_code TEXT PRIMARY KEY, name TEXT, ward TEXT, lga TEXT, state TEXT,
  lat REAL, lng REAL, coords_source TEXT, crowd_lat REAL, crowd_lng REAL, crowd_reports INTEGER NOT NULL DEFAULT 0,
  approx_lat REAL, approx_lng REAL, approx_radius_m REAL)`);
const ins = db.prepare(`INSERT INTO polling_units VALUES (@pu_code,@name,@ward,@lga,@state,@lat,@lng,@coords_source,@crowd_lat,@crowd_lng,0,@approx_lat,@approx_lng,@approx_radius_m)`);
const row = (o) => ({ name: o.pu_code, ward: 'W', lga: 'L', state: 'S', lat: null, lng: null, coords_source: null, crowd_lat: null, crowd_lng: null, approx_lat: null, approx_lng: null, approx_radius_m: null, ...o });
const rows = [
  // Kubwa ward, Bwari, FCT — pins in Bakura, Zamfara; envelopes in Kubwa.
  row({ pu_code: '37-02-09-003', name: 'Kukwaba I/ Kukwaba Market', ward: 'Kubwa', lga: 'Bwari', state: 'FCT', lat: 12.7052, lng: 6.0749, coords_source: 'inec_locator', crowd_lat: 9.146, crowd_lng: 7.32, approx_lat: 9.146, approx_lng: 7.32, approx_radius_m: 600 }),
  row({ pu_code: '37-02-09-004', name: 'Kukwaba Ii/Security Post Nysc Camp', ward: 'Kubwa', lga: 'Bwari', state: 'FCT', lat: 12.6888, lng: 6.0396, coords_source: 'inec_locator', approx_lat: 9.14, approx_lng: 7.2689, approx_radius_m: 3960 }),
  // Same LGA, no envelope: judged against the LGA's median envelope.
  row({ pu_code: '37-02-09-099', ward: 'Kubwa', lga: 'Bwari', state: 'FCT', lat: 12.69, lng: 6.04, coords_source: 'inec_locator' }),
  // Pinless FCT unit whose locator row sits under 15-… in the csv.
  row({ pu_code: '37-02-09-005', ward: 'Kubwa', lga: 'Bwari', state: 'FCT', coords_source: 'geocoded', crowd_lat: 9.14, crowd_lng: 7.2689, approx_lat: 9.14, approx_lng: 7.2689, approx_radius_m: 3960 }),
  // CONTROL: Abia (state 01, never shifted), good pin 1.5 km from its envelope.
  row({ pu_code: '01-01-01-001', ward: 'A', lga: 'Aba North', state: 'Abia', lat: 5.1120, lng: 7.3660, coords_source: 'inec_locator', approx_lat: 5.1000, approx_lng: 7.3600, approx_radius_m: 900 }),
  // CONTROL: an observer-mapped pin is never touched by the data fix.
  row({ pu_code: '37-02-09-006', ward: 'Kubwa', lga: 'Bwari', state: 'FCT', lat: 12.0, lng: 6.0, coords_source: 'crowd_mapped', approx_lat: 9.14, approx_lng: 7.2689, approx_radius_m: 3960 }),
];
for (const r of rows) ins.run(r);
const get = (c) => db.prepare('SELECT * FROM polling_units WHERE pu_code = ?').get(c);

console.log('=== server: the pin is judged against the unit\'s own envelope ===');
const kub = get('37-02-09-003');
check('Kukwaba I pin contradicts its envelope', pointAgrees(db, kub, kub.lat, kub.lng) === false);
check('CONTROL Abia pin agrees with its envelope', pointAgrees(db, get('01-01-01-001'), 5.112, 7.366) === true);
check('no envelope: judged against the LGA median, and rejected', pointAgrees(db, get('37-02-09-099'), 12.69, 6.04) === false);
const out = publicUnit(db, kub);
check('the API withholds the pin and does not say "verified"', out.lat === null && out.lng === null && out.pin_unverified === true && out.locationTier !== 'verified', { lat: out.lat, tier: out.locationTier });
check('...and keeps the envelope-consistent crowd point, so old apps measure ~20 km', out.crowd_lat === 9.146 && out.crowd_lng === 7.32);
const abia = publicUnit(db, get('01-01-01-001'));
check('CONTROL Abia served untouched and verified', abia.lat === 5.112 && abia.locationTier === 'verified' && !abia.pin_unverified);

console.log('\n=== server: the submission gate ===');
const atUnit = locationStanding(db, kub, 9.1465, 7.3197, 10);
check('observer standing AT Kukwaba market is accepted (was refused at 436 km)', atUnit.reject === null && atUnit.tier === 'envelope', atUnit);
const fromGV = locationStanding(db, kub, 9.01, 7.44, 10);
check('observer at Games Village is refused by the ENVELOPE at ~20 km, not the Zamfara pin', fromGV.reject?.error === 'too_far_from_unit' && fromGV.distanceM < 30000, fromGV);
const abiaRow = get('01-01-01-001');
const abiaFar = locationStanding(db, abiaRow, 5.112 + 0.01, 7.366, 10);
check('CONTROL a trusted pin still fences at 500 m', abiaFar.reject?.error === 'outside_geofence' && trustedPin(db, abiaRow) !== null, abiaFar);

console.log('\n=== the data fix: plan, apply, idempotent ===');
check('locator code of an FCT unit is 15-…', fix.locatorCode('37-02-09-003') === '15-02-09-003');
check('locator code of a Gombe unit is 16-…', fix.locatorCode('15-01-01-001') === '16-01-01-001');
check('CONTROL an Abia code is unchanged', fix.locatorCode('01-01-01-001') === '01-01-01-001');
const csv = new Map([
  ['15-02-09-003', [9.1465, 7.3197]], // Kukwaba I, where it really is
  ['15-02-09-005', [9.1496, 7.3199]], // a pinless unit the shift never reached
  ['37-02-09-003', [12.7052, 6.0749]], // Bakura's own unit — what was loaded
  ['01-01-01-001', [5.1120, 7.3660]],
]);
const plan = fix.planLocatorFix(db, csv);
const kinds = Object.fromEntries(plan.map((a) => [a.pu_code, a.kind]));
check('Kukwaba I: REPLACE with its own locator row', kinds['37-02-09-003'] === 'replace', kinds);
check('Kukwaba II (no agreeing row): DEMOTE', kinds['37-02-09-004'] === 'demote');
check('envelope-less shifted pin: DEMOTE (judged by LGA)', kinds['37-02-09-099'] === 'demote');
check('pinless FCT unit: ATTACH', kinds['37-02-09-005'] === 'attach');
check('CONTROL Abia and the crowd-mapped pin are left alone', !kinds['01-01-01-001'] && !kinds['37-02-09-006']);
const changed = fix.applyLocatorFix(db, plan);
check('apply changes exactly the planned rows', changed === plan.length, { changed, planned: plan.length });
const k2 = get('37-02-09-003');
check('Kukwaba I now sits in Kubwa, as inec_locator_statefix', Math.abs(k2.lat - 9.1465) < 1e-9 && k2.coords_source === 'inec_locator_statefix');
const d2 = get('37-02-09-004');
check('Kukwaba II lost only its pin (envelope kept)', d2.lat === null && d2.approx_lat === 9.14);
check('second plan is empty (idempotent)', fix.planLocatorFix(db, csv).length === 0);

console.log('\n=== native: lib/geofence.ts ===');
const src = fs.readFileSync(path.join(ROOT, 'native/src/lib/geofence.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const modPath = path.join(tmp, 'geofence.mjs');
fs.writeFileSync(modPath, js);
const g = await import(modPath);
const GV = { lat: 9.01, lng: 7.44 };
const kmFrom = (p) => (p ? Math.round(g.haversineM(GV.lat, GV.lng, p.lat, p.lng) / 1000) : null);
const served = { ...kub }; // what production serves today
const place = g.placeUnit(served);
check('client: Kukwaba I measured ~20 km, not 436', kmFrom(place.point) >= 15 && kmFrom(place.point) <= 30, { basis: place.basis, km: kmFrom(place.point) });
check('client: under the refusal threshold', g.haversineM(GV.lat, GV.lng, place.point.lat, place.point.lng) < g.GROSS_MISMATCH_M);
check('client: says "location unverified", and no Verified badge', g.locationUnverified(served) && !g.pinIsTrusted(served));
const bare = { lat: 12.7, lng: 6.07, coords_source: 'inec_locator', pin_unverified: true };
check('client: a withheld pin with nothing else is never measured (no km, no refusal)', g.unitPoint(bare) === null && g.locationUnverified(bare));
check('client: a bulk-geocoded point alone is never measured', g.unitPoint({ crowd_lat: 4.8, crowd_lng: 7, coords_source: 'geocoded' }) === null);
const osun = { lat: 7.533, lng: 4.73, coords_source: 'inec_locator_statefix', approx_lat: 7.5338, approx_lng: 4.7273, approx_radius_m: 3827 };
check('CONTROL client: a trusted far pin (Osun from Abuja) is still refused', g.haversineM(GV.lat, GV.lng, g.unitPoint(osun).lat, g.unitPoint(osun).lng) > g.GROSS_MISMATCH_M && !g.locationUnverified(osun));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
