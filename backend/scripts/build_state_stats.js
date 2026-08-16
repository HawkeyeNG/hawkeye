#!/usr/bin/env node
/**
 * Per-state facts for the governorship race pages -> app/political_data.json:stateStats.
 *
 *   { "Kano": { "lgas": 44, "pollingUnits": 11222 }, ... }
 *
 * WHY A GENERATED BLOCK rather than a lookup at page load. The race page's stat
 * bar renders SYNCHRONOUSLY (race.js says so, and means it — awaiting an 800 KB
 * lga_geo.json before painting would trade a fast page for a decorative one), so
 * the counts have to be in the JSON the page already fetches. Hand-writing 36
 * pairs would be 72 chances to be wrong about a fact anyone can check.
 *
 * LGA counts come from app/lga_geo.json (the same file that draws the map, so the
 * number and the shapes can never disagree) and polling-unit counts from the
 * register. Both are counted, never typed.
 *
 *   node backend/scripts/build_state_stats.js          # writes political_data.json
 *   node backend/scripts/build_state_stats.js --print  # stdout only, writes nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEO = path.join(ROOT, 'app', 'lga_geo.json');
const PD = path.join(ROOT, 'app', 'political_data.json');
const DB = path.join(ROOT, 'backend', 'storage', 'hawkeye.db');

// The register and the geo file spell states identically once cased, so the geo
// file's own key is the join. Title-cased for display: "akwa ibom" -> "Akwa Ibom".
const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const geo = JSON.parse(fs.readFileSync(GEO, 'utf8'));
const lgaCount = new Map();
for (const l of geo.lgas) {
  const st = String(l.key).split('|')[0];
  lgaCount.set(st, (lgaCount.get(st) || 0) + 1);
}

// Polling units per state, keyed by the register's own spelling then matched to
// the geo key. A state the register cannot supply keeps its LGA count and simply
// has no polling-unit cell — a missing stat is honest, a zero is a claim.
const units = new Map();
try {
  const db = new DatabaseSync(DB, { readOnly: true });
  for (const r of db.prepare('SELECT state, COUNT(*) n FROM polling_units GROUP BY state').all()) {
    units.set(norm(r.state), Number(r.n));
  }
  db.close();
} catch (e) {
  console.warn(`! register unavailable (${e.message}) — writing LGA counts only`);
}

const stateStats = {};
for (const [key, lgas] of [...lgaCount].sort()) {
  const name = key === 'fct' ? 'FCT' : title(key);
  const pu = units.get(norm(key));
  stateStats[name] = pu == null ? { lgas } : { lgas, pollingUnits: pu };
}

const totalLgas = Object.values(stateStats).reduce((s, v) => s + v.lgas, 0);
const totalPu = Object.values(stateStats).reduce((s, v) => s + (v.pollingUnits || 0), 0);
console.log(`${Object.keys(stateStats).length} states · ${totalLgas} LGAs · ${totalPu.toLocaleString()} polling units`);
if (totalLgas !== 774) console.warn(`! expected 774 LGAs, counted ${totalLgas}`);

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(stateStats, null, 1));
} else {
  const pd = JSON.parse(fs.readFileSync(PD, 'utf8'));
  pd.stateStats = stateStats;
  fs.writeFileSync(PD, `${JSON.stringify(pd, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, PD)}:stateStats`);
}
