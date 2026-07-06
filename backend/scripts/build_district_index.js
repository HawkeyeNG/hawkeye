// app/district_index.json — maps each LGA to its senatorial district + federal
// constituency (majority per LGA, from the INEC register), so the map can group
// LGA polygons into district/constituency regions.
//   node scripts/build_district_index.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = path.join(backend, 'storage', 'raw', 'nigeria_polling_units.csv');
const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bFct\b/g, 'FCT');
const norm = (s) => { const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); return /fct|federal capital|abuja/.test(n) ? 'fct' : n; };

const tally = new Map(); // lgaKey -> { sen:Map, fed:Map }
const parser = fs.createReadStream(csv).pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, trim: true }));
for await (const r of parser) {
  if (!r.state || !r.lg) continue;
  const key = `${norm(r.state)}|${norm(r.lg)}`;
  const e = tally.get(key) || { sen: new Map(), fed: new Map() };
  const s = titleCase(r.senatorial); const f = titleCase(r.house_of_rep);
  if (s) e.sen.set(s, (e.sen.get(s) || 0) + 1);
  if (f) e.fed.set(f, (e.fed.get(f) || 0) + 1);
  tally.set(key, e);
}
const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
const index = {};
for (const [key, e] of tally) index[key] = { senatorial: top(e.sen), federal: top(e.fed) };

// Overrides reconciling the INEC register with the GRID3 polygon source so every
// LGA joins a region in merge_regions.js (otherwise its polygon renders as a hole):
//   • AMAC — the register lists it under "Abuja" so norm() collapses it to fct|fct,
//     but GRID3 names the polygon "Municipal Area Council". Alias so it joins.
//   • Maiduguri — its house_of_rep column is blank in the register, so it had no
//     federal constituency (its own single-LGA seat, Maiduguri Metropolitan).
if (index['fct|fct']) index['fct|municipal area council'] = index['fct|fct'];
if (index['borno|maiduguri'] && !index['borno|maiduguri'].federal) {
  index['borno|maiduguri'].federal = 'Maiduguri Metropolitan';
}

fs.writeFileSync(path.join(backend, '..', 'app', 'district_index.json'), JSON.stringify(index));
console.log(`saved ${Object.keys(index).length} LGA->district mappings`);
