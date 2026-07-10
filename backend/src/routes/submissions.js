import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { db, partyCodes, contestCodes } from '../db.js';
import { config } from '../config.js';
import { haversineM, makeLocationProof } from '../services/geo.js';
import { sha256Hex, dhashHex, hammingDistance } from '../services/images.js';
import { canonicalPayload, canonicalVotes, verifyObserverSignature } from '../services/signatures.js';
import { nextEntry, verifyChain } from '../services/ledger.js';
import { recomputeResult } from '../services/aggregate.js';
import { extractFeatures, matchFeatures } from '../services/scene.js';
import { requireObserver } from './observers.js';
import { contestScope, contestApplies } from '../services/scope.js';
import { notifySubscribers } from './subscriptions.js';
import { notifyChat, notifyMaster, chatIdByHash, notifyUnitSavers } from '../services/notify.js';
import { checkSubmission, checkResult } from '../services/integrity.js';
import { ocrMatchCounts } from '../services/ocr.js';
import { anchorPublicKey } from '../services/anchor.js';

export const submissionsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
});
const photoFields = upload.fields([
  { name: 'photo', maxCount: 1 },      // the EC8A result sheet
  { name: 'venuePhoto', maxCount: 1 }, // the polling unit / building / surroundings
]);

const isFresh = (ts, now) =>
  Number.isFinite(ts) && ts <= now + 120_000 && now - ts <= config.photoMaxAgeS * 1000;

