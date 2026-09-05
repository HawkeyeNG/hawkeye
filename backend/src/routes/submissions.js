import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { db, partyCodes, contestCodes, contests } from '../db.js';
import { config } from '../config.js';
import { haversineM, makeLocationProof } from '../services/geo.js';
import { sha256Hex, dhashHex, hammingDistance, dhashBandTokens } from '../services/images.js';
import { enqueueOcr, startOcrWorker } from '../services/ocr-queue.js';
// The head reported for an EMPTY chain — mirrors GENESIS_HASH in services/ledger.js.
// This branch is only reached when there are zero submissions, which is exactly the
// state production was in and the state the 120-row local fixture was not: the
// constant was referenced before it was declared and every call to
// /api/ledger/verify returned 502. Test the empty case explicitly.
const GENESIS_HASH_PUBLIC = '0'.repeat(64);

// Drains the OCR backlog off the request path (services/ocr-queue.js).
startOcrWorker();
import { canonicalPayload, canonicalVotes, verifyObserverSignature } from '../services/signatures.js';
import { nextEntry, verifyChain, verifyChainAsync } from '../services/ledger.js';
import { recomputeResult } from '../services/aggregate.js';
import { extractFeatures, matchFeatures } from '../services/scene.js';
import { requireObserver } from './observers.js';
import { contestScope, contestApplies, reportingOpen, reportingOpensAt } from '../services/scope.js';
import { notifySubscribers } from './subscriptions.js';
import { notifyChat, notifyMaster, chatIdByHash, notifyUnitSavers } from '../services/notify.js';
import { checkSubmission, checkResult } from '../services/integrity.js';
import { anchorPublicKey } from '../services/anchor.js';

export const submissionsRouter = Router();

