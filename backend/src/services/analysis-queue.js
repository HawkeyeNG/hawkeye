import { db } from '../db.js';
import { config } from '../config.js';
import { getBlob, headBlob, MAX_BLOB_BYTES } from './blobstore.js';
import { dhashHex, hammingDistance, dhashBandTokens } from './images.js';

/**
 * The pixel work that `POST /api/submissions` can no longer do for itself.
 *
 * WHY THIS EXISTS. In `UPLOAD_MODE=direct` the phone PUTs its photos straight
 * to the bucket and the origin only ever sees hashes — which is the entire
 * point, because GO54 counts inbound bytes and at 369 KB per observer the
 * request path is the bandwidth ceiling. But the origin was using those bytes
 * for more than storage: the perceptual dhash behind the near-duplicate guard,
 * and the ORB features behind venue corroboration.
 *
 * So the analysis moves here, and reads from the bucket instead. R2 egress is
 * free, so pulling every photo back out costs nothing — and this worker does
 * not have to run on the shared host at all.
 *
 * WHAT CHANGES, STATED PLAINLY. In 'proxy' mode a duplicate photo is REJECTED
 * at submission time (403). Here it can only be FLAGGED, moments later. That is
 * a real downgrade of an anti-fraud control and it is the one thing about
 * direct upload that is not a free win:
 *
 *   - it stays caught, and caught before collation, so the audit still works;
 *   - the ledger is append-only, so a flagged submission is on the record with
 *     its finding beside it rather than silently absent;
 *   - the alternative — trusting a dhash the CLIENT computed — is worse than
 *     detecting late, because an attacker uploading duplicates would then be
 *     supplying the very input meant to catch them.
 *
 * Documented in docs/DIRECT-UPLOAD.md so the trade is a decision, not a
 * discovery.
 *
 * IT IS NOT FIRE-AND-FORGET, for the reason ocr-queue.js gives: a restart at
 * 16:00 on 16 January would silently lose every in-flight job and nothing would
 * notice. One row per submission is cheap insurance.
 */

const BATCH = Number(process.env.ANALYSIS_QUEUE_BATCH || 4);
const TICK_MS = Number(process.env.ANALYSIS_QUEUE_TICK_MS || 2000);
const MAX_ATTEMPTS = Number(process.env.ANALYSIS_MAX_ATTEMPTS || 3);

