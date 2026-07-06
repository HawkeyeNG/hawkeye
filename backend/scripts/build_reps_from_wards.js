// Rebuild the House of Reps map at WARD resolution: dissolve the 9,410 GRID3
// ward polygons into federal constituencies using the register's ward-level
// house_of_rep assignment (majority per ward). Far more faithful than the old
// LGA dissolve — constituencies that split an LGA now get real boundaries.
//   node scripts/build_reps_from_wards.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import { topology } from 'topojson-server';
import { merge } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(backend, '..', 'app');
const norm = (s) => { const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); return /fct|federal capital|abuja/.test(n) ? 'fct' : n; };
const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bFct\b/g, 'FCT');
const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];

// ---- 1) register: (state|lga|ward) -> majority federal constituency
const tally = new Map();
const csv = path.join(backend, 'storage', 'raw', 'nigeria_polling_units.csv');
const parser = fs.createReadStream(csv).pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, trim: true }));
for await (const r of parser) {
  if (!r.state || !r.lg || !r.ward || !r.house_of_rep) continue;
  const key = `${norm(r.state)}|${norm(r.lg)}|${norm(r.ward)}`;
  const m = tally.get(key) || new Map();
  const f = titleCase(r.house_of_rep);
  m.set(f, (m.get(f) || 0) + 1);
  tally.set(key, m);
}
const wardFed = new Map();
for (const [k, m] of tally) wardFed.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
console.log(`register wards with a constituency: ${wardFed.size}`);

// fuzzy resolver for GRID3 ward names that differ from register spelling
const bigrams = (s) => { const t = `_${s}_`, g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
const dice = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return (2 * n) / (a.size + b.size); };
const byLga = new Map(); // state|lga -> [{ward, bg, fed}]
for (const [k, fed] of wardFed) {
  const [st, lg, wd] = k.split('|');
  const kk = `${st}|${lg}`;
  (byLga.get(kk) ?? byLga.set(kk, []).get(kk)).push({ wd, bg: bigrams(wd), fed });
}
const lgaKeys = [...byLga.keys()].map((k) => ({ k, st: k.split('|')[0], bg: bigrams(k.split('|')[1]) }));
function resolveWard(st, lg, wd) {
  let lgaKey = `${st}|${lg}`;
  if (!byLga.has(lgaKey)) { // fuzzy LGA
    let best = null, bs = 0.5; const bg = bigrams(lg);
    for (const c of lgaKeys) if (c.st === st) { const s = dice(bg, c.bg); if (s > bs) { bs = s; best = c.k; } }
    if (!best) return null;
    lgaKey = best;
  }
  const cands = byLga.get(lgaKey);
  const exact = cands.find((c) => c.wd === wd);
  if (exact) return exact.fed;
  let best = null, bs = 0.42; const bg = bigrams(wd);
  for (const c of cands) { const s = dice(bg, c.bg); if (s > bs) { bs = s; best = c; } }
  return best ? best.fed : null;
}

// ---- 2) ward polygons -> one topology (full-res, shared borders dissolve clean)
const geo = JSON.parse(fs.readFileSync(path.join(backend, 'storage', 'raw', 'nga_wards.geojson'), 'utf8'));
console.log(`ward polygons: ${geo.features.length}`);
// LGA-level fallback (the old dissolve's assignment) so unmatched wards can't
// leave holes — ward-resolution where the register knows better, LGA elsewhere.
const lgaIdx = JSON.parse(fs.readFileSync(path.join(appDir, 'district_index.json'), 'utf8'));
const lgaIdxKeys = Object.keys(lgaIdx).map((k) => ({ k, st: k.split('|')[0], bg: bigrams(k.split('|')[1] || '') }));
function lgaFallback(st, lg) {
  const direct = lgaIdx[`${st}|${lg}`];
  if (direct?.federal) return direct.federal;
  let best = null, bs = 0.5; const bg = bigrams(lg);
  for (const c of lgaIdxKeys) if (c.st === st) { const s = dice(bg, c.bg); if (s > bs) { bs = s; best = c.k; } }
  return best ? lgaIdx[best].federal : null;
}
let matched = 0, viaLga = 0, unmatchedW = 0;
for (const f of geo.features) {
  const p = f.properties;
  const st = norm(p.statename ?? p.s), lg = norm(p.lganame ?? p.l), wd = norm(p.wardname ?? p.w);
  let fed = resolveWard(st, lg, wd);
  if (fed) matched++;
  else { fed = lgaFallback(st, lg); if (fed) viaLga++; else unmatchedW++; }
  f.properties = { fed, st };
}
console.log(`wards assigned: ${matched} (ward-level) + ${viaLga} (LGA fallback), unassigned: ${unmatchedW}`);

