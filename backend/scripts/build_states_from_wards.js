// Rebuild app/states_geo.json at WARD resolution, dissolving the GRID3 ward
// polygons into the 36 states + FCT through ONE TopoJSON topology.
//   node scripts/build_states_from_wards.js
//
// WHY THIS EXISTS. The old states_geo.json came from fetch_states_geo.js, which
// asked ArcGIS for server-simplified geometry and projected each state on its
// own. Douglas-Peucker applied PER FEATURE does not preserve shared edges: two
// neighbours' common border is thinned differently on each side, so the polygons
// stop touching and the background shows through between them. Measured on the
// file this replaces:
//
//     37 states, 1,810 vertices, 1,199 distinct
//     only 47.8% of distinct points were touched by two or more states
//
// against the bar the rest of this repo's partitions are held to — >70% shared,
// >99% area coverage. Below that the map has real holes, and on the political
// map, where 31 of 37 states are the SAME colour, every one of those holes reads
// as a stray dark line through a solid block.
//
// The cure is the one merge_regions.js, build_reps_from_wards.js and
// build_lga_from_wards.js already use, and this file is a straight sibling of
// the last: build one topology so every coincident border becomes a SINGLE
// shared arc, simplify the TOPOLOGY (both sides of a border move together, by
// construction), then merge each state's wards.
//
// SUPERSEDES scripts/fetch_states_geo.js. Running that again re-introduces the
// holes; its header says so too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { merge } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(backend, '..', 'app');

// The key normalisation every client already uses (normState in
// components/nigeria-map.tsx, and the twins in political.html / results.html).
const norm = (s) => {
  const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
};

// Same projection and viewBox as every other geo file, so the layers still
// align. ONE decimal, not integer: audit/shrink_geo.mjs rounds to whole units,
// which is invisible at the national viewBox but costs up to ±0.5 unit once a
// board zooms. Keep states_geo.json out of that script's file list.
const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];

/** Display name for a normalised key — the spelling the clients render. */
const DISPLAY = {
  fct: 'FCT',
};
const titleCase = (k) =>
  DISPLAY[k] ?? k.replace(/\b[a-z]/g, (c) => c.toUpperCase());

const raw = path.join(backend, 'storage', 'raw', 'nga_wards.geojson');
if (!fs.existsSync(raw)) {
  console.error(`missing ${raw} — fetch it with scripts/fetch_ward_polygons.py first`);
  process.exit(1);
}
const geo = JSON.parse(fs.readFileSync(raw, 'utf8'));
console.log(`ward polygons: ${geo.features.length}`);

let tagged = 0;
for (const f of geo.features) {
  const p = f.properties || {};
  const st = norm(p.statename ?? p.s);
  f.properties = st ? { key: st } : { key: null };
  if (f.properties.key) tagged++;
}
console.log(`wards with a state: ${tagged} / ${geo.features.length}`);

let topo = topology({ wards: geo }, 1e5);
topo = presimplify(topo);
/**
 * 0.02, CHOSEN BY MEASUREMENT — and note the direction: in this API a HIGHER
 * quantile keeps MORE vertices, which is the opposite of what the name suggests
 * and the opposite of what I assumed on the first pass.
 *
 * Swept against the two things that matter, detail and wire weight:
 *
 *     Q       vertices    raw     gzip    shared
 *     (old)      1,810   23.7 KB   8.6 KB   47.8%   <- tore, and looked like a lozenge
 *     0.02       5,836   72.6 KB  24.6 KB   81.2%   <- shipped
 *     0.10       9,899  118   KB    —       80.3%
 *     0.30      20,794  244   KB    —       81.0%
 *
 * Past 0.02 the shared-vertex ratio stops improving — the topology is already
 * doing that work — so everything above it buys coastline detail nobody can see
 * at a 37-shape national viewBox, and pays for it on a metered Nigerian mobile
 * link. app/results.html pre-warms this file on a page that draws no map at all,
 * so its weight is charged to people who may never open a board.
 *
 * +16 KB on the wire against the file it replaces, for 3.2x the vertices and a
 * partition that actually tiles. That is the trade; do not raise it casually.
 */
topo = simplify(topo, quantile(topo, 0.02));

const groups = new Map();
for (const g of topo.objects.wards.geometries) {
  const k = g.properties?.key;
  if (!k) continue;
  (groups.get(k) ?? groups.set(k, []).get(k)).push(g);
}
console.log(`state groups: ${groups.size}`);

const ringArea = (poly) => {
  const r = poly[0];
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(a);
};