/** Idempotent: INSERT OR IGNORE on a PRIMARY KEY, so a retry cannot double-queue. */
export function enqueueAnalysis(submissionId) {
  try {
    const now = Date.now();
    db.prepare(
      'INSERT OR IGNORE INTO analysis_jobs (submission_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(submissionId, 'queued', now, now);
  } catch (e) {
    // The submission is already committed and on the ledger. Losing the analysis
    // job must never unwind that.
    console.error(JSON.stringify({ msg: 'analysis enqueue failed', submissionId, error: String(e) }));
  }
}

/**
 * The same near-duplicate question the request path asks, asked later.
 *
 * Deliberately the SAME banded-index lookup and the SAME hammingDistance()
 * verdict as routes/submissions.js, so 'proxy' and 'direct' cannot drift into
 * disagreeing about what a duplicate is. Only the consequence differs.
 */
export function findDuplicates(submissionId, imageDhash, venueImageDhash, observerId, puCode) {
  const T = config.dhashHammingThreshold;
  const tokens = [...dhashBandTokens(imageDhash, T), ...dhashBandTokens(venueImageDhash, T)];
  if (!tokens.length) return [];
  const rows = db.prepare(`
    SELECT DISTINCT dhash AS h, observer_id, pu_code, submission_id
      FROM dhash_bands
     WHERE band_token IN (${tokens.map(() => '?').join(',')})
       AND submission_id != ?
  `).all(...tokens, submissionId);

  const hits = [];
  for (const r of rows) {
    // Same relaxation as the request path: one observer reporting several
    // contests from one unit legitimately produces near-identical shots.
    if (r.observer_id === observerId && r.pu_code === puCode) continue;
    for (const mine of [imageDhash, venueImageDhash]) {
      if (hammingDistance(mine, r.h) <= T) {
        hits.push({ submissionId: r.submission_id, observerId: r.observer_id, puCode: r.pu_code, distance: hammingDistance(mine, r.h) });
        break;
      }
    }
  }
  return hits;
}

async function runOne(job) {
  const row = db.prepare(`
    SELECT id, observer_id, pu_code, image_sha256, venue_image_sha256, image_dhash, venue_image_dhash
      FROM submissions WHERE id = ?
  `).get(job.submission_id);
  const done = (status, finding = null, error = null) => {
    db.prepare('UPDATE analysis_jobs SET status = ?, finding = ?, error = ?, updated_at = ? WHERE submission_id = ?')
      .run(status, finding, error, Date.now(), job.submission_id);
  };
  if (!row) return done('done');                 // purged or deleted; not an error

  try {
    // HEAD BEFORE GET. This pulls both objects into Node Buffers at once, in the
    // same process that serves submissions. An object larger than the cap should
    // never exist, but "should never" is not a memory bound — ask first.
    const keys = [`${row.image_sha256}.jpg`, `${row.venue_image_sha256}.jpg`];
    const heads = await Promise.all(keys.map((k) => headBlob(k)));
    for (let i = 0; i < heads.length; i++) {
      if (!heads[i].exists) throw new Error(`analysis: ${keys[i]} is not in the store`);
      if (heads[i].size > MAX_BLOB_BYTES) {
        return done('failed', 'oversize_blob', `${keys[i]} is ${heads[i].size} bytes`);
      }
    }
    const [sheet, venue] = await Promise.all(keys.map((k) => getBlob(k)));
    const imageDhash = await dhashHex(sheet);
    const venueImageDhash = await dhashHex(venue);

    // These columns were NULL: in direct mode the origin never had the pixels,
    // so this is the first time anything has looked at them. There is no client
    // claim to check — a client-supplied dhash was tried and measured and cannot
    // work (canvas vs sharp: 0/24 exact, median 10 bits apart, threshold 4),
    // which is why the columns are nullable and why this runs at all.
    let finding = null;
    if (hammingDistance(imageDhash, venueImageDhash) <= config.dhashHammingThreshold) {
      finding = 'sheet_and_venue_near_identical';
    }

    const dupes = findDuplicates(row.id, imageDhash, venueImageDhash, row.observer_id, row.pu_code);
    if (dupes.length && !finding) {
      finding = `duplicate_of:${dupes.map((d) => d.submissionId).slice(0, 5).join(',')}`;
    }

    // ORB features for scene corroboration; null on failure — evidence is additive.
    let venueFeatures = null;
    try {
      const { extractFeatures } = await import('./scene.js');
      venueFeatures = await extractFeatures(venue);
    } catch { /* additive only — scene corroboration must never fail a job */ }

    db.transaction(() => {
      db.prepare('UPDATE submissions SET image_dhash = ?, venue_image_dhash = ? WHERE id = ?')
        .run(imageDhash, venueImageDhash, row.id);
      if (venueFeatures) {
        db.prepare('UPDATE submissions SET venue_features = ? WHERE id = ?').run(venueFeatures, row.id);
      }
      // Index it so the NEXT submission's lookup can see this one. Without this
      // step direct-mode submissions would be invisible to each other and the
      // guard would quietly stop working.
      const ins = db.prepare(
        'INSERT OR IGNORE INTO dhash_bands (submission_id, slot, band_token, dhash, observer_id, pu_code) VALUES (?, ?, ?, ?, ?, ?)',
      );
      // db.js:534 declares `slot INTEGER NOT NULL -- 0 = sheet photo, 1 = venue
      // photo`, and routes/submissions.js writes 0/1. Writing 'sheet'/'venue'
      // here would not error (SQLite keeps the text) but the rows would disagree
      // with every other writer and reader of this table.
      for (const [slot, h] of [[0, imageDhash], [1, venueImageDhash]]) {
        for (const tok of dhashBandTokens(h, config.dhashHammingThreshold)) {
          ins.run(row.id, slot, tok, h, row.observer_id, row.pu_code);
        }
      }
    })();

    if (finding) {
      // Loud on purpose. A flag nobody reads is not a control — this is the
      // line that has to reach whoever is watching on the night.
      console.error(JSON.stringify({ msg: 'analysis finding', submissionId: row.id, finding }));
    }
    return done('done', finding);
  } catch (e) {
    const attempts = (job.attempts || 0) + 1;
    db.prepare('UPDATE analysis_jobs SET attempts = ?, updated_at = ? WHERE submission_id = ?')
      .run(attempts, Date.now(), job.submission_id);
    if (attempts >= MAX_ATTEMPTS) return done('failed', null, String(e.message).slice(0, 200));
    return undefined;                             // stays queued for the next tick
  }
}

export async function drainAnalysisQueue() {
  const jobs = db.prepare(
    "SELECT submission_id, attempts FROM analysis_jobs WHERE status = 'queued' ORDER BY submission_id LIMIT ?",
  ).all(BATCH);
  for (const job of jobs) await runOne(job);
  return jobs.length;
}

export function startAnalysisWorker() {
  const tick = async () => {
    try { await drainAnalysisQueue(); } catch (e) {
      console.error(JSON.stringify({ msg: 'analysis worker tick failed', error: String(e) }));
    }
  };
  const t = setInterval(tick, TICK_MS);
  t.unref();
  return t;
}
