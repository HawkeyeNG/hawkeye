import fs from 'node:fs';
import path from 'node:path';
import { getBlob } from './blobstore.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { ocrMatchCounts } from './ocr.js';

/**
 * OCR, off the submission request path.
 *
 * WHY THIS EXISTS. `POST /api/submissions` used to do:
 *
 *     ocr = await Promise.race([ocrMatchCounts(...), timeout(12000)]);
 *
 * — an awaited, 12-second-capped call, measured at ~4.9 s through a single shared
 * tesseract worker. The result is ADVISORY (a corroboration signal, never a gate),
 * so the observer was being made to wait on something that cannot change the
 * outcome of their submission. At the election-night design peak of ~239
 * submissions/s that is not a latency annoyance; it is the entire throughput
 * budget spent on a cross-check nobody is blocked on.
 *
 * WHY A TABLE AND NOT FIRE-AND-FORGET. `analyzeSheet` right below it is a
 * dropped-promise dynamic import, and for an advisory extra that is fine. This is
 * different only in that election night has no second chance: a process restart
 * at 16:00 on 16 January would silently lose every in-flight read, and nothing
 * would ever notice. The queue costs one row.
 *
 * The job payload is just the submission id. The sheet is already on disk at
 * `submissions.image_path` and the typed counts are already in `votes_json`, so
 * the worker re-reads both rather than holding a JPEG in memory or in the DB.
 */

const BATCH = Number(process.env.OCR_QUEUE_BATCH || 4);
const TICK_MS = Number(process.env.OCR_QUEUE_TICK_MS || 2000);
const MAX_ATTEMPTS = Number(process.env.OCR_MAX_ATTEMPTS || 3);

export function enqueueOcr(submissionId) {
  try {
    const now = Date.now();
    // INSERT OR IGNORE against a PRIMARY KEY: enqueueing twice is a no-op, so a
    // retried submit cannot double-queue and this needs no separate dedupe.
    db.prepare(
      'INSERT OR IGNORE INTO ocr_jobs (submission_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(submissionId, 'queued', now, now);
  } catch (e) {
    // Never let an advisory cross-check break a submission. The report is already
    // committed and on the ledger by the time this is called.
    console.error(JSON.stringify({ msg: 'ocr enqueue failed', submissionId, error: String(e) }));
  }
}

async function runOne(job) {
  const row = db.prepare('SELECT id, image_path, votes_json FROM submissions WHERE id = ?').get(job.submission_id);
  if (!row) {
    // The submission is gone (practice purge, manual delete). Not an error.
    db.prepare("UPDATE ocr_jobs SET status = 'done', updated_at = ? WHERE submission_id = ?").run(Date.now(), job.submission_id);
    return;
  }
  let result = null;
  try {
    // Keyed off the basename, not the stored path: the column holds a local
    // path for every row ever written, but the bytes may now be in a bucket, and
    // the filename IS the content hash either way.
    const buf = await getBlob(path.basename(row.image_path));
    result = await ocrMatchCounts(buf, JSON.parse(row.votes_json));
  } catch (e) {
    const attempts = job.attempts + 1;
    // Give up loudly rather than retrying a broken sheet forever. A permanently
    // failed read costs nothing downstream: ocr_matched simply stays NULL, which
    // already means "not checked" everywhere it is read.
    db.prepare("UPDATE ocr_jobs SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE submission_id = ?")
      .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', attempts, String(e), Date.now(), job.submission_id);
    return;
  }
  if (result) {
    db.prepare('UPDATE submissions SET ocr_matched = ?, ocr_total = ? WHERE id = ?')
      .run(result.matched, result.total, row.id);
  }
  db.prepare("UPDATE ocr_jobs SET status = 'done', attempts = attempts + 1, updated_at = ? WHERE submission_id = ?")
    .run(Date.now(), job.submission_id);
}

let draining = false;
export async function drainOcrQueue() {
  // A shared guard, not a per-call flag: two overlapping drains would run the same
  // job twice and fight over the same row.
  if (draining) return;
  draining = true;
  try {
    const jobs = db.prepare(
      "SELECT submission_id, attempts FROM ocr_jobs WHERE status = 'queued' ORDER BY submission_id LIMIT ?",
    ).all(BATCH);
    for (const job of jobs) {
      await runOne(job);
      // Yield between sheets. tesseract is CPU-bound and this process also serves
      // every submission; draining a backlog must never become the new stall.
      await new Promise((r) => setImmediate(r));
    }
  } catch (e) {
    console.error(JSON.stringify({ msg: 'ocr drain failed', error: String(e) }));
  } finally {
    draining = false;
  }
}

export function startOcrWorker() {
  if (config.env === 'test') return;
  // unref: this timer must never be the reason the process stays alive.
  setInterval(() => { drainOcrQueue(); }, TICK_MS).unref();
}
