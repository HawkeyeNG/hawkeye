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

/**
 * THE SEATS THE REGISTER CANNOT SEPARATE.
 *
 * A handful of dense Lagos LGAs elect TWO federal members — Mushin I and II,
 * Lagos Island I and II, Surulere I and II, Oshodi-Isolo I and II — but
 * polling_units records one LGA per unit and nothing that says which of the two
 * seats a unit votes in. So the query above can only ever produce one row per
 * LGA, and the second seat has no entry at all. The boundary file DOES carry
 * both, so the leaderboard drew a region that linked to a page which did not
 * exist: "Hawkeye has no page for this race yet", about a real seat.
 *
 * These are filled in from the boundary file, sharing the LGA's own figures and
 * SAYING SO. The alternative — halving the unit count between them — would be a
 * fabricated number, and leaving the region dead was the bug. `sharedRegister`
 * is what the page prints to explain why its figures cover both seats.
 */
const GEO = path.join(ROOT, 'app', 'constituency_geo.json');
if (fs.existsSync(GEO)) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const regions = (JSON.parse(fs.readFileSync(GEO, 'utf8')).regions || []).map((r) => r.name).filter(Boolean);
  const parts = (x) => String(x || '').split('/').map(norm).filter(Boolean).sort().join('|');
  const byParts = new Map(Object.keys(out.REP).map((k) => [parts(k), k]));
  let added = 0;
  for (const name of regions) {
    if (out.REP[name] || byParts.has(parts(name))) continue;
    // Strip a trailing roman numeral to find the sibling this seat shares an LGA
    // with. Only I/II occur; anything else is left alone rather than guessed at.
    const base = name.replace(/\s+(i|ii)$/i, '').trim();
    if (base === name) continue;
    const sib = Object.keys(out.REP).find((k) => {
      const kb = k.replace(/\s+(i|ii)$/i, '').trim();
      return norm(kb) === norm(base) || parts(kb) === parts(base);
    });
    if (!sib) continue;
    out.REP[name] = {
      state: out.REP[sib].state,
      lgas: [...out.REP[sib].lgas],
      pollingUnits: out.REP[sib].pollingUnits,
      // Both halves are flagged: the sibling's figures are equally shared.
      sharedRegister: true,
    };
    out.REP[sib].sharedRegister = true;
    added++;
  }
  if (added) console.log(`filled ${added} numbered seat(s) the register does not separate`);
}

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
