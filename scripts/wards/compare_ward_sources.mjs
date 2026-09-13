/* SUPERIMPOSITION, DECIDED PER LGA.
 *
 * We already ship app/nga_wards.geojson (9,307 wards, GRID3-derived). The
 * question is not "is GRID3 v1.0 better overall" -- averages hide the only
 * thing that matters here -- but "for THIS LGA, which source agrees with the
 * INEC register we report against, and does the other one disagree".
 *
 * Four buckets per LGA:
 *   both    -- both sources match INEC's ward count: change nothing.
 *   ours    -- ours matches, GRID3 does not: KEEP OURS. This is the bucket
 *              that makes a wholesale swap a downgrade.
 *   theirs  -- GRID3 matches, ours does not: ADOPT, this is the whole gain.
 *   neither -- nobody matches: leave it alone, a wrong answer is not improved
 *              by a different wrong answer.
 *
 * Counts are the gate, names are the second gate: an LGA with the right NUMBER
 * of wards but different NAMES is not the same ward set, and adopting it would
 * silently re-label units.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = '/home/elrio/hawkeye/tmp/wards';
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\bLGA\b|\bLOCAL GOVERNMENT( AREA)?\b/g, ' ').trim();

const truth = JSON.parse(readFileSync(OUT + '/register_truth.json', 'utf8'));

/** ward names per "STATE|LGA", from a GeoJSON whose field names are given. */
function index(file, sf, lf, wf) {
  const gj = JSON.parse(readFileSync(file, 'utf8'));
  const per = {};
  for (const f of gj.features || []) {
    const p = f.properties || {};
    const k = norm(p[sf]) + '|' + norm(p[lf]);
    (per[k] = per[k] || new Set()).add(norm(p[wf]));
  }
  return per;
}

/* Ward names per LGA from the register, so an adoption can be checked against
   the names we actually report, not just the count. */
async function registerWards() {
  const p = OUT + '/register_wards.json';
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* build it */ }
  const require_ = (await import('node:module')).createRequire('/home/elrio/hawkeye/backend/');
  const DB = require_('better-sqlite3');
  const db = new DB('/home/elrio/hawkeye/backend/storage/hawkeye.db', { readonly: true });
  const out = {};
  for (const r of db.prepare('select distinct state, lga, ward from polling_units').all()) {
    if (!r.state || !r.lga || !r.ward) continue;
    const k = norm(r.state) + '|' + norm(r.lga);
    (out[k] = out[k] || []).push(norm(r.ward));
  }
  writeFileSync(p, JSON.stringify(out));
  return out;
}

const reg = await registerWards();
const ours = index('/home/elrio/hawkeye/app/nga_wards.geojson', 's', 'l', 'w');
const theirs = index(OUT + '/grid3_v1.geojson', 'statename', 'lganame', 'wardname');

const setEq = (a, b) => a && b && a.size === b.size && [...a].every((x) => b.has(x));

const bucket = { both: [], ours: [], theirs: [], neither: [], missingBoth: [] };
for (const [k, names] of Object.entries(reg)) {
  const want = new Set(names);
  const a = ours[k], b = theirs[k];
  if (!a && !b) { bucket.missingBoth.push(k); continue; }
  const aOk = setEq(a, want), bOk = setEq(b, want);
  if (aOk && bOk) bucket.both.push(k);
  else if (aOk) bucket.ours.push(k);
  else if (bOk) bucket.theirs.push(k);
  else bucket.neither.push(k);
}

const n = Object.keys(reg).length;
console.log('register LGAs: ' + n);
console.log('  both sources already exact : ' + bucket.both.length);
console.log('  OURS exact, GRID3 wrong    : ' + bucket.ours.length + '   <- a wholesale swap would LOSE these');
console.log('  GRID3 exact, ours wrong    : ' + bucket.theirs.length + '   <- the only adoptable gain');
console.log('  neither exact              : ' + bucket.neither.length);
console.log('  in neither file            : ' + bucket.missingBoth.length);

/* Count-only agreement, to separate "wrong shape" from "different spelling":
   an LGA whose COUNT matches but whose names do not is a naming problem we can
   fix, not a boundary problem. */
let countOnly = 0;
for (const k of bucket.neither) {
  const want = reg[k].length;
  if ((ours[k] && ours[k].size === want) || (theirs[k] && theirs[k].size === want)) countOnly++;
}
console.log('  ...of those, one source has the right COUNT but different names: ' + countOnly);

writeFileSync(OUT + '/adopt.json', JSON.stringify({
  adopt: bucket.theirs, keep: bucket.ours, both: bucket.both,
  neither: bucket.neither, missing: bucket.missingBoth,
}, null, 1));
console.log('\nwrote ' + OUT + '/adopt.json');
bucket.theirs.slice(0, 8).forEach((k) => console.log('  ADOPT ' + k.replace('|', ' / ')
  + '  (register ' + reg[k].length + ', ours ' + (ours[k] ? ours[k].size : '-') + ')'));
