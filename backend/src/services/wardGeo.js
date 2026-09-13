/* THE WARD LAYER, READ ONCE.
 *
 * Two routes want the same thing: the situation room's gated
 * /groups/:id/wards-geo, and the public /register/wards-geo a race page uses to
 * draw a ward's polling units. The index is 5.4 MB of GeoJSON folded into a map
 * on first use, so it is built here rather than twice.
 *
 * PUBLIC IS NOT A NEW EXPOSURE: app/nga_wards.geojson is served as a static
 * file already. The gate on the group route is about the group, not the
 * geometry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

let index = null;

/* THE LAYER SPELLS WARDS ITS OWN WAY, AND CALLERS DO NOT.
 *
 * Everything that asks for a ward — a map shape, a units lookup, a board row —
 * uses the INEC register's spelling. The polygon file has its own (OLOMU 3
 * EFFURUN OTOR where the register says EFFURUN OTOR), and data/ward_crosswalk
 * is the mapping between them. Applying it HERE means one place knows about the
 * two vocabularies instead of every caller re-deriving it — and a ward the
 * crosswalk cannot resolve keeps its own name rather than disappearing, because
 * the geometry is still correct even when the label is only the layer's.
 */
const up = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
let renames = null;
function renameMap() {
  if (renames) return renames;
  const m = new Map();
  try {
    const p = path.join(path.dirname(config.appDir), 'backend', 'src', 'data', 'ward_crosswalk.json');
    const { lgaAlias, wards } = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [regKey, pairs] of Object.entries(wards)) {
      const polyKey = lgaAlias[regKey] || regKey;
      for (const [regWard, polyWard] of Object.entries(pairs)) {
        m.set(polyKey + '|' + polyWard, regWard);
      }
    }
  } catch { /* no crosswalk: the layer's own names are still usable */ }
  renames = m;
  return renames;
}

function build() {
  if (index) return index;
  const geo = JSON.parse(fs.readFileSync(path.join(config.appDir, 'nga_wards.geojson'), 'utf8'));
  const names = renameMap();
  const idx = new Map();
  for (const f of geo.features) {
    const p = f.properties;
    const k = fold(p.s) + '|' + fold(p.l);
    if (!idx.has(k)) idx.set(k, []);
    const reg = names.get(up(p.s) + '|' + up(p.l) + '|' + up(p.w));
    idx.get(k).push({ ward: reg || p.w, wardRaw: p.w, geometry: f.geometry });
  }
  index = idx;
  return index;
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Every ward of one LGA, with geometry. Null when the layer cannot be read at
 * all — the caller answers 503 for that, which is a different thing from an LGA
 * the layer does not carry (an empty array).
 */
export function wardsForLga(state, lga) {
  let idx;
  try { idx = build(); } catch { return null; }
  const st = fold(state) + '|';
  const want = fold(lga);
  const hit = idx.get(st + want);
  if (hit) return hit;
  /* The register and the layer spell some LGAs a letter or two apart
     (Somolu/Shomolu): take the ONE same-state LGA within two edits. Two
     candidates means a guess, and a guess here draws the wrong LGA's wards. */
  const near = [...idx.keys()].filter((k) => k.startsWith(st) && editDistance(k.slice(st.length), want) <= 2);
  return near.length === 1 ? idx.get(near[0]) : [];
}
