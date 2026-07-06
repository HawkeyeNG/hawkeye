// Attach verified coordinates to polling units already in the register.
//
//   node scripts/attach_coordinates.js <csv> [--source <label>]
//
// CSV columns: pu_code,lat,lng[,source]  (source column wins over --source flag)
//
// Coordinates gate the geofence, so ONLY feed this vetted data — field-mapped
// fixes, a CSO's verified survey, or an official release. A wrong coordinate is
// worse than a missing one: it either blocks honest observers at the real unit
// or hands the geofence to whoever is standing at the wrong spot.
// 'sample' is the label for the bundled dev/demo fixes — never ship it live.
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { db } from '../src/db.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const sourceFlag = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'unspecified';
if (!file) {
  console.error('usage: node scripts/attach_coordinates.js <csv> [--source <label>]');
  process.exit(1);
}

// Nigeria bounding box — rejects obviously wrong fixes (0,0; swapped lat/lng; etc.)
const inNigeria = (lat, lng) => lat >= 4 && lat <= 14 && lng >= 2.5 && lng <= 15;

const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, trim: true });
const update = db.prepare(
  'UPDATE polling_units SET lat = ?, lng = ?, coords_source = ? WHERE pu_code = ?',
);

let attached = 0;
let unmatched = 0;
let invalid = 0;
db.transaction(() => {
  for (const r of rows) {
    const lat = Number(r.lat);
    const lng = Number(r.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inNigeria(lat, lng)) {
      invalid++;
      continue;
    }
    const res = update.run(lat, lng, r.source || sourceFlag, (r.pu_code || '').trim());
    if (res.changes === 0) unmatched++;
    else attached++;
  }
})();

const geocoded = db
  .prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NOT NULL')
  .get().c;
const total = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;

console.log(`attached ${attached} coordinates (${unmatched} codes not in register, ${invalid} invalid fixes)`);
console.log(`coverage: ${geocoded}/${total} units geocoded (${((geocoded / total) * 100).toFixed(2)}%)`);
