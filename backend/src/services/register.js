import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { config } from '../config.js';

const titleCase = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bFct\b/g, 'FCT'); // acronym, never "Fct"

// Stream-load the official INEC register scrape (see scripts/load_inec_register.js
// for provenance and column format). Upserts on pu_code; never touches lat/lng.
export async function loadRegisterCsv(db, file) {
  const parser = fs.createReadStream(file).pipe(
    parse({ columns: true, relax_quotes: true, relax_column_count: true, trim: true }),
  );
  const units = new Map();
  let parsed = 0;
  let skipped = 0;
  for await (const row of parser) {
    parsed++;
    const rawCode = (row.code || '').trim();
    if (!/^\d{2}\/\d{2}\/\d{2}\/\d{3}$/.test(rawCode)) {
      skipped++;
      continue;
    }
    units.set(rawCode.replaceAll('/', '-'), {
      pu_code: rawCode.replaceAll('/', '-'),
      name: titleCase(row.location) || 'Unnamed Polling Unit',
      ward: titleCase(row.ward),
      lga: titleCase(row.lg),
      state: titleCase(row.state),
      senatorial: titleCase(row.senatorial) || null,
      federal_constituency: titleCase(row.house_of_rep) || null,
    });
  }
  const insert = db.prepare(`
    INSERT INTO polling_units (pu_code, name, ward, lga, state, senatorial, federal_constituency, lat, lng, coords_source, registered_voters)
    VALUES (@pu_code, @name, @ward, @lga, @state, @senatorial, @federal_constituency, NULL, NULL, NULL, NULL)
    ON CONFLICT(pu_code) DO UPDATE SET
      name = excluded.name, ward = excluded.ward, lga = excluded.lga, state = excluded.state,
      senatorial = excluded.senatorial, federal_constituency = excluded.federal_constituency`);
  db.transaction(() => {
    for (const u of units.values()) insert.run(u);
  })();
  return { parsed, skipped, unique: units.size };
}

// Attach vetted coordinates (pu_code,lat,lng[,source]) — geofence-enabling data.
export function attachCoordinatesCsv(db, file, defaultSource = 'unspecified') {
  const inNigeria = (lat, lng) => lat >= 4 && lat <= 14 && lng >= 2.5 && lng <= 15;
  const rows = parseSync(fs.readFileSync(file, 'utf8'), { columns: true, trim: true });
  const update = db.prepare(
    'UPDATE polling_units SET lat = ?, lng = ?, coords_source = ? WHERE pu_code = ?',
  );
  let attached = 0;
  let unmatched = 0;
  let invalid = 0;
  db.transaction(() => {
    for (const r of rows) {
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inNigeria(lat, lng)) {
        invalid++;
        continue;
      }
      const res = update.run(lat, lng, r.source || defaultSource, (r.pu_code || '').trim());
      if (res.changes === 0) unmatched++;
      else attached++;
    }
  })();
  return { attached, unmatched, invalid };
}

// Attach approximate locations (plausibility envelopes, NOT geofence data) built
// by scripts/build_approx_locations.js: pu_code,lat,lng,radius_m,source,score
export function loadApproxCsv(db, file) {
  const rows = parseSync(fs.readFileSync(file, 'utf8'), { columns: true, trim: true });
  const update = db.prepare(
    'UPDATE polling_units SET approx_lat = ?, approx_lng = ?, approx_radius_m = ?, approx_source = ? WHERE pu_code = ?',
  );
  let attached = 0;
  db.transaction(() => {
    for (const r of rows) {
      attached += update.run(Number(r.lat), Number(r.lng), Number(r.radius_m), r.source, r.pu_code).changes;
    }
  })();
  return attached;
}

// Overwrite each unit's senatorial district + federal constituency with the clean,
// authoritative names (data/district_index.json, keyed by LGA) so results bind to
// the map and observer scope labels are correct — replaces the register's typo'd
// fields (e.g. "Deltal North" -> "Delta North"). Idempotent; ~774 LGA updates.
const DISTRICT_NAMES_VERSION = 2;
export function applyDistrictNames(db) {
  const file = path.join(config.dataDir, 'district_index.json');
  if (!fs.existsSync(file)) return 0;
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const norm = (s) => { const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); return /fct|federal capital|abuja/.test(n) ? 'fct' : n; };
  const lgas = db.prepare('SELECT DISTINCT state, lga FROM polling_units').all();
  const upd = db.prepare('UPDATE polling_units SET senatorial = ?, federal_constituency = ? WHERE state = ? AND lga = ?');
  let n = 0;
  db.transaction(() => {
    for (const { state, lga } of lgas) {
      const m = idx[`${norm(state)}|${norm(lga)}`];
      if (m) { upd.run(m.senatorial, m.federal, state, lga); n++; }
    }
  })();
  return n;
}

