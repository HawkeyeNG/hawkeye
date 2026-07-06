// Geocode polling units by NAME via OpenStreetMap Nominatim, one state at a time,
// for units that only have a coarse (ward/settlement) approximate location. Each
// hit is validated against that envelope so wrong matches are rejected, then
// appended to storage/raw/geocoded_<State>.csv (pu_code,lat,lng). A server-side
// loader applies these as provisional 'geocoded' coordinates; a live observer
// cluster later upgrades them to verified.
//
//   node scripts/geocode_nominatim.js "FCT"
//
// File-based (no DB) so it runs anywhere. Respects Nominatim's ~1 req/sec policy
// (1.1s delay); resumable — skips pu_codes already in the output CSV.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';

const stateArg = process.argv[2];
if (!stateArg) { console.error('usage: node scripts/geocode_nominatim.js "<State>"'); process.exit(1); }
const rawDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'raw');
const UA = { 'user-agent': 'Hawkeye-election-monitor/0.1 (civic transparency; hawkeye.com.ng)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bFct\b/g, 'FCT');
const norm = (s) => { const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); return /fct|federal capital|abuja/.test(n) ? 'fct' : n; };
const R = 6371000, hav = (a, b, c, d) => { const t = (x) => x * Math.PI / 180, dLa = t(c - a), dLo = t(d - b); const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

// approx envelope per pu_code (coarse sources only — precise POI matches already seeded)
const approx = {};
for (const r of parseSync(fs.readFileSync(path.join(rawDir, 'approx_locations.csv'), 'utf8'), { columns: true, trim: true })) {
  if (r.source === 'ward_centroid' || r.source === 'grid3_settlement') approx[r.pu_code] = { lat: +r.lat, lng: +r.lng, rad: +r.radius_m };
}

const outPath = path.join(rawDir, `geocoded_${stateArg.replace(/\s+/g, '_')}.csv`);
const done = new Set();
if (fs.existsSync(outPath)) for (const l of fs.readFileSync(outPath, 'utf8').split('\n').slice(1)) if (l) done.add(l.split(',')[0]);
else fs.writeFileSync(outPath, 'pu_code,lat,lng\n');

// candidate units in the target state
const cands = [];
const parser = fs.createReadStream(path.join(rawDir, 'nigeria_polling_units.csv')).pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, trim: true }));
for await (const row of parser) {
  if (norm(row.state) !== norm(stateArg)) continue;
  const pu = (row.code || '').replaceAll('/', '-');
  if (!approx[pu] || done.has(pu)) continue;
  cands.push({ pu, name: titleCase(row.location), ward: titleCase(row.ward), lga: titleCase(row.lg), state: titleCase(row.state), ...approx[pu] });
}
console.log(`${stateArg}: ${cands.length} candidate units to geocode (${done.size} already done)`);

let hit = 0;
for (let i = 0; i < cands.length; i++) {
  const u = cands[i];
  const q = `${u.name}, ${u.ward}, ${u.lga}, ${u.state}, Nigeria`;
  try {
    const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ng&q=${encodeURIComponent(q)}`, { headers: UA })).json();
    if (r[0]) {
      const lat = +r[0].lat, lng = +r[0].lon;
      if (hav(lat, lng, u.lat, u.lng) <= u.rad * 2 + 1500) { fs.appendFileSync(outPath, `${u.pu},${lat},${lng}\n`); hit++; }
    }
  } catch { /* skip */ }
  if (i % 50 === 0) process.stdout.write(`\r  ${i}/${cands.length} · ${hit} located`);
  await sleep(1100);
}
console.log(`\n${stateArg}: geocoded ${hit}/${cands.length} -> ${path.basename(outPath)}`);
