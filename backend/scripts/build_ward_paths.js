/* WARD PATHS, PER STATE, LABELLED WITH THE REGISTER'S NAMES.
 *
 * build_lga_from_wards.js dissolves these same polygons UP into LGAs. This
 * keeps them as wards, because a state-constituency race page draws a single
 * LGA shape today — 765 of the 1,005 seats sit inside one LGA — and one shape
 * is not a map. Its wards are 8 to 20 shapes and are the grain the seat is
 * actually built from.
 *
 * TWO THINGS MAKE THIS MORE THAN A FILTER:
 *
 * 1. The names. The polygon file spells wards its own way; the board buckets
 *    reports by the INEC register's spelling. Every ward here is relabelled
 *    through data/ward_crosswalk.json, and a ward that the crosswalk could not
 *    resolve is DROPPED rather than shipped under a name nothing will match —
 *    a shape that can never be coloured is worse than an absent shape, because
 *    it reads as "no reports here".
 *
 * 2. The topology. Simplified per feature, neighbouring wards drift apart and
 *    the map grows slivers. Simplified as ONE topology (the same reason
 *    build_lga_from_wards.js does it), a shared border stays a shared arc.
 *
 * Partitioned per state so a race page fetches one state, not the nation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { feature } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(backend, '..', 'app');

/* The crosswalk's keys, so a lookup built here can never miss on case alone. */
const up = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const slug = (s) => up(s).toLowerCase().replace(/ /g, '-');

const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];

const cwPath = path.join(backend, 'src', 'data', 'ward_crosswalk.json');
const { lgaAlias, wards: cw } = JSON.parse(fs.readFileSync(cwPath, 'utf8'));

/* polygon "STATE|LGA|WARD" -> the register's spelling of that ward, and the
   register's own LGA key, which is what the board reports against. */
const label = new Map();
for (const [regKey, pairs] of Object.entries(cw)) {
  const polyKey = lgaAlias[regKey] || regKey;
  for (const [regWard, polyWard] of Object.entries(pairs)) {
    label.set(polyKey + '|' + polyWard, { lga: regKey, ward: regWard });
  }
}

const raw = path.join(appDir, 'nga_wards.geojson');
const geo = JSON.parse(fs.readFileSync(raw, 'utf8'));
console.log('ward polygons: ' + geo.features.length);

let kept = 0;
for (const f of geo.features) {
  const p = f.properties || {};
  const hit = label.get(up(p.s ?? p.statename) + '|' + up(p.l ?? p.lganame) + '|' + up(p.w ?? p.wardname));
  f.properties = hit ? { lga: hit.lga, ward: hit.ward } : { lga: null };
  if (hit) kept++;
}
geo.features = geo.features.filter((f) => f.properties.lga);
console.log('resolved through the crosswalk: ' + kept);

let topo = topology({ wards: geo }, 1e5);
topo = presimplify(topo);
/* Lighter than the LGA build's 0.22: these are drawn zoomed into one LGA, so
   detail that is invisible nationally is visible here. */
topo = simplify(topo, quantile(topo, 0.5));

const fc = feature(topo, topo.objects.wards);
const states = new Map();
for (const f of fc.features) {
  const { lga, ward } = f.properties;
  const [st] = lga.split('|');
  const polys = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates])
    .filter((p) => p && p[0] && p[0].length >= 4);
  if (!polys.length) continue;
  let d = '';
  const xs = [], ys = [];
  for (const poly of polys) for (const ring of poly) {
    d += ring.map(([lng, lat], i) => {
      const [x, y] = project(lng, lat);
      xs.push(+x); ys.push(+y);
      return (i ? 'L' : 'M') + x + ' ' + y;
    }).join('') + 'Z';
  }
  const s = states.get(st) || states.set(st, { lgas: {} }).get(st);
  const key = lga.split('|')[1];
  const L = s.lgas[key] || (s.lgas[key] = { wards: [], x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
  L.wards.push({ n: ward, d });
  L.x0 = Math.min(L.x0, ...xs); L.x1 = Math.max(L.x1, ...xs);
  L.y0 = Math.min(L.y0, ...ys); L.y1 = Math.max(L.y1, ...ys);
}

/* Ward counts per state, straight from the register the board reports
   against -- not from the polygon file, which is the thing being measured. */
const registerTotals = {};
{
  const per = JSON.parse(fs.readFileSync(path.join(backend, '..', 'tmp', 'wards', 'register_truth.json'), 'utf8')).perLga;
  for (const [k, n] of Object.entries(per)) {
    const st = k.split('|')[0];
    registerTotals[st] = (registerTotals[st] || 0) + n;
  }
}

const dir = path.join(appDir, 'maps', 'wards');
fs.mkdirSync(dir, { recursive: true });
let files = 0, bytes = 0, lgaCount = 0;
for (const [st, s] of states) {
  /* The viewBox is per LGA, not per state: a race page draws one LGA and needs
     it to fill the frame. A 2% margin keeps the outer stroke inside the box. */
  for (const L of Object.values(s.lgas)) {
    const w = Math.max(1, L.x1 - L.x0), h = Math.max(1, L.y1 - L.y0);
    const m = Math.max(w, h) * 0.02;
    L.box = [(L.x0 - m).toFixed(1), (L.y0 - m).toFixed(1), (w + m * 2).toFixed(1), (h + m * 2).toFixed(1)].join(' ');
    delete L.x0; delete L.y0; delete L.x1; delete L.y1;
    lgaCount++;
  }
  /* What this file covers, measured against the register it is keyed to. The
     client refuses to draw a choropliced state below 80%: a map missing two
     thirds of its wards reads as "nothing happened there". */
  const have = Object.values(s.lgas).reduce((a, L) => a + L.wards.length, 0);
  s.cov = registerTotals[st] ? +(have / registerTotals[st]).toFixed(3) : 0;
  s.wards = have;
  const dest = path.join(dir, slug(st) + '.json');
  fs.writeFileSync(dest, JSON.stringify(s));
  bytes += fs.statSync(dest).size;
  files++;
}
console.log('wrote ' + files + ' state files, ' + lgaCount + ' LGAs, '
  + (bytes / 1024).toFixed(0) + ' KB total, ' + (bytes / 1024 / files).toFixed(0) + ' KB each');
