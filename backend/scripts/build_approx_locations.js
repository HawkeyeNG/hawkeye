// Build APPROXIMATE locations for polling units from open GRID3 data:
//   1. ward anchoring  — match INEC (state, lga, ward) to GRID3 ward centroids
//                        (v2.0 preferred, v1.0 gap-fill); radius from ward area
//   2. school matching — PUs named after schools fuzzy-matched against GRID3
//                        school points within the same (state, lga)
//
// These are NOT geofence coordinates. They form a plausibility envelope used to
// flag tier-2 GPS claims and sanity-check crowd clusters (see README). Writes
// straight into the DB and to storage/raw/approx_locations.csv for deployment.
//
//   node scripts/fetch_grid3_data.js       # first
//   node scripts/build_approx_locations.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';
import { haversineM } from '../src/services/geo.js';

const rawDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'raw');
const wardsAll = JSON.parse(fs.readFileSync(path.join(rawDir, 'grid3_wards.json'), 'utf8'));
const schools = JSON.parse(fs.readFileSync(path.join(rawDir, 'grid3_schools.json'), 'utf8'));

// --- text similarity ---------------------------------------------------------
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ward|of|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function bigramSet(s) {
  const t = `_${s.replace(/ /g, '_')}_`;
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
function diceSets(A, B) {
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}
const dice = (a, b) => diceSets(bigramSet(norm(a)), bigramSet(norm(b)));

const canonState = (s) => {
  const n = norm(s);
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
};

// --- index GRID3 wards: state -> lga -> [wards] -------------------------------
const wardIndex = new Map();
for (const w of wardsAll) {
  if (!w.state || !w.lga || !w.ward) continue;
  const st = canonState(w.state);
  if (!wardIndex.has(st)) wardIndex.set(st, new Map());
  const lgas = wardIndex.get(st);
  const lgaKey = norm(w.lga);
  if (!lgas.has(lgaKey)) lgas.set(lgaKey, []);
  lgas.get(lgaKey).push(w);
}

// --- index schools: state -> lgaKey -> [schools with cached bigrams] ----------
const schoolIndex = new Map();
for (const s of schools) {
  const st = canonState(s.state);
  if (!schoolIndex.has(st)) schoolIndex.set(st, new Map());
  const lgas = schoolIndex.get(st);
  const lgaKey = norm(s.lga);
  if (!lgas.has(lgaKey)) lgas.set(lgaKey, []);
  lgas.get(lgaKey).push({ ...s, bg: bigramSet(norm(s.name)) });
}

// --- index landmark POIs: state -> lgaKey -> type -> [pois with cached bigrams] --
const pois = JSON.parse(fs.readFileSync(path.join(rawDir, 'grid3_pois.json'), 'utf8'));
const poiIndex = new Map();
for (const p of pois) {
  const st = canonState(p.state);
  if (!poiIndex.has(st)) poiIndex.set(st, new Map());
  const lgas = poiIndex.get(st);
  const lgaKey = norm(p.lga);
  if (!lgas.has(lgaKey)) lgas.set(lgaKey, new Map());
  const types = lgas.get(lgaKey);
  if (!types.has(p.type)) types.set(p.type, []);
  types.get(p.type).push({ lat: p.lat, lng: p.lng, bg: bigramSet(norm(p.name)) });
}

// PU-name keywords -> POI layer to search (checked only when no school matched)
const LANDMARK_CLASSES = [
  [/\b(market|mkt)\b/, 'market'],
  [/\b(church|cathedral|chapel|parish|anglican|methodist|catholic|baptist|celestial|apostolic|assembly|winners|redeemed|ecwa|cocin|cac)\b/, 'church'],
  [/\b(health|hospital|clinic|dispensary|maternity|phc|medical)\b/, 'health'],
  [/\b(town hall|village hall|community hall|civic centre|civic center|council|secretariat|court|customary|local government)\b/, 'govt'],
  [/\bpolice\b/, 'police'],
];

// fuzzy LGA resolution with cache: INEC lga name -> key in a given index
function resolveLga(index, st, lgaName, cache) {
  const key = `${st}|${lgaName}`;
  if (cache.has(key)) return cache.get(key);
  const lgas = index.get(st);
  let best = null;
  if (lgas) {
    const target = norm(lgaName);
    if (lgas.has(target)) best = target;
    else {
      let bestScore = 0.55;
      for (const k of lgas.keys()) {
        const sc = dice(target, k);
        if (sc > bestScore) {
          bestScore = sc;
          best = k;
        }
      }
    }
  }
  cache.set(key, best);
  return best;
}

// --- 1. ward anchors for every distinct register (state, lga, ward) -----------
const pus = db.prepare('SELECT pu_code, name, ward, lga, state FROM polling_units').all();
const wardLgaCache = new Map();
const wardAnchor = new Map(); // "st|lga|ward" -> {lat,lng,radiusM,score}
for (const pu of pus) {
  const st = canonState(pu.state);
  const key = `${st}|${norm(pu.lga)}|${norm(pu.ward)}`;
  if (wardAnchor.has(key)) continue;
  const lgaKey = resolveLga(wardIndex, st, pu.lga, wardLgaCache);
  if (!lgaKey) {
    wardAnchor.set(key, null);
    continue;
  }
  // INEC ward names like "olowogbowo/elegbata" — match whole and each part
  const variants = [pu.ward, ...String(pu.ward).split('/')].map(norm).filter(Boolean);
  let best = null;
  let bestScore = 0.45;
  for (const w of wardIndex.get(st).get(lgaKey)) {
    for (const v of variants) {
      const sc = dice(v, w.ward) + (w.src === 'v2' ? 0.03 : 0);
      if (sc > bestScore) {
        bestScore = sc;
        best = w;
      }
    }
  }
  wardAnchor.set(key, best ? { lat: best.lat, lng: best.lng, radiusM: best.radiusM, score: bestScore } : null);
}

// --- 2. school matching for school-named PUs ----------------------------------
const SCHOOLISH = /\b(sch|schl|school|pri|prm|primary|secondary|sec|college|academy|islamiy|lgea|grammar|comprehensive|nursery|community)\b/;
const cleanPuName = (name) =>
  norm(name)
    .replace(/\b(in front of|front of|open space at|open space|beside|near|opposite|opp|by|at)\b/g, ' ')
    .replace(/\b[ivx]{1,4}\b\s*$/g, '') // trailing roman numerals (…School II)
    .replace(/\s+/g, ' ')
    .trim();

const schoolLgaCache = new Map();
const poiLgaCache = new Map();
const updates = [];
let schoolHits = 0;
let landmarkHits = 0;
let settlementHits = 0;
let wardHits = 0;

// best fuzzy candidate from a cached-bigram list, with ward-envelope guard
function bestNear(cands, puBg, anchor, minScore) {
  let best = null;
  let bestScore = minScore;
  for (const c of cands) {
    const sc = diceSets(puBg, c.bg);
    if (sc > bestScore) {
      bestScore = sc;
      best = c;
    }
  }
  if (
    best &&
    (!anchor || haversineM(best.lat, best.lng, anchor.lat, anchor.lng) <= Math.max(anchor.radiusM * 2, 5000))
  ) {
    return { ...best, score: bestScore };
  }
  return null;
}
for (const pu of pus) {
  const st = canonState(pu.state);
  const anchor = wardAnchor.get(`${st}|${norm(pu.lga)}|${norm(pu.ward)}`);
  let approx = null;

  const cleaned = cleanPuName(pu.name);
  if (SCHOOLISH.test(cleaned)) {
    const lgaKey = resolveLga(schoolIndex, st, pu.lga, schoolLgaCache);
    if (lgaKey) {
      const puBg = bigramSet(cleaned);
      let best = null;
      let bestScore = 0.6;
      for (const s of schoolIndex.get(st).get(lgaKey)) {
        const sc = diceSets(puBg, s.bg);
        if (sc > bestScore) {
          bestScore = sc;
          best = s;
        }
      }
      // guard against name collisions across the LGA: stay near the ward anchor
      if (
        best &&
        (!anchor || haversineM(best.lat, best.lng, anchor.lat, anchor.lng) <= Math.max(anchor.radiusM * 2, 5000))
      ) {
        approx = { lat: best.lat, lng: best.lng, radiusM: 600, source: 'grid3_school', score: bestScore };
        schoolHits++;
      }
    }
  }

  // typed landmarks: markets, churches, health facilities, halls/courts, police
  if (!approx) {
    const type = LANDMARK_CLASSES.find(([re]) => re.test(cleaned))?.[1];
    if (type) {
      const lgaKey = resolveLga(poiIndex, st, pu.lga, poiLgaCache);
      const cands = lgaKey ? poiIndex.get(st).get(lgaKey).get(type) : null;
      if (cands) {
        const hit = bestNear(cands, bigramSet(cleaned), anchor, 0.6);
        if (hit) {
          approx = { lat: hit.lat, lng: hit.lng, radiusM: 600, source: `grid3_${type}`, score: hit.score };
          landmarkHits++;
        }
      }
    }
  }

  // settlement fallback: village open-space units named after the settlement itself.
  // Ward anchor REQUIRED — same-named villages recur across an LGA.
  if (!approx && anchor) {
    const lgaKey = resolveLga(poiIndex, st, pu.lga, poiLgaCache);
    const cands = lgaKey ? poiIndex.get(st).get(lgaKey).get('settlement') : null;
    if (cands) {
      const hit = bestNear(cands, bigramSet(cleaned), anchor, 0.65);
      if (hit) {
        approx = { lat: hit.lat, lng: hit.lng, radiusM: 900, source: 'grid3_settlement', score: hit.score };
        settlementHits++;
      }
    }
  }

  if (!approx && anchor) {
    approx = {
      lat: anchor.lat,
      lng: anchor.lng,
      radiusM: Math.min(Math.max(anchor.radiusM, 800), 20000),
      source: 'ward_centroid',
      score: anchor.score,
    };
    wardHits++;
  }
  if (approx) updates.push({ pu_code: pu.pu_code, ...approx });
}

// --- write DB + CSV ------------------------------------------------------------
const up = db.prepare(
  'UPDATE polling_units SET approx_lat = ?, approx_lng = ?, approx_radius_m = ?, approx_source = ? WHERE pu_code = ?',
);
db.transaction(() => {
  for (const u of updates) up.run(u.lat, u.lng, u.radiusM, u.source, u.pu_code);
})();

const csv = ['pu_code,lat,lng,radius_m,source,score']
  .concat(updates.map((u) => `${u.pu_code},${u.lat.toFixed(6)},${u.lng.toFixed(6)},${Math.round(u.radiusM)},${u.source},${u.score.toFixed(2)}`))
  .join('\n');
fs.writeFileSync(path.join(rawDir, 'approx_locations.csv'), csv);

const wardMatched = [...wardAnchor.values()].filter(Boolean).length;
console.log(`ward anchors: ${wardMatched}/${wardAnchor.size} register wards matched (${((wardMatched / wardAnchor.size) * 100).toFixed(1)}%)`);
console.log(
  `approximate locations: ${updates.length}/${pus.length} PUs ` +
    `(${schoolHits} school @600m, ${landmarkHits} landmark @600m, ${settlementHits} settlement @900m, ${wardHits} ward-centroid)`,
);
console.log('written to DB + storage/raw/approx_locations.csv');
