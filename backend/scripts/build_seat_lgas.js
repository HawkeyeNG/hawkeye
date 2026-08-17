#!/usr/bin/env node
/**
 * Every senatorial district and federal constituency, with its state, LGA
 * membership and size -> app/seat_lgas.json.
 *
 *   { "SEN": { "Abia North": { "state": "Abia", "lgas": [...], "pollingUnits": n } },
 *     "REP": { "Aba North/Aba South": { ... } } }
 *
 * WHY A SEPARATE FILE, not another block in political_data.json: political_data
 * is fetched by many pages, and 471 seats with their LGAs is ~90 KB none of them
 * need. Only a seat's own race page reads this, so only that page pays for it.
 *
 * WHY IT EXISTS AT ALL: a race page draws its seat by cutting the member LGAs
 * out of lga_geo.json, and nothing client-side can say which LGAs belong to
 * "Aba North/Aba South" — that is a fact about the register. Counted, never typed.
 *
 *   node backend/scripts/build_seat_lgas.js          # writes app/seat_lgas.json
 *   node backend/scripts/build_seat_lgas.js --print  # summary only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = path.join(ROOT, 'backend', 'storage', 'hawkeye.db');
const OUT = path.join(ROOT, 'app', 'seat_lgas.json');

const db = new DatabaseSync(DB, { readOnly: true });
const LEVELS = [['SEN', 'senatorial'], ['REP', 'federal_constituency']];
const out = {};

for (const [code, col] of LEVELS) {
  const rows = db.prepare(`
    SELECT ${col} AS seat, state, lga, COUNT(*) AS units
    FROM polling_units
    WHERE ${col} IS NOT NULL AND ${col} <> '' AND lga IS NOT NULL AND lga <> ''
    GROUP BY ${col}, state, lga
    ORDER BY ${col}, lga`).all();

  const seats = {};
  for (const r of rows) {
    // A seat name is unique nationally in the register, but keep the state from
    // the rows rather than assuming: it is what crops the map and what the board
    // link needs.
    const s = (seats[r.seat] ??= { state: r.state, lgas: [], pollingUnits: 0 });
    if (!s.lgas.includes(r.lga)) s.lgas.push(r.lga);
    s.pollingUnits += Number(r.units);
  }
  out[code] = seats;
}
db.close();

const n = (c) => Object.keys(out[c]).length;
const split = (c) => Object.values(out[c]).filter((s) => s.lgas.length === 1).length;
console.log(`SEN ${n('SEN')} districts (${split('SEN')} single-LGA)`);
console.log(`REP ${n('REP')} constituencies (${split('REP')} single-LGA)`);
if (n('SEN') !== 109) console.warn(`! expected 109 senatorial districts, got ${n('SEN')}`);

if (process.argv.includes('--print')) {
  const k = Object.keys(out.SEN)[0];
  console.log(k, JSON.stringify(out.SEN[k]));
} else {
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${kb} KB)`);
}
