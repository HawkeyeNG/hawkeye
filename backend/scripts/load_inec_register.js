// Load the full official INEC polling-unit register (~176,846 units).
//
//   node scripts/load_inec_register.js storage/raw/nigeria_polling_units.csv [--replace]
//
// Thin wrapper over services/register.js (the server also self-loads on first
// boot via the same service). Register provenance/format: see that file.
import { db } from '../src/db.js';
import { loadRegisterCsv } from '../src/services/register.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/load_inec_register.js <csv> [--replace]');
  process.exit(1);
}

if (replace) {
  const subs = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
  if (subs > 0) {
    console.error(`refusing --replace: ${subs} submissions reference polling_units. Back up / clear first.`);
    process.exit(1);
  }
  db.exec('DELETE FROM results; DELETE FROM polling_units;');
  console.log('cleared polling_units (and results)');
}

const r = await loadRegisterCsv(db, file);
const total = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;
const geocoded = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NOT NULL').get().c;
const withSen = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE senatorial IS NOT NULL').get().c;
console.log(`parsed ${r.parsed} rows (${r.skipped} skipped, ${r.unique} unique codes)`);
console.log(`polling_units now: ${total}; with senatorial district: ${withSen}; geocoded: ${geocoded}`);
