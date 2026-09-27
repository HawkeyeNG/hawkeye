/**
 * The clip region for the Nigeria basemap extract (.github/workflows/basemap-tiles.yml).
 *
 * Nigeria's convex hull, grown ~0.3° (~33 km) outward, from the ward polygons we
 * already ship (app/nga_wards.geojson). Written to scripts/tiles/nigeria_region.geojson,
 * which the workflow reads — committed, so the runner needs no Node step.
 *
 * WHY A HULL AND NOT THE BBOX. Measured on the 2026-09-27 Protomaps build:
 *
 *   maxzoom   bbox 2.6,4.2,14.7,13.95   this hull
 *   z13       296 MB                    —
 *   z14       550 MB                    414 MB
 *   z15       1.3 GB                    1.1 GB
 *
 * Cloudflare caches a single file only up to 512 MB on Free/Pro/Business. The bbox
 * corners are Niger, Chad, Cameroon and open sea; cutting them is what brings z14
 * under the line, so every range request is answered from the edge instead of R2.
 *
 *   node scripts/tiles/make_region.mjs [marginDegrees=0.3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../../app/nga_wards.geojson');
const OUT = path.join(HERE, 'nigeria_region.geojson');
const MARGIN = Number(process.argv[2] || 0.3);

const g = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const pts = [];
const walk = (c) => { if (typeof c[0] === 'number') pts.push(c); else c.forEach(walk); };
for (const f of g.features) walk(f.geometry.coordinates);
if (pts.length < 1000) throw new Error(`only ${pts.length} vertices in ${SRC} — wrong file?`);

// Monotone-chain convex hull.
pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const lo = []; const up = [];
for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
for (const p of pts.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
const hull = lo.slice(0, -1).concat(up.slice(0, -1));

// Grow each vertex away from the centroid. A convex polygon pushed outward
// radially stays convex and contains the original with at least ~MARGIN to spare
// along every edge that matters here (Nigeria is roughly round).
const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
const ring = hull.map(([x, y]) => {
  const dx = x - cx; const dy = y - cy; const d = Math.hypot(dx, dy);
  return [+(x + (dx / d) * MARGIN).toFixed(4), +(y + (dy / d) * MARGIN).toFixed(4)];
});
ring.push(ring[0]);

// Every ward vertex must be inside — a hull that clips Nigeria is worse than none.
const inside = ([x, y]) => ring.slice(0, -1).every((a, i) => cross(a, ring[i + 1], [x, y]) >= 0);
const outside = pts.filter((p) => !inside(p)).length;
if (outside) throw new Error(`${outside} ward vertices fall outside the region`);

fs.writeFileSync(OUT, `${JSON.stringify({ type: 'Polygon', coordinates: [ring] })}\n`);
const xs = ring.map((p) => p[0]); const ys = ring.map((p) => p[1]);
console.log(`${OUT}: ${ring.length - 1} vertices, bbox ${Math.min(...xs)},${Math.min(...ys)},${Math.max(...xs)},${Math.max(...ys)}; all ${pts.length} ward vertices inside`);