let topo = topology({ wards: geo }, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.22));

// ---- 3) merge per constituency — canonicalize name variants first
// ("Askira-Uba/Hawul" vs "Askira Uba / Hawul" etc. must not split a region).
// token-sorted so "Kuje/Abaji/Gwagwalada" == "Abaji/Gwagwalada/Kuje"; then
// fuzzy-cluster remaining spelling variants ("Awgu"/"Agwu") within each state —
// a constituency never spans states, so clustering is state-scoped.
const canon = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join('');
const byState = new Map(); // st -> Map(canonKey -> Map(displayName -> count))
for (const g of topo.objects.wards.geometries) {
  const { fed, st } = g.properties;
  if (!fed) continue;
  const sm = byState.get(st) || new Map();
  const k = canon(fed);
  const m = sm.get(k) || new Map();
  m.set(fed, (m.get(fed) || 0) + 1);
  sm.set(k, m);
  byState.set(st, sm);
}
const clusterOf = new Map(); // `${st}::${canonKey}` -> cluster root key
const displayOf = new Map(); // root -> display name
for (const [st, sm] of byState) {
  const keys = [...sm.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if (dice(bigrams(keys[i]), bigrams(keys[j])) >= 0.72) parent.set(find(keys[j]), find(keys[i]));
  }
  const votes = new Map(); // root -> Map(display -> count)
  for (const k of keys) {
    const r = find(k);
    clusterOf.set(`${st}::${k}`, `${st}::${r}`);
    const v = votes.get(r) || new Map();
    for (const [d, c] of sm.get(k)) v.set(d, (v.get(d) || 0) + c);
    votes.set(r, v);
  }
  for (const [r, v] of votes) displayOf.set(`${st}::${r}`, [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}
const groups = new Map();
for (const g of topo.objects.wards.geometries) {
  const { fed, st } = g.properties;
  if (!fed) continue;
  const name = displayOf.get(clusterOf.get(`${st}::${canon(fed)}`));
  (groups.get(name) ?? groups.set(name, []).get(name)).push(g);
}
const area = (poly) => { const r = poly[0]; let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return Math.abs(a); };
const regions = [];
for (const [name, members] of groups) {
  const merged = merge(topo, members);
  const polys = (merged.type === 'MultiPolygon' ? merged.coordinates : [merged.coordinates])
    .filter((p) => p && p[0] && p[0].length >= 4);
  if (!polys.length) { console.log(`  (skipped empty geometry: ${name})`); continue; }
  const solid = /abuja|fct|federal capital/i.test(name);
  let dPath = '';
  for (const poly of polys) for (const ring of (solid ? [poly[0]] : poly)) {
    dPath += ring.map(([lng, lat], i) => (i ? 'L' : 'M') + project(lng, lat).join(' ')).join('') + 'Z';
  }
  const big = polys.length > 1 ? polys.reduce((m, p) => (area(p) > area(m) ? p : m)) : polys[0];
  let cx = 0, cy = 0;
  for (const [lng, lat] of big[0]) { const [x, y] = project(lng, lat); cx += +x; cy += +y; }
  regions.push({ name, path: dPath, cx: Math.round(cx / big[0].length), cy: Math.round(cy / big[0].length) });
}
fs.writeFileSync(path.join(appDir, 'constituency_geo.json'), JSON.stringify({ viewBox: '0 0 800 660', regions }));
console.log(`constituencies: ${regions.length} -> app/constituency_geo.json`);
