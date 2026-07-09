import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS observers (
  id             INTEGER PRIMARY KEY,
  phone_hash     TEXT NOT NULL UNIQUE,
  public_key_jwk TEXT NOT NULL,
  reputation     REAL NOT NULL DEFAULT 1.0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  phone_hash TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- lat/lng are NULLABLE on purpose: INEC's official GPS database is not public,
-- so most register rows arrive without coordinates. Only units with verified
-- coordinates participate in geofenced discovery/submission; coords_source
-- records where each fix came from ('sample' = dev/demo only, not verified).
-- Telegram OTP channel: phone <-> chat bindings proven by Telegram contact-share,
-- and short-lived deep-link tokens for the linking flow.
CREATE TABLE IF NOT EXISTS telegram_links (
  phone_hash TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_link_tokens (
  token      TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  chat_id    INTEGER,           -- set once the user opens the bot with this token
  expires_at INTEGER NOT NULL
);

-- Pre-election crowd mapping: observers capture a GPS fix while standing at a
-- unit. When enough independent fixes cluster tightly, the median is promoted to
-- the unit's verified coordinate (coords_source='crowd_mapped'), making it
-- geofence-ready. One fix per observer per unit.
-- Opt-in race-follow notifications: observer subscribes to a contest (optionally a
-- single state; '' = all). On each new accepted report matching it, the bot pings
-- their linked Telegram chat.
CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY,
  observer_id INTEGER NOT NULL REFERENCES observers(id),
  contest     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE (observer_id, contest, state)
);

CREATE TABLE IF NOT EXISTS pu_mappings (
  id          INTEGER PRIMARY KEY,
  pu_code     TEXT NOT NULL REFERENCES polling_units(pu_code),
  observer_id INTEGER NOT NULL REFERENCES observers(id),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy    REAL,
  created_at  INTEGER NOT NULL,
  UNIQUE (pu_code, observer_id)
);

CREATE TABLE IF NOT EXISTS polling_units (
  pu_code           TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  ward              TEXT,
  lga               TEXT,
  state             TEXT,
  senatorial        TEXT,     -- senatorial district (from the INEC register)
  federal_constituency TEXT,  -- House of Reps constituency (from the INEC register)
  lat               REAL,
  lng               REAL,
  coords_source     TEXT,
  crowd_lat         REAL,     -- tier-2: median of clustered observer GPS fixes
  crowd_lng         REAL,     -- (never overwrites lat/lng — the verified layer)
  crowd_reports     INTEGER NOT NULL DEFAULT 0,
  approx_lat        REAL,     -- plausibility envelope from open data (GRID3
  approx_lng        REAL,     -- wards/schools) — flags claims, NEVER geofences
  approx_radius_m   REAL,
  approx_source     TEXT,     -- 'grid3_school' | 'ward_centroid'
  registered_voters INTEGER
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY,
  pu_code        TEXT NOT NULL REFERENCES polling_units(pu_code),
  observer_id    INTEGER NOT NULL REFERENCES observers(id),
  contest        TEXT NOT NULL DEFAULT 'PRES', -- which election at this unit (contests.json)
  votes_json     TEXT NOT NULL,           -- canonical sorted [{party,count}]
  image_sha256   TEXT NOT NULL UNIQUE,    -- result sheet photo: exact-duplicate guard
  image_dhash    TEXT NOT NULL,           -- ... perceptual near-duplicate guard
  image_path     TEXT NOT NULL,
  venue_image_sha256 TEXT NOT NULL UNIQUE, -- polling-unit surroundings photo
  venue_image_dhash  TEXT NOT NULL,
  venue_image_path   TEXT NOT NULL,
  venue_features     BLOB,                 -- serialized ORB keypoints+descriptors
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  sheet_lat      REAL,                    -- GPS fix at sheet-photo capture time
  sheet_lng      REAL,
  venue_lat      REAL,                    -- GPS fix at venue-photo capture time
  venue_lng      REAL,
  accuracy       REAL,
  location_verified INTEGER NOT NULL,     -- 1 = geofence-checked against verified coords
  location_plausible INTEGER,             -- tier-2 only: GPS inside the approx envelope?
  captured_at    INTEGER NOT NULL,
  venue_captured_at INTEGER NOT NULL,
  location_proof TEXT NOT NULL,           -- oracle attestation
  client_sig     TEXT NOT NULL,           -- observer's ECDSA signature
  ledger_payload TEXT NOT NULL,           -- exact string covered by entry_hash
  prev_hash      TEXT NOT NULL,
  entry_hash     TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  UNIQUE (pu_code, observer_id, contest)  -- one report per observer per unit per contest
);
CREATE INDEX IF NOT EXISTS idx_submissions_pu ON submissions(pu_code);

-- One row per compared venue-photo pair at a unit: did ORB confirm the two photos
-- show the same physical place? (services/scene.js)
CREATE TABLE IF NOT EXISTS venue_matches (
  id           INTEGER PRIMARY KEY,
  pu_code      TEXT NOT NULL REFERENCES polling_units(pu_code),
  submission_a INTEGER NOT NULL REFERENCES submissions(id),
  submission_b INTEGER NOT NULL REFERENCES submissions(id),
  good_matches INTEGER NOT NULL,
  inliers      INTEGER NOT NULL,
  confirmed    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_venue_matches_pu ON venue_matches(pu_code);

CREATE TABLE IF NOT EXISTS results (
  pu_code          TEXT NOT NULL REFERENCES polling_units(pu_code),
  contest          TEXT NOT NULL DEFAULT 'PRES',
  votes_json       TEXT NOT NULL,
  confidence       REAL NOT NULL,
  matching_reports INTEGER NOT NULL,
  total_reports    INTEGER NOT NULL,
  status           TEXT NOT NULL,
  location_status     TEXT NOT NULL DEFAULT 'unverified', -- verified | provisional | unverified
  location_confidence REAL,                               -- % of reports inside the GPS cluster
  location_plausibility TEXT,                             -- cluster vs approx envelope: consistent | inconsistent
  location_score      REAL,                               -- 0-100 fused location evidence
  venue_matches       INTEGER NOT NULL DEFAULT 0,         -- ORB-confirmed same-place photo pairs
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (pu_code, contest)
);
`);

// Additive migrations for databases created before these columns existed.
for (const ddl of [
  // "My polling unit": one saved unit per observer; drives Telegram alerts for
  // every result report / published incident at that unit.
  `CREATE TABLE IF NOT EXISTS saved_units (
     observer_id INTEGER PRIMARY KEY REFERENCES observers(id),
     pu_code     TEXT NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  // Command-bot chat sessions (multi-step flows like the /incident quick tip).
  `CREATE TABLE IF NOT EXISTS tg_sessions (
     chat_id    INTEGER PRIMARY KEY,
     flow       TEXT NOT NULL,
     step       TEXT NOT NULL,
     data_json  TEXT NOT NULL DEFAULT '{}',
     updated_at INTEGER NOT NULL
   )`,
  // External anchoring receipts (Sigstore Rekor public transparency log) — a log
  // we do not control, so a rolled-back DB can't reproduce these entries.
  'ALTER TABLE anchors ADD COLUMN rekor_uuid TEXT',
  'ALTER TABLE anchors ADD COLUMN rekor_log_index INTEGER',
  'ALTER TABLE anchors ADD COLUMN rekor_time INTEGER',
  'ALTER TABLE anchors ADD COLUMN rekor_artifact TEXT',
  'ALTER TABLE polling_units ADD COLUMN senatorial TEXT',
  'ALTER TABLE polling_units ADD COLUMN federal_constituency TEXT',
  'ALTER TABLE polling_units ADD COLUMN approx_lat REAL',
  'ALTER TABLE polling_units ADD COLUMN approx_lng REAL',
  'ALTER TABLE polling_units ADD COLUMN approx_radius_m REAL',
  'ALTER TABLE polling_units ADD COLUMN approx_source TEXT',
  'ALTER TABLE submissions ADD COLUMN location_plausible INTEGER',
  'ALTER TABLE submissions ADD COLUMN sheet_lat REAL',
  'ALTER TABLE submissions ADD COLUMN sheet_lng REAL',
  'ALTER TABLE submissions ADD COLUMN venue_lat REAL',
  'ALTER TABLE submissions ADD COLUMN venue_lng REAL',
  'ALTER TABLE submissions ADD COLUMN ocr_matched INTEGER',
  'ALTER TABLE submissions ADD COLUMN ocr_total INTEGER',
  'ALTER TABLE results ADD COLUMN location_plausibility TEXT',
  'ALTER TABLE results ADD COLUMN location_score REAL',
  // device fingerprint (client-computed, sha256): anti-sybil — logged everywhere,
  // enforced one-per-contest on submissions (a phone is at ONE polling unit).
  'ALTER TABLE observers ADD COLUMN device_id TEXT',
  'ALTER TABLE submissions ADD COLUMN device_id TEXT',
  'ALTER TABLE pu_mappings ADD COLUMN device_id TEXT',
  // Optional EC8A form serial number (observer-typed) — reused/duplicate serials
  // across different units are a forgery signal (integrity engine).
  'ALTER TABLE submissions ADD COLUMN sheet_serial TEXT',
  // Election-integrity engine: every automatically-detected anomaly is logged here
  // and surfaced on the public integrity dashboard. severity: low|medium|high.
  `CREATE TABLE IF NOT EXISTS discrepancies (
     id            INTEGER PRIMARY KEY,
     type          TEXT NOT NULL,
     severity      TEXT NOT NULL DEFAULT 'medium',
     pu_code       TEXT,
     contest       TEXT,
     state         TEXT,
     submission_id INTEGER,
     detail        TEXT,
     status        TEXT NOT NULL DEFAULT 'open',
     created_at    INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_disc_type ON discrepancies(type)',
  // De-dupe key so the same anomaly isn't logged twice on re-scan.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_uni ON discrepancies(type, pu_code, contest)',
  // Observer incident reports (violence, ballot snatching, etc.). Media files are
  // stored under uploads/incidents/. Published only after human review (status).
  `CREATE TABLE IF NOT EXISTS incidents (
     id          INTEGER PRIMARY KEY,
     observer_id INTEGER REFERENCES observers(id),
     kind        TEXT NOT NULL,
     description TEXT,
     media_json  TEXT NOT NULL DEFAULT '[]',
     lat         REAL,
     lng         REAL,
     pu_code     TEXT,
     state       TEXT,
     status      TEXT NOT NULL DEFAULT 'pending',
     created_at  INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status)',
  // Collation reports (EC8B ward / EC8C LGA / EC8D state): same evidence rigor as
  // PU submissions (two live photos, GPS stamps, client signature) on its OWN
  // hash chain. Reconciled against the sum of covered PU results underneath.
  `CREATE TABLE IF NOT EXISTS collation_reports (
     id            INTEGER PRIMARY KEY,
     observer_id   INTEGER NOT NULL REFERENCES observers(id),
     device_id     TEXT,
     contest       TEXT NOT NULL,
     level         TEXT NOT NULL,          -- ward | lga | state
     state         TEXT NOT NULL,
     lga           TEXT,
     ward          TEXT,
     votes_json    TEXT NOT NULL,
     form_serial   TEXT,
     image_sha256  TEXT NOT NULL UNIQUE,
     image_path    TEXT NOT NULL,
     venue_image_sha256 TEXT NOT NULL UNIQUE,
     venue_image_path   TEXT NOT NULL,
     lat           REAL, lng REAL, accuracy REAL,
     captured_at   INTEGER, venue_captured_at INTEGER,
     client_sig    TEXT NOT NULL,
     ledger_payload TEXT NOT NULL,
     prev_hash     TEXT NOT NULL,
     entry_hash    TEXT NOT NULL UNIQUE,
     created_at    INTEGER NOT NULL,
     UNIQUE (observer_id, contest, level, state, lga, ward)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_collation_scope ON collation_reports(contest, level, state, lga, ward)',
  'ALTER TABLE collation_reports ADD COLUMN ocr_matched INTEGER',
  'ALTER TABLE collation_reports ADD COLUMN ocr_total INTEGER',
  // OAuth tokens for social providers obtained via their auth flow (TikTok Login
  // Kit). Owner connects once; access/refresh tokens stored here, refreshed as needed.
  `CREATE TABLE IF NOT EXISTS social_tokens (
     provider          TEXT PRIMARY KEY,
     access_token      TEXT,
     refresh_token     TEXT,
     open_id           TEXT,
     scope             TEXT,
     expires_at        INTEGER,
     refresh_expires_at INTEGER,
     updated_at        INTEGER
   )`,
  // Daily ledger anchors: the chain heads published externally (tweeted) so not
  // even the server operator can rewrite history without contradiction.
  `CREATE TABLE IF NOT EXISTS anchors (
     id INTEGER PRIMARY KEY,
     day TEXT NOT NULL,
     head_hash TEXT NOT NULL,
     collation_head TEXT NOT NULL,
     entries INTEGER NOT NULL,
     collation_entries INTEGER NOT NULL,
     tweet TEXT,
     races_root TEXT,          -- Merkle root over every per-race subchain head this cycle
     races_count INTEGER,      -- number of distinct races batched under races_root
     created_at INTEGER NOT NULL
   )`,
  // Per-race subchains batched under an anchor's Merkle root. One row per race
  // (contest+scope) — stores its subchain head plus the Merkle inclusion proof
  // that ties that head to races_root (which is what Rekor timestamps). Lets a
  // single disputed race be verified in isolation without replaying the whole
  // ledger. See services/merkle.js + services/anchor.js.
  `CREATE TABLE IF NOT EXISTS anchor_races (
     anchor_id  INTEGER NOT NULL,
     race_key   TEXT NOT NULL,     -- e.g. PRES | GOV|Kano | SEN|Kano|Kano Central
     race_head  TEXT NOT NULL,     -- head of this race's subchain
     entries    INTEGER NOT NULL,  -- submissions folded into race_head
     leaf_index INTEGER NOT NULL,  -- position of this race's leaf in the Merkle tree
     leaf_hash  TEXT NOT NULL,
     proof_json TEXT NOT NULL,     -- [{hash,side}] audit path up to races_root
     PRIMARY KEY (anchor_id, race_key)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_anchor_races_key ON anchor_races(race_key)',
  // Existing DBs: add the Merkle columns to a pre-existing anchors table.
  'ALTER TABLE anchors ADD COLUMN races_root TEXT',
  'ALTER TABLE anchors ADD COLUMN races_count INTEGER',
  // AI triage suggestion for the human reviewer (advisory only, never auto-acts).
  'ALTER TABLE incidents ADD COLUMN ai_json TEXT',
  // Vision read of the EC8A sheet: {authentic, reason, counts} — advisory audit.
  'ALTER TABLE submissions ADD COLUMN vision_json TEXT',
  // IReV cross-check: INEC's own uploaded EC8A per unit — doc URL found by walking
  // the IReV API, then OCR'd and compared against the crowd-reported counts.
  `CREATE TABLE IF NOT EXISTS irev_docs (
     pu_code     TEXT NOT NULL,
     election_id TEXT NOT NULL,
     doc_url     TEXT,
     ocr_matched INTEGER,
     ocr_total   INTEGER,
     status      TEXT NOT NULL DEFAULT 'pending',
     checked_at  INTEGER,
     PRIMARY KEY (pu_code, election_id)
   )`,
  // FCT is an acronym — repair rows title-cased to "Fct" before the loader fix.
  "UPDATE polling_units SET state = 'FCT' WHERE state = 'Fct'",
  "UPDATE polling_units SET senatorial = REPLACE(senatorial, 'Fct', 'FCT') WHERE senatorial LIKE '%Fct%'",
  "UPDATE polling_units SET federal_constituency = REPLACE(federal_constituency, 'Fct', 'FCT') WHERE federal_constituency LIKE '%Fct%'",
  "UPDATE polling_units SET ward = REPLACE(ward, 'Fct', 'FCT') WHERE ward LIKE '%Fct%'",
  "UPDATE polling_units SET name = REPLACE(name, 'Fct', 'FCT') WHERE name LIKE '%Fct%'",
]) {
  try {
    db.exec(ddl);
  } catch {
    /* column already exists */
  }
}

// Seed a handful of REAL Lagos Island polling units (official register codes/names)
// with demo coordinates on first boot, so the app works out of the box.
// Load the full register with scripts/load_inec_register.js --replace, then attach
// verified coordinates with scripts/attach_coordinates.js.
const puCount = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;
if (puCount === 0) {
  const sample = JSON.parse(
    fs.readFileSync(path.join(config.dataDir, 'polling_units.sample.json'), 'utf8'),
  );
  const insert = db.prepare(`
    INSERT INTO polling_units (pu_code, name, ward, lga, state, lat, lng, coords_source, registered_voters)
    VALUES (@pu_code, @name, @ward, @lga, @state, @lat, @lng, 'sample', @registered_voters)`);
  db.transaction((rows) => rows.forEach((r) => insert.run(r)))(sample);
}

export const parties = JSON.parse(
  fs.readFileSync(path.join(config.dataDir, 'parties.json'), 'utf8'),
);
export const partyCodes = new Set(parties.map((p) => p.code));

// Contests on the ballot. Update from INEC's election timetable — and per-contest
// candidate lists once parties formally announce them.
export const contests = JSON.parse(
  fs.readFileSync(path.join(config.dataDir, 'contests.json'), 'utf8'),
);
export const contestCodes = new Set(contests.map((c) => c.code));