// ---------------------------------------------------------------------------
// WHERE A PARTY EMBLEM GOES, computed here rather than at render time.
//
// The web measures this in the browser (app/map-label.js:labelPoint) off the
// rendered path, using getBBox / getTotalLength / isPointInFill. react-native-svg
// implements none of those, so the app had no way to place a badge and its own
// docstring said so — which is why the native map has been colour-only.
//
// Computing it in the builder fixes that and is better anyway: it runs once, at
// full precision, on the real rings rather than on a sampled outline.
//
// This is the pole of inaccessibility — the centre of the largest circle that
// fits inside the polygon (Mapbox's polylabel, grid-refinement form). NOT the
// centroid: Nigeria has several states that are concave or multi-bodied, where
// the centroid sits on the border or outside the state entirely.
//
// `lr` is the radius of that circle, in viewBox units, and it is the useful
// second half: a client can size each badge to the room actually available, and
// skip the states where nothing legible fits, instead of drawing 37 identical
// emblems and letting the small ones spill over their borders.
// ---------------------------------------------------------------------------
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  let t = dx || dy ? ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy) : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
/** Signed clearance: + inside the polygon, - outside. Holes count as outside. */
function clearance(x, y, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = distToSeg(x, y, ring[i], ring[i + 1]);
      if (d < best) best = d;
    }
  }
  // Outer ring decides inside/outside; any further ring is a hole.
  let inside = pointInRing(x, y, rings[0]);
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i])) inside = false;
  return inside ? best : -best;
}
function poleOfInaccessibility(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of rings[0]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  let step = Math.min(w, h) / 16 || 1;
  let best = { x: minX + w / 2, y: minY + h / 2, r: -Infinity };
  // Coarse sweep, then four refinement passes halving the step around the
  // winner. Enough for a badge: the answer only has to be comfortably inside.
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      const r = clearance(x, y, rings);
      if (r > best.r) best = { x, y, r };
    }
  }
  for (let pass = 0; pass < 5; pass++) {
    step /= 2;
    const c = { ...best };
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const x = c.x + dx * step;
        const y = c.y + dy * step;
        const r = clearance(x, y, rings);
        if (r > best.r) best = { x, y, r };
      }
    }
  }
  return best;
}

const states = [];
for (const [key, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  const merged = merge(topo, members);
  const polys = (merged.type === 'MultiPolygon' ? merged.coordinates : [merged.coordinates])
    .filter((p) => p && p[0] && p[0].length >= 4);
  if (!polys.length) { console.log(`  (skipped empty: ${key})`); continue; }
  let dPath = '';
  for (const poly of polys) for (const ring of poly) {
    dPath += ring.map(([lng, lat], i) => (i ? 'L' : 'M') + project(lng, lat).join(' ')).join('') + 'Z';
  }
  /**
   * cx/cy is the LARGEST ring's centroid, and it is a FALLBACK only.
   *
   * Both clients place their party emblem with labelPoint(), measured off the
   * rendered path, because a ring centroid is the visual middle of a convex
   * shape and Nigeria has several states that are neither convex nor single-
   * bodied — the centroid lands on the border, or outside. Kept because the
   * field is in the published shape and something may still read it.
   */
  const big = polys.length > 1 ? polys.reduce((m, p) => (ringArea(p) > ringArea(m) ? p : m)) : polys[0];
  let cx = 0, cy = 0;
  for (const [lng, lat] of big[0]) { const [x, y] = project(lng, lat); cx += +x; cy += +y; }
  const n = big[0].length;

  // The label point, in PROJECTED viewBox units — the same space `path` is in,
  // so a client can use it without knowing anything about lng/lat.
  const projected = big.map((ring) => ring.map(([lng, lat]) => project(lng, lat).map(Number)));
  const pole = poleOfInaccessibility(projected);

  states.push({
    name: titleCase(key),
    key,
    path: dPath,
    cx: Math.round(cx / n),
    cy: Math.round(cy / n),
    lx: +pole.x.toFixed(1),
    ly: +pole.y.toFixed(1),
    lr: +Math.max(0, pole.r).toFixed(1),
  });
}

const out = { viewBox: '0 0 800 660', states };
const dest = path.join(appDir, 'states_geo.json');
fs.writeFileSync(dest, JSON.stringify(out));

// ---- the regression bar, printed so a bad run cannot look like a good one ---
const pts = (d) => {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) || [];
  const o = [];
  for (let i = 0; i + 1 < nums.length; i += 2) o.push(`${nums[i]},${nums[i + 1]}`);
  return o;
};
const seen = new Map();
let total = 0;
for (const s of states) {
  const p = pts(s.path);
  total += p.length;
  for (const q of new Set(p)) seen.set(q, (seen.get(q) ?? 0) + 1);
}
let shared = 0;
for (const [, n] of seen) if (n >= 2) shared++;
const ratio = (shared / seen.size) * 100;
const kb = (fs.statSync(dest).size / 1024).toFixed(0);
console.log(`wrote ${dest}: ${states.length} states, ${total.toLocaleString()} vertices, ${kb} KB`);
console.log(`shared vertices: ${ratio.toFixed(1)}%  (bar: >70%)`);
if (states.length !== 37) {
  console.error(`GATE_FAIL: expected 37 states + FCT, got ${states.length}`);
  process.exit(1);
}
if (ratio < 70) {
  console.error('GATE_FAIL: the partition still tears — do not ship this file');
  process.exit(1);
}
console.log('GATE_OK');
