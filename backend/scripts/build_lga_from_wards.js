// Rebuild app/lga_geo.json at WARD resolution, dissolving the GRID3 ward
// polygons into LGAs through ONE TopoJSON topology.
//   node scripts/build_lga_from_wards.js
//
// WHY THIS EXISTS. The old lga_geo.json came from fetch_lga_geo.js, which asked
// ArcGIS for server-simplified geometry (maxAllowableOffset 0.02 ≈ 2.2km) and
// projected each LGA on its own. Douglas-Peucker applied PER FEATURE does not
// preserve shared edges: two neighbours' common border is thinned differently on
// each side, so the polygons stop touching. Measured on the live file: only 52%
// of Osun's LGA vertices sat on a neighbour's boundary, the p90 vertex-to-
// neighbour gap was ~3 user units (~36 CSS px once the state-scoped board zooms
// ~12x), and the 30 LGAs covered only 98.6% of the state — the missing 1.4% is
// exactly the slivers showing through as holes.
//
// This is the same cure merge_regions.js / build_reps_from_wards.js already use
// for districts and constituencies: build one topology so every coincident
// border becomes a SINGLE shared arc, simplify the TOPOLOGY (both sides of a
// border move together, by construction), then merge each LGA's members. Wards
// are the right source — measured 85.7% of Osun ward vertices already lie on a
// neighbour's boundary, at ~21x the vertex budget of the LGA layer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { merge } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(backend, '..', 'app');
const norm = (s) => {
  const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
};
// Same projection and viewBox as every other geo file, so the layers still align.
// ONE decimal, not integer: audit/shrink_geo.mjs rounds these to whole units,
// which is invisible at the national viewBox but costs up to ±0.5 unit (~6px)
// once a state-scoped board zooms ~12x. Keep lga_geo.json out of that script.
const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];

const raw = path.join(backend, 'storage', 'raw', 'nga_wards.geojson');
if (!fs.existsSync(raw)) {
  console.error(`missing ${raw} — fetch it with scripts/fetch_ward_polygons.py first`);
  process.exit(1);
}
const geo = JSON.parse(fs.readFileSync(raw, 'utf8'));
console.log(`ward polygons: ${geo.features.length}`);

// Tag every ward with the LGA it dissolves into. The raw file uses
// statename/lganame; the trimmed app copy uses s/l — accept either.
let tagged = 0;
for (const f of geo.features) {
  const p = f.properties || {};
  const st = norm(p.statename ?? p.s);
  const lg = norm(p.lganame ?? p.l);
  f.properties = st && lg ? { key: `${st}|${lg}` } : { key: null };
  if (f.properties.key) tagged++;
}
console.log(`wards with an LGA: ${tagged} / ${geo.features.length}`);

let topo = topology({ wards: geo }, 1e5);
topo = presimplify(topo);
// Same quantile the constituency build uses — enough thinning to keep the file
// small, applied to shared arcs so neighbours can never drift apart.
topo = simplify(topo, quantile(topo, 0.22));

const groups = new Map();
for (const g of topo.objects.wards.geometries) {
  const k = g.properties?.key;
  if (!k) continue;
  (groups.get(k) ?? groups.set(k, []).get(k)).push(g);
}
console.log(`LGA groups: ${groups.size}`);

const ringArea = (poly) => {
  const r = poly[0];
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(a);
};

const lgas = [];
for (const [key, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  const merged = merge(topo, members);
  const polys = (merged.type === 'MultiPolygon' ? merged.coordinates : [merged.coordinates])
    .filter((p) => p && p[0] && p[0].length >= 4);
  if (!polys.length) { console.log(`  (skipped empty: ${key})`); continue; }
  let dPath = '';
  // Every ring, holes included — fill-rule evenodd is what the renderers use.
  for (const poly of polys) for (const ring of poly) {
    dPath += ring.map(([lng, lat], i) => (i ? 'L' : 'M') + project(lng, lat).join(' ')).join('') + 'Z';
  }
  const big = polys.length > 1 ? polys.reduce((m, p) => (ringArea(p) > ringArea(m) ? p : m)) : polys[0];
  let cx = 0, cy = 0;
  for (const [lng, lat] of big[0]) { const [x, y] = project(lng, lat); cx += +x; cy += +y; }
  const n = big[0].length;
  lgas.push({ key, path: dPath, cx: Math.round(cx / n), cy: Math.round(cy / n) });
}

const out = { viewBox: '0 0 800 660', lgas };
const dest = path.join(appDir, 'lga_geo.json');
fs.writeFileSync(dest, JSON.stringify(out));
const kb = (fs.statSync(dest).size / 1024).toFixed(0);
const verts = lgas.reduce((a, l) => a + ((l.path.match(/-?\d+(?:\.\d+)?/g) || []).length / 2), 0);
console.log(`wrote ${dest}: ${lgas.length} LGAs, ${verts} vertices, ${kb} KB`);
