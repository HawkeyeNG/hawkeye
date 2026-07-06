// Dissolve LGA polygons into clean merged region shapes via TopoJSON (shared
// arcs merge exactly — no slivers, coincident borders):
//   app/district_geo.json      — 109 senatorial districts
//   app/constituency_geo.json  — federal constituencies
//   node scripts/build_district_index.js && node scripts/merge_regions.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { merge } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(backend, '..', 'app');
const idx = JSON.parse(fs.readFileSync(path.join(appDir, 'district_index.json'), 'utf8'));
const URL = 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/NGA_LGA_Boundaries_2/FeatureServer/0';
const norm = (s) => { const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); return /fct|federal capital|abuja/.test(n) ? 'fct' : n; };
const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];

// LGA features as GeoJSON
const feats = [];
for (let off = 0; ; off += 2000) {
  // NO server-side simplification: full-res rings keep shared LGA borders exactly
  // coincident, so topology() sees them as one arc and merge() dissolves internal
  // lines cleanly. Simplification happens once, AFTER the topology is built.
  const p = new URLSearchParams({ where: '1=1', outFields: 'lganame,statename', returnGeometry: 'true', resultOffset: String(off), resultRecordCount: '2000', f: 'json' });
  const d = await (await fetch(`${URL}/query?${p}`)).json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  for (const f of d.features || []) {
    const a = f.attributes || {};
    if (!a.lganame || !f.geometry?.rings) continue;
    feats.push({
      type: 'Feature',
      properties: { key: `${norm(a.statename)}|${norm(a.lganame)}` },
      geometry: { type: 'Polygon', coordinates: f.geometry.rings },
    });
  }
  if (!d.exceededTransferLimit && (d.features || []).length < 2000) break;
}
console.log(`LGA features: ${feats.length}`);

// one topology; simplify while PRESERVING shared-arc topology
let topo = topology({ lgas: { type: 'FeatureCollection', features: feats } }, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.25)); // keep 75% weight — smooth but faithful

const geoms = topo.objects.lgas.geometries;

// Fuzzy-resolve GRID3 LGA keys that don't exactly match a register key, so every
// LGA joins a district (no holes -> watertight dissolve like the state map).
const bigrams = (s) => { const t = `_${s.replace(/\|/g, ' ')}_`, g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
const dice = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return (2 * n) / (a.size + b.size); };
const idxKeys = Object.keys(idx).map((k) => ({ k, st: k.split('|')[0], bg: bigrams(k) }));
const resolve = (key) => {
  if (idx[key]) return idx[key];
  const st = key.split('|')[0], bg = bigrams(key);
  let best = null, bs = 0.5;
  for (const c of idxKeys) if (c.st === st) { const s = dice(bg, c.bg); if (s > bs) { bs = s; best = c.k; } }
  return best ? idx[best] : null;
};

function build(level) {
  const groups = new Map();
  for (const g of geoms) {
    const region = resolve(g.properties.key)?.[level];
    if (!region) continue;
    (groups.get(region) ?? groups.set(region, []).get(region)).push(g);
  }
  const regions = [];
  for (const [name, members] of groups) {
    const merged = merge(topo, members);
    const polys = merged.type === 'MultiPolygon' ? merged.coordinates : [merged.coordinates];
    // Keep the FULL merged geometry (every piece + enclave holes). Since all 774
    // LGAs are assigned to a district and shared borders are one topology arc, the
    // districts tile the country watertight — no gaps, no unlabelled areas. Holes
    // (enclaves) are punched with evenodd so the enclave district shows through.
    // FCT/Abuja: exterior rings only — extends its fill over any interior hole so
    // the capital area shows no gap on either map.
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
  return regions;
}
const area = (poly) => { const r = poly[0]; let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return Math.abs(a); };

const sen = build('senatorial');
const fed = build('federal');
fs.writeFileSync(path.join(appDir, 'district_geo.json'), JSON.stringify({ viewBox: '0 0 800 660', regions: sen }));
fs.writeFileSync(path.join(appDir, 'constituency_geo.json'), JSON.stringify({ viewBox: '0 0 800 660', regions: fed }));
console.log(`districts: ${sen.length}, constituencies: ${fed.length}`);
