// Fetch the open GRID3 layers that power approximate polling-unit locations:
//   - ward centroids + radii (Operational Wards v2.0, gap-filled with v1.0)
//   - school points (most polling units are at schools)
// Saves compact JSON to storage/raw/. Free data, no API key.
//
//   node scripts/fetch_grid3_data.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rawDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const WARDS_V2 = 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/main_GRID3_NGA_operational_wards_v2_0/FeatureServer/0';
const WARDS_V1 = 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/NGA_Ward_Boundaries/FeatureServer/0';
const SCHOOLS = 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/Schools_in_Nigeria/FeatureServer/0';

async function queryAll(base, outFields, { centroid = false, geometry = false } = {}) {
  const out = [];
  for (let offset = 0; ; offset += 2000) {
    const p = new URLSearchParams({
      where: '1=1',
      outFields,
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: '2000',
      returnGeometry: geometry ? 'true' : 'false',
    });
    if (centroid) p.set('returnCentroid', 'true');
    if (geometry) p.set('maxAllowableOffset', '0.02'); // heavy simplification — centroids only
    const res = await fetch(`${base}/query?${p}`);
    const d = await res.json();
    if (d.error) throw new Error(JSON.stringify(d.error));
    out.push(...(d.features || []));
    process.stdout.write(`\r  ${base.split('/services/')[1].split('/')[0]}: ${out.length}`);
    if (!d.exceededTransferLimit && (d.features || []).length < 2000) break;
  }
  console.log();
  return out;
}

const pick = (attrs, names) => {
  for (const n of names) if (attrs[n] != null && attrs[n] !== '') return attrs[n];
  return null;
};

function ringCentroid(geom) {
  const ring = geom?.rings?.[0];
  if (!ring || ring.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return { x: x / ring.length, y: y / ring.length };
}

async function fetchWards(base, src) {
  const fields = '*'; // field names differ between v1/v2 — pick client-side
  let feats = await queryAll(base, fields, { centroid: true });
  const needGeom = feats.length > 0 && !feats[0].centroid;
  if (needGeom) feats = await queryAll(base, fields, { geometry: true });
  const wards = [];
  for (const f of feats) {
    const a = f.attributes || {};
    const c = f.centroid || ringCentroid(f.geometry);
    if (!c) continue;
    let areaSqkm = Number(pick(a, ['area_sqkm']));
    if (!Number.isFinite(areaSqkm) || areaSqkm <= 0) {
      const shp = Number(pick(a, ['Shape__Area'])); // square degrees (EPSG:4326)
      areaSqkm = Number.isFinite(shp)
        ? shp * 111.32 * 111.32 * Math.cos((c.y * Math.PI) / 180)
        : 25;
    }
    wards.push({
      state: pick(a, ['state', 'statename']),
      lga: pick(a, ['lga', 'lganame']),
      ward: pick(a, ['ward', 'wardname']),
      lat: c.y,
      lng: c.x,
      radiusM: Math.round(Math.sqrt(areaSqkm / Math.PI) * 1000),
      src,
    });
  }
  return wards;
}

if (!fs.existsSync(path.join(rawDir, 'grid3_wards.json'))) {
  console.log('wards v2.0:');
  const v2 = await fetchWards(WARDS_V2, 'v2');
  console.log('wards v1.0:');
  const v1 = await fetchWards(WARDS_V1, 'v1');
  fs.writeFileSync(path.join(rawDir, 'grid3_wards.json'), JSON.stringify([...v2, ...v1]));
  console.log(`saved ${v2.length} v2 + ${v1.length} v1 wards`);
} else console.log('grid3_wards.json exists — skipping');

if (!fs.existsSync(path.join(rawDir, 'grid3_schools.json'))) {
  console.log('schools:');
  const schoolFeats = await queryAll(SCHOOLS, '*', { geometry: true });
  const schools = schoolFeats
    .filter((f) => f.geometry && (f.attributes?.name || '').trim())
    .map((f) => ({
      name: f.attributes.name,
      ward: f.attributes.wardname,
      lga: f.attributes.lganame,
      state: f.attributes.statename,
      lat: f.geometry.y,
      lng: f.geometry.x,
    }));
  fs.writeFileSync(path.join(rawDir, 'grid3_schools.json'), JSON.stringify(schools));
  console.log(`saved ${schools.length} schools`);
} else console.log('grid3_schools.json exists — skipping');

// Non-school landmark layers — polling units are also named after these.
const POI_LAYERS = [
  ['market', 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/Markets_in_Nigeria/FeatureServer/0'],
  ['church', 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/Churches_in_Nigeria/FeatureServer/0'],
  ['govt', 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/GRID3_NGA_Government_Buildings/FeatureServer/0'],
  ['police', 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/GRID3_NGA_Police_Stations/FeatureServer/0'],
  ['health', 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/GRID3_NGA_health_facilities_v2_0/FeatureServer/0'],
  ['settlement', 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/Settlements_in_Nigeria/FeatureServer/0'],
];

if (!fs.existsSync(path.join(rawDir, 'grid3_pois.json'))) {
  const pois = [];
  for (const [type, url] of POI_LAYERS) {
    console.log(`${type}:`);
    const feats = await queryAll(url, '*', { geometry: true });
    for (const f of feats) {
      const a = f.attributes || {};
      const name = pick(a, [
        'name', 'prim_name', 'poi_name', 'facility_name', 'primary_name',
        'market_nam', 'plc_st_nam', 'set_name', // shapefile-truncated GRID3 fields
      ]);
      if (!f.geometry || !String(name || '').trim()) continue;
      pois.push({
        type,
        name,
        lga: pick(a, ['lganame', 'lga_name', 'lga']),
        state: pick(a, ['statename', 'state_name', 'state']),
        lat: f.geometry.y,
        lng: f.geometry.x,
      });
    }
  }
  fs.writeFileSync(path.join(rawDir, 'grid3_pois.json'), JSON.stringify(pois));
  console.log(`saved ${pois.length} landmark POIs`);
} else console.log('grid3_pois.json exists — skipping');