// This router writes sheet/venue photos straight into uploadDir, so it owns that
// invariant itself rather than inheriting it from another module's import-time
// side effect. Idempotent: a recursive mkdir on an existing directory is a no-op.
fs.mkdirSync(config.uploadDir, { recursive: true });

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
    // A scheduled election accepts result reports only from poll-open on
    // election day — no early filings while the ad campaign runs pre-election.
    const contestDef = contests.find((c) => c.code === contest);
    if (!reportingOpen(contestDef)) {
      return res.status(403).json({ error: 'reporting_not_open', opensAt: reportingOpensAt(contestDef) });
    }
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
    // constituencies too: a by-election runs in ONE seat of its state, and a
    // states-only gate would admit every unit in that state.
    if (!contestApplies(pu, contest, contestDef?.states, contestDef?.constituencies)) {
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
    } else if (pu.state && pu.lga && pu.ward) {
      // Tier-3: the unit is placed NOWHERE — no pin, no envelope. Until now
      // these fell off the end of this chain with no distance check of any kind:
      // a report from anywhere on earth was accepted. routes/mapping.js:35-44
      // already solved this for the low-stakes coordinate-suggestion endpoint,
      // and its comment names the hole exactly — "a unit with no envelope had NO
      // distance check at all". That rule is ported here verbatim, same query,
      // same threshold, so the evidentiary endpoint is no longer weaker than the
      // advisory one.
      //
      // The centroid of sibling units in the same ward that DO have a spot is a
      // coarse instrument, so it is checked at config.wardFallbackRadiusM
      // (15km) — wide enough to survive a badly geocoded ward, narrow enough
      // that the wrong state is refused. A ward with no located sibling at all
      // still accepts blind, which is honest: nothing here knows where that unit
      // is.
      //
      // Measured 2026-09-02 over the 176,846-row register: 117,167 pinned,
      // 52,867 envelope-only, and 6,812 reaching this branch — of which 5,588
      // gain a ward-centroid fence here and 1,224 remain unfenced. Those counts
      // move as geocoding lands, so re-measure rather than trusting them.
      const sib = db.prepare(
        `SELECT AVG(COALESCE(lat, approx_lat)) AS la, AVG(COALESCE(lng, approx_lng)) AS ln, COUNT(*) AS n
           FROM polling_units
          WHERE state = ? AND lga = ? AND ward = ? AND pu_code != ? AND COALESCE(lat, approx_lat) IS NOT NULL`,
      ).get(pu.state, pu.lga, pu.ward, pu.pu_code);
      if (sib && sib.n > 0 && haversineM(lat, lng, sib.la, sib.ln) > config.wardFallbackRadiusM) {
        return res.status(403).json({ error: 'too_far_from_unit' });
      }
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
    //
    // INDEXED, NOT SCANNED. This used to SELECT every dhash in the table (both
    // columns, UNION ALL) and Hamming-compare in JS on every submission — 3.18M
    // rows per insert at the 2027 ceiling, ~2.5 trillion comparisons over a run,
    // blocking the only event loop we have. It now asks the banded index for the
    // handful of rows that CAN be within the threshold and compares only those.
    //
    // The verdict is unchanged: services/images.js proves band lookup misses no
    // true near-duplicate (pigeonhole), and hammingDistance() below still makes
    // the actual decision, so nothing newly passes or newly fails.
    const T = config.dhashHammingThreshold;
    const tokens = [
      ...dhashBandTokens(imageDhash, T),
      ...dhashBandTokens(venueImageDhash, T),
    ];
    const candidates = db.prepare(`
      SELECT DISTINCT dhash AS h, observer_id, pu_code FROM dhash_bands
      WHERE band_token IN (${tokens.map(() => '?').join(',')})`).all(...tokens);
    const nearDuplicate = candidates.some(
      (r) =>
        !(r.observer_id === req.observer.id && r.pu_code === puCode) &&
        (hammingDistance(r.h, imageDhash) <= T ||
          hammingDistance(r.h, venueImageDhash) <= T),
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
      // The band index is written INSIDE this transaction, so it can never drift
      // from the row it describes: either both land or neither does. An index
      // updated after the commit would leave a window in which a photo is stored
      // but not yet guarded, and on election night that window is the attack.
      const subId = info.lastInsertRowid;
      const insBand = db.prepare(
        'INSERT INTO dhash_bands (submission_id, slot, band_token, dhash, observer_id, pu_code) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const [slot, h] of [[0, imageDhash], [1, venueImageDhash]]) {
        for (const tok of dhashBandTokens(h, config.dhashHammingThreshold)) {
          insBand.run(subId, slot, tok, h, req.observer.id, puCode);
        }
      }
      return { entryHash: entry.entryHash, submissionId: subId };
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
    notifySubscribers(db, { contest, pu, exceptObserverId: req.observer?.id ?? null });

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

    // OCR cross-check, QUEUED rather than awaited. The comment this replaces said
    // it was "time-boxed so a slow OCR never holds up the response" — but the box
    // was 12 SECONDS, on a call measured at ~4.9 s, for a result that is advisory
    // and can never change whether the submission is accepted. The observer was
    // waiting on a number nobody blocks on.
    //
    // The row is already committed and on the ledger at this point, so a queued
    // read cannot affect the outcome; it only fills ocr_matched/ocr_total in later.
    // NULL there already means "not checked" everywhere it is read.
    enqueueOcr(submissionId);

    // AI vision check of the EC8A sheet (count read-back + authenticity) — advisory,
    // fire-and-forget so it never delays or blocks the submission response.
    import('../services/vision.js').then((v) => v.analyzeSheet(sheet.buffer, { contest, votes, pu, submissionId })).catch(() => {});

    // In-app notification centre (persisted) + native push, for the reporter and
    // for everyone who saved this unit. Telegram fan-out is kept for savers who
    // linked it. All best-effort — never block the submission.
    import('../services/notifications.js').then((n) => {
      n.pushNote(req.observer.id, {
        kind: 'report',
        title: 'Report recorded',
        body: `${pu.name} (${puCode}) · ${contestLabel} — status ${result?.status || 'reported'}. It is on the public ledger.`,
        url: 'https://hawkeye.com.ng/dashboard.html',
      });
      n.noteUnitSavers(puCode, {
        kind: 'unit',
        title: 'New report at your unit',
        body: `${pu.name} (${puCode}) · ${contest}`,
        url: 'https://hawkeye.com.ng/dashboard.html',
      });
    }).catch(() => {});
    try {
      notifyUnitSavers(puCode,
        `📋 New result report at your polling unit ${puCode} (${contest}).\nSee it: https://hawkeye.com.ng/dashboard.html`);
    } catch { /* never block the submission */ }

    // ocr is NULL BY CONSTRUCTION now, not omitted. The cross-check moved to a
    // queue (services/ocr-queue.js), so it cannot be known at response time — and
    // when the await was removed, `ocr` kept being referenced here, which threw a
    // ReferenceError into this handler's own catch and returned 500 AFTER the
    // submission had been committed and written to the ledger. The observer would
    // have seen a failure on a report that WAS recorded, resubmitted, and been
    // rejected by the duplicate-photo guard. node --check does not catch it, and
    // no test reaches this line.
    //
    // The key is kept rather than dropped because five clients read it — app.js,
    // case.html, and three native screens — all guarded on `.ocr && .ocr.total`,
    // so null simply renders nothing. Two of those clients are in a shipped app.
    res.status(201).json({ ok: true, entryHash, locationVerified: Boolean(locationVerified), ocr: null, result });
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
// ---- Public chain verification ----------------------------------------------
//
// This used to be `res.json(verifyChain(db))`: a full synchronous re-hash of every
// row, on an unauthenticated GET. At election-night volume that is a multi-second
// freeze of the entire process — better-sqlite3 is synchronous and there is one
// event loop — which any anonymous caller could trigger in a loop against the
// endpoint the project's credibility rests on.
//
// The verification itself is NOT weakened. A full sweep from the genesis hash
// still runs; it runs on a timer, off the request path, in batches that yield
// (see services/ledger.js). The endpoint serves the last completed sweep and
// says when it ran, so a reader can judge its freshness for themselves.
//
// The stronger guarantee is unchanged and stated in the response: anyone who
// does not want to take our word for it replays the chain themselves from
// /api/ledger/entries, or checks a published anchor. A verifier that only ever
// asks the server "are you honest?" was never the real assurance.
const LEDGER_VERIFY_INTERVAL_MS = Number(process.env.LEDGER_VERIFY_INTERVAL_MS || 5 * 60 * 1000);
let ledgerVerifyState = { status: 'pending', verifiedAt: null };
// A SHARED IN-FLIGHT PROMISE, not a boolean. A `running` flag would make the
// endpoint's `await` a silent no-op: a second caller arriving mid-sweep returns
// instantly, still sees status 'pending', and renders the broken-ledger banner —
// the precise failure the await exists to prevent. Everyone waiting on a sweep
// must wait on the SAME promise.
let ledgerVerifyInFlight = null;

function refreshLedgerVerification() {
  if (!ledgerVerifyInFlight) {
    ledgerVerifyInFlight = (async () => {
      try {
        const r = await verifyChainAsync(db);
        ledgerVerifyState = { ...r, status: 'complete', verifiedAt: Date.now() };
        if (!r.ok) {
          // A broken chain is the most serious thing this software can report.
          console.error(JSON.stringify({ msg: 'LEDGER CHAIN BROKEN', brokenAtId: r.brokenAtId, entries: r.entries }));
        }
      } catch (e) {
        // Keep the last GOOD result rather than replacing it with an error shape
        // that callers would read as a broken chain.
        ledgerVerifyState = { ...ledgerVerifyState, lastError: String(e), verifiedAt: Date.now() };
        console.error(JSON.stringify({ msg: 'ledger verification failed', error: String(e) }));
      } finally {
        ledgerVerifyInFlight = null;
      }
    })();
  }
  return ledgerVerifyInFlight;
}
refreshLedgerVerification();
setInterval(refreshLedgerVerification, LEDGER_VERIFY_INTERVAL_MS).unref();

submissionsRouter.get('/ledger/verify', async (_req, res) => {
  // The first caller after a restart waits for the in-flight sweep rather than
  // receiving a half-shaped object. app/ledger.html reads `verify.ok` and
  // `verify.entries` directly and renders `Broken #${verify.brokenAtId}` when ok
  // is falsy — so a 'pending' response with neither field would have shown the
  // public verification page announcing a BROKEN LEDGER for the first few
  // minutes after every deploy. Awaiting is safe: verifyChainAsync yields
  // between batches, so this waits without blocking anyone else.
  if (ledgerVerifyState.status === 'pending') await refreshLedgerVerification();
  // The head is cheap and always current, so serve it live even when the sweep
  // behind it is minutes old — it is what a caller comparing against a published
  // anchor actually needs.
  const head = db.prepare('SELECT entry_hash, id FROM submissions ORDER BY id DESC LIMIT 1').get();
  const total = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
  res.json({
    ...ledgerVerifyState,
    currentEntries: total,
    currentHead: head ? head.entry_hash : GENESIS_HASH_PUBLIC,
    ageMs: ledgerVerifyState.verifiedAt ? Date.now() - ledgerVerifyState.verifiedAt : null,
    sweepIntervalMs: LEDGER_VERIFY_INTERVAL_MS,
    howToVerifyYourself:
      'Do not take this endpoint on trust. Page /api/ledger/entries?sinceId=&limit=, and for each row check '
      + 'prev_hash equals the previous row entry_hash and sha256(prev_hash + ledger_payload) equals entry_hash, '
      + 'starting from the all-zero genesis hash. Cross-check the final head against a published anchor.',
  });
});

// Raw chain entries (ascending) so anyone can recompute the hashes client-side and
// browse the evidence — the trustless heart of the audit page.
// BOUNDED, but still a bare ARRAY. This used to return the WHOLE table — every
// row including every ledger_payload — on one unauthenticated GET, read into JS
// with .all() and then JSON.stringify'd. At election-night volume that is a
// multi-gigabyte response assembled in memory, a heavier way to stop the server
// than the verify endpoint ever was. Fixing verify and leaving this open would
// have moved the target, not closed it.
//
// THE SHAPE DOES NOT CHANGE, deliberately. Five callers consume this as an array
// — app/index.html (`rows.slice(-3)`), app/ledger.html (`entries.length`), and
// TWO SCREENS IN THE SHIPPED NATIVE APP, which cannot be updated retroactively.
// Returning {entries:[...]} would have thrown a TypeError on a phone someone
// installed last month. So: same array, with a cap and opt-in paging.
//
// Default (no params) returns the MOST RECENT page, ascending, because that is
// what the existing callers want — index.html takes the last three. Explicit
// ?sinceId=&limit= walks the chain forward from the genesis end, which is what
// independent verification needs. X-Ledger-* headers tell a caller whether it
// saw everything.
const LEDGER_PAGE_MAX = 1000;
submissionsRouter.get('/ledger/entries', (req, res) => {
  const limit = Math.min(LEDGER_PAGE_MAX, Math.max(1, Number(req.query.limit) || LEDGER_PAGE_MAX));
  const total = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
  const cols = `id, pu_code, contest, created_at, prev_hash, entry_hash, ledger_payload,
                image_sha256, venue_image_sha256`;
  let rows;
  if (req.query.sinceId !== undefined) {
    // Explicit paging: forward from sinceId, for replaying the chain in order.
    const sinceId = Math.max(0, Number(req.query.sinceId) || 0);
    rows = db.prepare(`SELECT ${cols} FROM submissions WHERE id > ? ORDER BY id LIMIT ?`).all(sinceId, limit);
  } else {
    // Default: the newest `limit` rows, returned oldest-first so the array reads
    // the same way it always did.
    rows = db.prepare(`SELECT ${cols} FROM submissions ORDER BY id DESC LIMIT ?`).all(limit).reverse();
  }
  res.set('X-Ledger-Total', String(total));
  res.set('X-Ledger-Page-Max', String(LEDGER_PAGE_MAX));
  res.set('X-Ledger-Truncated', String(total > rows.length));
  if (rows.length) res.set('X-Ledger-Next-Since-Id', String(rows[rows.length - 1].id));
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
           races_root, races_count, practice_head, rekor_uuid, rekor_log_index, rekor_time, rekor_artifact
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
      // The practice chain's head, published so a rehearsal is followable too.
      // Named, never mixed with the ledger head above it.
      practiceHead: r.practice_head,
      racesCount: r.races_count,
      at: new Date(r.created_at).toISOString(),
      artifact: r.rekor_artifact,
      rekorUuid: r.rekor_uuid,
      rekorLogIndex: r.rekor_log_index,
      rekorTime: r.rekor_time,
      rekorUrl: r.rekor_uuid ? `https://rekor.sigstore.dev/api/v1/log/entries/${r.rekor_uuid}` : null,
      // human-readable viewer (the rekorUrl above is the raw API for verifiers)
      rekorSearchUrl: r.rekor_log_index != null ? `https://search.sigstore.dev/?logIndex=${r.rekor_log_index}` : null,
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
  const a = db.prepare('SELECT races_root, rekor_uuid, rekor_log_index FROM anchors WHERE id = ?').get(req.params.id);
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
    rekorSearchUrl: a.rekor_log_index != null ? `https://search.sigstore.dev/?logIndex=${a.rekor_log_index}` : null,
    howToVerify: 'Recompute leaf via leafFormula; fold proof to racesRoot (per step h = side===left ? sha256(step.hash+h) : sha256(h+step.hash)); confirm racesRoot appears in the Rekor artifact at rekorUrl.',
  });
});