// Seed a provisional "geocoded" coordinate for units whose name matched a precise
// GRID3 POI (school/market/church/health/govt, ~600 m). Stored in the crowd slot
// so it behaves exactly like a crowd-located unit — geofence-eligible for discovery,
// reports stay provisional, and a live observer cluster upgrades it to verified.
// Never touches units that already have a verified or crowd coordinate.
const GEOCODE_VERSION = 3;
export function seedGeocodedFromApprox(db) {
  const r = db.prepare(`
    UPDATE polling_units
       SET crowd_lat = approx_lat, crowd_lng = approx_lng, coords_source = 'geocoded'
     WHERE lat IS NULL AND crowd_lat IS NULL AND approx_lat IS NOT NULL
       AND approx_source IN ('grid3_school','grid3_market','grid3_church','grid3_health','grid3_govt')`).run();
  return r.changes;
}

// Apply any storage/raw/geocoded_<State>.csv (pu_code,lat,lng from the Nominatim
// name-search) as provisional 'geocoded' coordinates — only where the unit still
// has no coordinate. Idempotent; runs each boot so newly-uploaded state files land.
export function loadGeocodedCsvs(db) {
  const dir = path.dirname(config.registerCsvPath);
  if (!fs.existsSync(dir)) return 0;
  const upd = db.prepare(
    "UPDATE polling_units SET crowd_lat = ?, crowd_lng = ?, coords_source = 'geocoded' WHERE pu_code = ? AND lat IS NULL AND crowd_lat IS NULL",
  );
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((f) => /^geocoded_.+\.csv$/.test(f))) {
    for (const row of parseSync(fs.readFileSync(path.join(dir, f), 'utf8'), { columns: true, trim: true })) {
      const lat = Number(row.lat), lng = Number(row.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) n += upd.run(lat, lng, row.pu_code).changes;
    }
  }
  return n;
}

// First-boot self-setup for hosts without shell access (e.g. DirectAdmin/Passenger):
// if the register CSV is present and the table is obviously incomplete, load it;
// if nothing is geocoded, attach the bundled demo coordinates.
export async function bootstrapData(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;
  // Reload when the table is thin OR predates the constituency columns.
  const withSen = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE senatorial IS NOT NULL').get().c;
  if ((count < 100000 || withSen === 0) && fs.existsSync(config.registerCsvPath)) {
    console.log('[bootstrap] loading INEC register…');
    const r = await loadRegisterCsv(db, config.registerCsvPath);
    console.log(`[bootstrap] register loaded: ${r.unique} units (${r.skipped} rows skipped)`);
  }
  const geocoded = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NOT NULL').get().c;
  if (geocoded === 0) {
    const sample = path.join(config.dataDir, 'sample_coordinates.csv');
    if (fs.existsSync(sample)) {
      const a = attachCoordinatesCsv(db, sample, 'sample');
      console.log(`[bootstrap] attached ${a.attached} demo coordinates`);
    }
  }
  const approx = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE approx_lat IS NOT NULL').get().c;
  if (approx === 0 && fs.existsSync(config.approxCsvPath)) {
    const n = loadApproxCsv(db, config.approxCsvPath);
    console.log(`[bootstrap] loaded ${n} approximate locations`);
  }
  if (db.pragma('user_version', { simple: true }) < DISTRICT_NAMES_VERSION) {
    const n = applyDistrictNames(db);
    db.pragma(`user_version = ${DISTRICT_NAMES_VERSION}`);
    console.log(`[bootstrap] applied clean district names to ${n} LGAs`);
  }
  if (db.pragma('user_version', { simple: true }) < GEOCODE_VERSION) {
    const n = seedGeocodedFromApprox(db);
    db.pragma(`user_version = ${GEOCODE_VERSION}`);
    console.log(`[bootstrap] seeded ${n} geocoded (provisional) coordinates from POI matches`);
  }
  const g = loadGeocodedCsvs(db);
  if (g) console.log(`[bootstrap] applied ${g} name-search geocoded coordinates`);
}