submissionsRouter.post('/submissions', requireObserver, photoFields, async (req, res) => {
  try {
    const { puCode, votes: votesRaw, signature } = req.body;
    // No PRES default — an omitted contest must be rejected, not silently booked
    // as presidential (matches the client's mandatory "Select election" choice).
    const contest = String(req.body.contest || '');
    if (!contestCodes.has(contest)) return res.status(400).json({ error: 'unknown_contest' });
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const accuracy = Number(req.body.accuracy);
    const capturedAt = Number(req.body.capturedAt);
    const venueCapturedAt = Number(req.body.venueCapturedAt);
    const sheetLat = Number(req.body.sheetLat);
    const sheetLng = Number(req.body.sheetLng);
    const venueLat = Number(req.body.venueLat);
    const venueLng = Number(req.body.venueLng);

    // Device fingerprint (anti-sybil): one physical device can only be at one
    // polling unit, so each device fingerprint reports each race at most once —
    // across ALL observer accounts (multi-SIM registration doesn't buy extra votes).
    const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64);
    if (!/^[0-9a-f]{64}$/.test(deviceId)) {
      return res.status(400).json({ error: 'device_required', hint: 'update the app (reload the page) and retry' });
    }
    const devicePrior = db.prepare(
      'SELECT observer_id, pu_code FROM submissions WHERE device_id = ? AND contest = ?',
    ).get(deviceId, contest);
    if (devicePrior) {
      const sameReport = devicePrior.observer_id === req.observer.id && devicePrior.pu_code === puCode;
      return res.status(409).json({ error: sameReport ? 'already_submitted' : 'device_already_reported_race' });
    }
    // Minimum spacing targets account-hopping on one device; an observer filing
    // their own multiple contests back-to-back is legitimate and not throttled.
    const deviceLast = db.prepare(
      'SELECT MAX(created_at) AS t FROM submissions WHERE device_id = ? AND observer_id != ?',
    ).get(deviceId, req.observer.id);
    if (deviceLast?.t && Date.now() - deviceLast.t < config.minDeviceSubmitSpacingMs) {
      return res.status(429).json({
        error: 'device_too_fast',
        retryAfterS: Math.ceil((config.minDeviceSubmitSpacingMs - (Date.now() - deviceLast.t)) / 1000),
      });
    }

    const pu = db.prepare('SELECT * FROM polling_units WHERE pu_code = ?').get(puCode);
    if (!pu) return res.status(404).json({ error: 'unknown_polling_unit' });
    if (!contestApplies(pu, contest)) {
      return res.status(400).json({ error: 'contest_not_applicable' });
    }

    // 1. Location. Verified-coordinate units get the hard geofence; units without
    //    verified coordinates accept the report but record the GPS as a CLAIM —
    //    it feeds the crowd cluster and the result stays visibly capped until the
    //    cluster corroborates it (services/aggregate.js).
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'gps_required' });
    }
    if (!Number.isFinite(accuracy) || accuracy > config.maxGpsAccuracyM) {
      return res.status(400).json({ error: 'gps_accuracy_too_low', maxAccuracyM: config.maxGpsAccuracyM });
    }
    // Photo-location coherence: each photo was GPS-stamped at CAPTURE time and
    // signed. All three fixes must agree, so a photo taken anywhere else within
    // the freshness window cannot back this submission — and via the submission
    // fix, both photos are transitively checked against the geofence/envelope.
    if (![sheetLat, sheetLng, venueLat, venueLng].every(Number.isFinite)) {
      return res.status(400).json({ error: 'gps_required', hint: 'photo capture GPS missing' });
    }
    const maxSpread = Math.max(
      haversineM(sheetLat, sheetLng, lat, lng),
      haversineM(venueLat, venueLng, lat, lng),
      haversineM(sheetLat, sheetLng, venueLat, venueLng),
    );
    if (maxSpread > config.photoGpsCoherenceM + (Number.isFinite(accuracy) ? accuracy : 0)) {
      return res.status(403).json({
        error: 'photo_location_mismatch',
        spreadM: Math.round(maxSpread),
        allowedM: config.photoGpsCoherenceM,
      });
    }

    let distanceM = null;
    let locationVerified = 0;
    let locationPlausible = null;
    if (pu.lat != null) {
      // Crowd-mapped coordinates carry pre-election uncertainty (the booth can
      // stand anywhere in the mapped area), so their fence is wider than the
      // 200 m used for officially verified coordinates.
      const fenceM = pu.coords_source === 'crowd_mapped' ? config.crowdGeofenceRadiusM : config.geofenceRadiusM;
      distanceM = Math.round(haversineM(lat, lng, pu.lat, pu.lng));
      if (distanceM > fenceM) {
        return res.status(403).json({
          error: 'outside_geofence',
          distanceM,
          allowedM: fenceM,
        });
      }
      locationVerified = 1;
    } else if (pu.approx_lat != null) {
      // Tier-2: is the GPS claim inside the unit's approximate envelope (GRID3
      // ward/school data)? Grossly outside -> hard reject (same rule as pre-election
      // mapping: you can't report a unit from far away). Borderline -> flag only.
      const approxDist = haversineM(lat, lng, pu.approx_lat, pu.approx_lng);
      if (approxDist > pu.approx_radius_m * 1.5 + 2000) {
        return res.status(403).json({ error: 'too_far_from_unit' });
      }
      locationPlausible = approxDist <= pu.approx_radius_m * 1.5 + 1000 + accuracy ? 1 : 0;
    }

    // 2. Both photos, both freshly captured in-app moments ago.
    const now = Date.now();
    const sheet = req.files?.photo?.[0];
    const venue = req.files?.venuePhoto?.[0];
    if (!sheet) return res.status(400).json({ error: 'photo_required', hint: 'EC8A sheet, captured in-app' });
    if (!venue) return res.status(400).json({ error: 'venue_photo_required', hint: 'polling unit surroundings, captured in-app' });
    if (!isFresh(capturedAt, now) || !isFresh(venueCapturedAt, now)) {
      return res.status(400).json({ error: 'photo_not_fresh', maxAgeS: config.photoMaxAgeS });
    }

    // 3. Duplicate-image guards across BOTH photo columns — a sheet photo cannot be
    //    reused as someone's venue photo or vice versa, exact or re-encoded.
    const imageSha256 = sha256Hex(sheet.buffer);
    const venueImageSha256 = sha256Hex(venue.buffer);
    if (imageSha256 === venueImageSha256) {
      return res.status(400).json({ error: 'venue_photo_required', hint: 'sheet and venue photos must differ' });
    }
    const dupe = db.prepare(`
      SELECT 1 FROM submissions
      WHERE image_sha256 IN (?, ?) OR venue_image_sha256 IN (?, ?)`)
      .get(imageSha256, venueImageSha256, imageSha256, venueImageSha256);
    if (dupe) return res.status(409).json({ error: 'duplicate_image' });

    const imageDhash = await dhashHex(sheet.buffer);
    const venueImageDhash = await dhashHex(venue.buffer);
    if (hammingDistance(imageDhash, venueImageDhash) <= config.dhashHammingThreshold) {
      return res.status(400).json({ error: 'venue_photo_required', hint: 'venue photo looks identical to the sheet photo' });
    }
    // Near-duplicate guard — relaxed for THIS observer's own photos at THIS unit:
    // reporting several contests from one unit legitimately produces very similar
    // shots (same venue, same form layout) minutes apart. Cross-observer copies
    // stay rejected.
    const knownHashes = db.prepare(`
      SELECT image_dhash AS h, observer_id, pu_code FROM submissions
      UNION ALL SELECT venue_image_dhash, observer_id, pu_code FROM submissions`).all();
    const nearDuplicate = knownHashes.some(
      (r) =>
        !(r.observer_id === req.observer.id && r.pu_code === puCode) &&
        (hammingDistance(r.h, imageDhash) <= config.dhashHammingThreshold ||
          hammingDistance(r.h, venueImageDhash) <= config.dhashHammingThreshold),
    );
    if (nearDuplicate) return res.status(409).json({ error: 'near_duplicate_image' });

    // 4. Votes — known parties only, non-negative integer counts.
    let votes;
    try {
      votes = canonicalVotes(JSON.parse(votesRaw));
    } catch {
      return res.status(400).json({ error: 'invalid_votes' });
    }
    if (
      !Array.isArray(votes) ||
      votes.length === 0 ||
      votes.some((v) => !partyCodes.has(v.party) || !Number.isInteger(v.count) || v.count < 0)
    ) {
      return res.status(400).json({ error: 'invalid_votes' });
    }

    // 5. The observer's own cryptographic signature over the exact payload —
    //    covering both photo hashes, both timestamps, and the GPS claim.
    const payload = canonicalPayload({
      puCode, contest, votes, imageSha256, venueImageSha256, capturedAt, venueCapturedAt,
      lat, lng, sheetLat, sheetLng, venueLat, venueLng,
    });
    if (!verifyObserverSignature(req.observer.public_key_jwk, payload, signature)) {
      return res.status(401).json({ error: 'bad_signature' });
    }

    // 6. One report per observer per unit PER CONTEST (also a UNIQUE constraint).
    if (
      db.prepare('SELECT 1 FROM submissions WHERE pu_code = ? AND observer_id = ? AND contest = ?')
        .get(puCode, req.observer.id, contest)
    ) {
      return res.status(409).json({ error: 'already_submitted' });
    }

    // 7. Oracle attestation + tamper-evident ledger append. locationVerified is part
    //    of the attested, hash-chained record — the GPS claim is on the ledger.
    const locationProof = makeLocationProof({
      observerId: req.observer.id,
      puCode,
      lat,
      lng,
      accuracy,
      distanceM,
      locationVerified,
    });
    const ledgerPayload = JSON.stringify({ observerId: req.observer.id, payload, signature, locationProof });

    const imagePath = path.join(config.uploadDir, `${imageSha256}.jpg`);
    const venueImagePath = path.join(config.uploadDir, `${venueImageSha256}.jpg`);
    fs.writeFileSync(imagePath, sheet.buffer);
    fs.writeFileSync(venueImagePath, venue.buffer);

    // ORB features for scene corroboration; null on failure — evidence is additive.
    const venueFeatures = await extractFeatures(venue.buffer);

    const { entryHash, submissionId } = db.transaction(() => {
      const entry = nextEntry(db, ledgerPayload);
      const info = db.prepare(`
        INSERT INTO submissions
          (pu_code, observer_id, contest, votes_json, image_sha256, image_dhash, image_path,
           venue_image_sha256, venue_image_dhash, venue_image_path, venue_features,
           lat, lng, sheet_lat, sheet_lng, venue_lat, venue_lng,
           accuracy, location_verified, location_plausible, captured_at, venue_captured_at,
           location_proof, client_sig, ledger_payload, prev_hash, entry_hash, created_at, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          puCode, req.observer.id, contest, JSON.stringify(votes), imageSha256, imageDhash, imagePath,
          venueImageSha256, venueImageDhash, venueImagePath, venueFeatures,
          lat, lng, sheetLat, sheetLng, venueLat, venueLng,
          accuracy, locationVerified, locationPlausible, capturedAt, venueCapturedAt,
          locationProof, signature, ledgerPayload, entry.prevHash, entry.entryHash, now, deviceId,
        );
      return { entryHash: entry.entryHash, submissionId: info.lastInsertRowid };
    })();

    // Compare this venue photo against every OTHER observer's venue photo for the
    // same unit — confirmed pairs are public corroboration that reporters stood at
    // the same physical place. Own submissions excluded: multi-contest reports from
    // one observer must not corroborate themselves.
    if (venueFeatures) {
      const peers = db.prepare(
        'SELECT id, venue_features FROM submissions WHERE pu_code = ? AND id != ? AND observer_id != ? AND venue_features IS NOT NULL',
      ).all(puCode, submissionId, req.observer.id);
      const insertMatch = db.prepare(
        'INSERT INTO venue_matches (pu_code, submission_a, submission_b, good_matches, inliers, confirmed) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const peer of peers) {
        const m = await matchFeatures(peer.venue_features, venueFeatures);
        if (m) insertMatch.run(puCode, peer.id, submissionId, m.good, m.inliers, m.confirmed ? 1 : 0);
      }
    }

    const result = recomputeResult(db, puCode, contest);
    if (result) result.scope = contestScope(pu, contest);
    notifySubscribers(db, { contest, pu });

    // Optional EC8A form serial (observer-typed) + automated integrity checks.
    // Best-effort — never block or fail the submission.
    const sheetSerial = String(req.body.sheetSerial || '').trim().slice(0, 40) || null;
    if (sheetSerial) db.prepare('UPDATE submissions SET sheet_serial = ? WHERE id = ?').run(sheetSerial, submissionId);
    try {
      checkSubmission({ pu, contest, votes, submissionId, sheetSerial });
      if (result) checkResult({ pu, contest, result });
    } catch (e) { console.error('[integrity]', e.message); }

    // Confirm to the reporter, and ping the master, with the activity basics.
    const contestLabel = (contestCodes.has(contest) && contest) || contest;
    notifyChat(chatIdByHash(req.observer.phone_hash),
      `🦅 Report recorded — ${pu.name} (${puCode}), ${contestLabel}. Status: ${result?.status || 'reported'}. It is now on the public ledger.`);
    notifyMaster(`report · observer #${req.observer.id} · ${contestLabel} at ${pu.name}, ${pu.state}`);

    // Best-effort OCR cross-check (typed counts vs the sheet), time-boxed so a slow
    // or failed OCR never holds up the response.
    let ocr = null;
    try {
      ocr = await Promise.race([
        ocrMatchCounts(sheet.buffer, votes),
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ]);
    } catch { /* ignore */ }
    if (ocr) {
      db.prepare('UPDATE submissions SET ocr_matched = ?, ocr_total = ? WHERE id = ?')
        .run(ocr.matched, ocr.total, submissionId);
    }

    // AI vision check of the EC8A sheet (count read-back + authenticity) — advisory,
    // fire-and-forget so it never delays or blocks the submission response.
    import('../services/vision.js').then((v) => v.analyzeSheet(sheet.buffer, { contest, votes, pu, submissionId })).catch(() => {});

    // Alert everyone who saved this unit as theirs (best-effort, non-blocking).
    try {
      notifyUnitSavers(puCode,
        `📋 New result report at your polling unit ${puCode} (${contest}).\nSee it: https://hawkeye.com.ng/dashboard.html`);
    } catch { /* never block the submission */ }

    res.status(201).json({ ok: true, entryHash, locationVerified: Boolean(locationVerified), ocr, result });
  } catch (err) {
    console.error('[submit]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

const resultShape = (r) => ({
  puCode: r.pu_code,
  contest: r.contest,
  disputed: Boolean(r.disputed), // open flag / open or upheld case — see /api/docket
  votes: JSON.parse(r.votes_json),
  confidence: r.confidence,
  matchingReports: r.matching_reports,
  totalReports: r.total_reports,
  status: r.status,
  locationStatus: r.location_status,
  locationConfidence: r.location_confidence,
  locationPlausibility: r.location_plausibility,
  locationScore: r.location_score,
  venueMatches: r.venue_matches,
  updatedAt: r.updated_at,
});

submissionsRouter.get('/results', (req, res) => {
  const contest = req.query.contest ? String(req.query.contest) : null;
  const rows = db.prepare(`
    SELECT r.*, p.name, p.ward, p.lga, p.state, p.senatorial, p.federal_constituency
    FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
    ${contest ? 'WHERE r.contest = ?' : ''}
    ORDER BY r.updated_at DESC`).all(...(contest ? [contest] : []));
  res.json(rows.map((r) => ({
    ...resultShape(r),
    name: r.name, ward: r.ward, lga: r.lga, state: r.state,
    scope: contestScope(r, r.contest),
  })));
});

submissionsRouter.get('/results/:puCode', (req, res) => {
  const contest = String(req.query.contest || 'PRES');
  const r = db.prepare(`
    SELECT r.*, p.state, p.lga, p.senatorial, p.federal_constituency
    FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
    WHERE r.pu_code = ? AND r.contest = ?`)
    .get(req.params.puCode, contest);
  if (!r) return res.status(404).json({ error: 'no_reports_yet' });
  res.json({ ...resultShape(r), scope: contestScope(r, r.contest) });
});

// Live OCR telemetry from real submissions — how often typed counts are being
// read off sheet photos. This is the tuning signal that accumulates automatically.
submissionsRouter.get('/ocr/stats', (_req, res) => {
  const r = db.prepare(`
    SELECT COUNT(*) AS reports, SUM(ocr_matched) AS matched, SUM(ocr_total) AS total
    FROM submissions WHERE ocr_total IS NOT NULL`).get();
  res.json({ reportsWithOcr: r.reports, countsMatched: r.matched || 0, countsTotal: r.total || 0,
    matchRate: r.total ? +((r.matched / r.total) * 100).toFixed(1) : null });
});

// Public audit: anyone can re-verify the entire hash chain at any time.
submissionsRouter.get('/ledger/verify', (_req, res) => res.json(verifyChain(db)));

// Raw chain entries (ascending) so anyone can recompute the hashes client-side and
// browse the evidence — the trustless heart of the audit page.
submissionsRouter.get('/ledger/entries', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, pu_code, contest, created_at, prev_hash, entry_hash, ledger_payload,
           image_sha256, venue_image_sha256
    FROM submissions ORDER BY id`).all();
  res.json(rows);
});

// External anchors: each row is a ledger head published to the public Sigstore
// Rekor transparency log (a log we don't control). ANYONE can independently
// verify an anchor without us: (1) rebuild `artifact` from the row (or use the
// stored one), (2) confirm sha256(artifact) matches, (3) fetch the Rekor entry
// at `rekorUrl` and check it was logged at `rekorTime` — a rolled-back database
// cannot reproduce an entry that already exists at a fixed Rekor log index.
submissionsRouter.get('/anchors', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, day, head_hash, collation_head, entries, collation_entries, created_at,
           races_root, races_count, rekor_uuid, rekor_log_index, rekor_time, rekor_artifact
    FROM anchors ORDER BY id DESC`).all();
  res.json({
    publicKey: anchorPublicKey(),
    rekorBase: 'https://rekor.sigstore.dev/api/v1/log/entries',
    howToVerify: 'sha256(artifact) is signed by publicKey and logged in Sigstore Rekor at rekorLogIndex/rekorTime; fetch rekorUrl to confirm. A restored (rolled-back) database cannot reproduce these entries.',
    howToVerifyRace: 'artifact embeds racesRoot, the Merkle root over every race this cycle. GET /api/anchors/:id/races/:raceKey returns that race\'s subchain head, leaf and Merkle proof; fold the proof (leaf; per step h = side===left ? sha256(step.hash+h) : sha256(h+step.hash)) up to racesRoot to verify ONE race in isolation — no need to replay the whole ledger.',
    anchors: rows.map((r) => ({
      id: r.id,
      day: r.day,
      head: r.head_hash,
      entries: r.entries,
      collationHead: r.collation_head,
      collationEntries: r.collation_entries,
      racesRoot: r.races_root,
      racesCount: r.races_count,
      at: new Date(r.created_at).toISOString(),
      artifact: r.rekor_artifact,
      rekorUuid: r.rekor_uuid,
      rekorLogIndex: r.rekor_log_index,
      rekorTime: r.rekor_time,
      rekorUrl: r.rekor_uuid ? `https://rekor.sigstore.dev/api/v1/log/entries/${r.rekor_uuid}` : null,
    })),
  });
});

// Every race batched under one anchor's Merkle root (heads + entry counts).
submissionsRouter.get('/anchors/:id/races', (req, res) => {
  const a = db.prepare('SELECT races_root, races_count FROM anchors WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'no_such_anchor' });
  const races = db.prepare(
    'SELECT race_key, race_head, entries, leaf_index FROM anchor_races WHERE anchor_id = ? ORDER BY leaf_index')
    .all(req.params.id);
  return res.json({ racesRoot: a.races_root, racesCount: a.races_count, races });
});

// One race's dispute paper trail: its subchain head + Merkle inclusion proof up
// to the anchor's racesRoot (which the Rekor artifact commits to). Anyone can
// fold the proof and confirm this exact race was fixed at that anchor's time,
// without trusting us and without replaying every other race.
submissionsRouter.get('/anchors/:id/races/:raceKey', (req, res) => {
  const a = db.prepare('SELECT races_root, rekor_uuid FROM anchors WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'no_such_anchor' });
  const r = db.prepare(
    'SELECT race_key, race_head, entries, leaf_index, leaf_hash, proof_json FROM anchor_races WHERE anchor_id = ? AND race_key = ?')
    .get(req.params.id, req.params.raceKey);
  if (!r) return res.status(404).json({ error: 'no_such_race' });
  return res.json({
    raceKey: r.race_key,
    head: r.race_head,
    entries: r.entries,
    leafIndex: r.leaf_index,
    leaf: r.leaf_hash,
    leafFormula: `sha256("race|v1|" + raceKey + "|" + head + "|" + entries)`,
    proof: JSON.parse(r.proof_json),
    racesRoot: a.races_root,
    rekorUrl: a.rekor_uuid ? `https://rekor.sigstore.dev/api/v1/log/entries/${a.rekor_uuid}` : null,
    howToVerify: 'Recompute leaf via leafFormula; fold proof to racesRoot (per step h = side===left ? sha256(step.hash+h) : sha256(h+step.hash)); confirm racesRoot appears in the Rekor artifact at rekorUrl.',
  });
});
