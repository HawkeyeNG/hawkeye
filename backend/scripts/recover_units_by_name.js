// Rescue crawl coords whose locator pu_code has drifted from our register's
// delimitation code, by matching on NAMES instead of the (mismatched) number.
//
//   node scripts/recover_units_by_name.js [--threshold 0.55] [--out <csv>]
//
// Input:  storage/raw/inec_pu_coords_named.csv  (from fetch_inec_coords.py —
//         pu_code,lat,lng,state_code,lga,ward,pu_name)
// Register: the polling_units table (pu_code, name, ward, lga, state).
// Output: storage/raw/inec_pu_coords_recovered.csv  (pu_code,lat,lng,source),
//         ready for  node scripts/attach_coordinates.js <out> --source inec_locator
//
// Only rows whose EXACT code already exists in the register are handled by the
// normal attach; those are skipped here. For the rest we walk the register
// hierarchy the crawl label gives us — the state number is stable, so within that
// state we fuzzy-match the LGA name, then the ward name, then the polling-unit
// name, and bind the crawl's GPS to the register's canonical code. A unit like
// "Suncity" that merely got renumbered rejoins by name; a unit with no register
// row (created after our register snapshot) has nothing to match and is left for a
// newer register. We never emit a coord for a code already geocoded, and we skip
// ambiguous ties rather than guess.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const TH = Number(args.includes('--threshold') ? args[args.indexOf('--threshold') + 1] : 0.55);
const RAW = path.dirname(config.registerCsvPath);
const IN = path.join(RAW, 'inec_pu_coords_named.csv');
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1]
  : path.join(RAW, 'inec_pu_coords_recovered.csv');

if (!fs.existsSync(IN)) {
  console.error(`missing ${IN} — run scripts/fetch_inec_coords.py first (it writes the named CSV).`);
  process.exit(1);
}

// ---- text utils: normalize + Dice bigram similarity (same idea as recover_ward_codes.py)
const norm = (s) => {
  const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /\bfct\b|federal capital|abuja/.test(n) ? 'fct' : n;
};
const bigrams = (s) => {
  const t = `_${s}_`;
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
};
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
};
// Best candidate from a Map<normName, value>, with its bigram cache. Returns
// { value, score, tie } — tie flags a near-draw so the caller can refuse to guess.
const bgCache = new Map();
const bgOf = (s) => { let b = bgCache.get(s); if (!b) { b = bigrams(s); bgCache.set(s, b); } return b; };
function best(name, cands) {
  const nb = bgOf(name);
  let top = null, ts = 0, second = 0;
  for (const [cn, val] of cands) {
    if (cn === name) return { value: val, score: 1, tie: false }; // exact-normalized wins outright
    const s = dice(nb, bgOf(cn));
    if (s > ts) { second = ts; ts = s; top = val; }
    else if (s > second) second = s;
  }
  return { value: top, score: ts, tie: ts - second < 0.05 };
}

// ---- build register hierarchy: state -> lga -> ward -> (pu name -> pu_code)
// Each level is a Map keyed by normalized name so best() can fuzzy-match it.
const reg = new Map();           // stateCode -> Map<lgaNorm, {wards}>
const geocoded = new Set();      // codes that already have a real coordinate — never overwrite
for (const r of db.prepare('SELECT pu_code, name, ward, lga, state, lat, crowd_lat FROM polling_units').all()) {
  if (r.lat != null || r.crowd_lat != null) geocoded.add(r.pu_code);
  const sc = r.pu_code.slice(0, 2);
  const lgaN = norm(r.lga), wardN = norm(r.ward), puN = norm(r.name);
  let st = reg.get(sc); if (!st) { st = new Map(); reg.set(sc, st); }
  let lg = st.get(lgaN); if (!lg) { lg = new Map(); st.set(lgaN, lg); }
  let wd = lg.get(wardN); if (!wd) { wd = new Map(); lg.set(wardN, wd); }
  // A ward can legitimately hold same-named units ("… I"/"… II"); if a bare name
  // collides, keep the first and let the tie-guard downgrade confidence.
  if (!wd.has(puN)) wd.set(puN, r.pu_code);
}
const regSet = new Set(db.prepare('SELECT pu_code FROM polling_units').all().map((r) => r.pu_code));

// ---- walk the named crawl, recover by name
const rows = parse(fs.readFileSync(IN, 'utf8'), { columns: true, trim: true });
const inNigeria = (lat, lng) => lat >= 4 && lat <= 14 && lng >= 2.5 && lng <= 15;
const out = [];
const emitted = new Set();
let already = 0, recovered = 0, ambiguous = 0, noMatch = 0, invalid = 0, dup = 0;

for (const r of rows) {
  const lat = Number(r.lat), lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inNigeria(lat, lng)) { invalid++; continue; }
  if (regSet.has(r.pu_code)) {
    // exact code is valid — attaching the named CSV directly covers it; not our job
    already++; continue;
  }
  const st = reg.get((r.state_code || r.pu_code.slice(0, 2)).padStart(2, '0'));
  if (!st) { noMatch++; continue; }
  const lgaN = norm(r.lga), wardN = norm(r.ward), puN = norm(r.pu_name);
  if (!lgaN || !wardN || !puN) { noMatch++; continue; }

  const lgHit = best(lgaN, st);
  if (!lgHit.value || lgHit.score < 0.6) { noMatch++; continue; }
  const wdHit = best(wardN, lgHit.value);
  if (!wdHit.value || wdHit.score < 0.6) { noMatch++; continue; }
  const puHit = best(puN, wdHit.value);
  if (!puHit.value || puHit.score < TH) { noMatch++; continue; }
  if (puHit.tie) { ambiguous++; continue; }     // two equally-plausible units — don't guess

  const code = puHit.value;
  if (geocoded.has(code)) { already++; continue; }   // register unit already located
  if (emitted.has(code)) { dup++; continue; }        // two crawl rows resolved to one unit
  emitted.add(code);
  out.push([code, lat.toFixed(6), lng.toFixed(6), 'inec_locator']);
  recovered++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, 'pu_code,lat,lng,source\n' + out.map((r) => r.join(',')).join('\n') + '\n');

console.log(`crawl rows: ${rows.length}`);
console.log(`  already valid code (normal attach): ${already}`);
console.log(`  RECOVERED by name: ${recovered}`);
console.log(`  ambiguous (tie, skipped): ${ambiguous}`);
console.log(`  no register match (likely new unit / needs newer register): ${noMatch}`);
console.log(`  duplicate register target / invalid: ${dup} / ${invalid}`);
console.log(`-> ${OUT}`);
console.log('next, to load into the register (two attach runs):');
console.log('  node scripts/attach_coordinates.js storage/raw/inec_pu_coords_named.csv --source inec_locator   # exact-code matches');
console.log(`  node scripts/attach_coordinates.js ${path.relative(process.cwd(), OUT)} --source inec_locator   # name-recovered`);
