import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { ocrMatchCounts } from '../services/ocr.js';
import { requireObserver } from './observers.js';
import { requireAdmin } from './admin.js';

// Human-in-the-loop OCR training: sheets in storage/training/ are shown on
// train.html with the OCR's predicted digit tokens; a verified observer confirms
// or corrects the real counts, which land in truth.json — the calibration set.
export const trainingRouter = Router();
const dir = () => {
  const d = path.join(path.dirname(config.dbPath), 'training');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const isImage = (f) => /\.(jpe?g|png)$/i.test(f);
const keyOf = (f) => f.replace(/\.[^.]+$/, '');
const jsonPath = (name) => path.join(dir(), name);
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(jsonPath(name), 'utf8')); } catch { return {}; } };
const writeJson = (name, obj) => fs.writeFileSync(jsonPath(name), JSON.stringify(obj, null, 1));

const readTruth = () => readJson('truth.json');
// sets.json partitions sheets between labelling pages (train.html = set 1,
// train2.html = set 2, …) so parallel labellers never see each other's queue.
// A sheet is "claimed" once it has a set here; unclaimed sheets are the pool a
// labeller draws a fresh batch from via POST /training/generate.
const readSets = () => readJson('sets.json');
// dropped.json holds sheets a labeller skipped as unusable (blank / no data) —
// permanently removed from every queue and from the claimable pool.
const readDropped = () => readJson('dropped.json');

// Per-page running tally. Seeded ONCE to the counts already labelled on each page
// before this counter existed (2026-07-08); every new label bumps its page.
const SEED_COUNTS = { 1: 142, 2: 100 };
const readCounts = () => {
  if (!fs.existsSync(jsonPath('train_counts.json'))) { writeJson('train_counts.json', SEED_COUNTS); return { ...SEED_COUNTS }; }
  return readJson('train_counts.json');
};
const mineForSet = (set) => Number(readCounts()[set] || 0);

// Unclaimed + unlabelled + not-dropped sheets — the reservoir for a fresh batch.
const poolFiles = () => {
  const truth = readTruth();
  const sets = readSets();
  const dropped = readDropped();
  return fs.readdirSync(dir()).filter((f) => isImage(f) && !sets[f] && !truth[keyOf(f)] && !dropped[keyOf(f)]);
};

trainingRouter.get('/training/items', (req, res) => {
  const truth = readTruth();
  const sets = readSets();
  const dropped = readDropped();
  const want = Number(req.query.set || 0); // 0 = all
  const items = fs.readdirSync(dir()).filter(isImage)
    .filter((f) => !dropped[keyOf(f)])
    .map((f) => ({ file: f, key: keyOf(f), set: sets[f] || 0, labelled: Boolean(truth[keyOf(f)]) }))
    .filter((i) => !want || i.set === want);
  res.json({ items, labelled: Object.keys(truth).length, available: poolFiles().length });
});

// This page's running total (per set).
trainingRouter.get('/training/mine', requireObserver, (req, res) => {
  res.json({ mine: mineForSet(Math.max(1, Math.floor(Number(req.query.set) || 1))) });
});

/**
 * WHICH STREAM A SHEET CAME FROM, AND WHY IT MATTERS.
 *
 * approved.json feeds the ML training and benchmark sets. Once the audit starts
 * driving the queue, every sheet a human sees will have been chosen BECAUSE it
 * failed a check — and a model calibrated on nothing but pathological sheets
 * drifts toward expecting pathology. Its error rate on ordinary sheets then
 * stops being measurable, because no ordinary sheets are labelled any more.
 *
 * Every claim records its stream so the two can be kept apart afterwards:
 *
 *   random   drawn blind from the pool — the only stream a RATE can be
 *            measured on, because it is the only unbiased sample
 *   audit    selected because a check failed — the stream that resolves
 *            findings, and the one that must never be mistaken for a sample
 *
 * Without this tag the two are indistinguishable in approved.json a month
 * later, and any accuracy figure computed from the mixture is meaningless in a
 * way nobody can detect.
 */
const readStreams = () => readJson('streams.json');

// Claim a fresh batch of `count` unclaimed sheets into `set` (this page's queue).
// Over-asking fails with the true number still available, so nothing is claimed.
trainingRouter.post('/training/generate', requireObserver, (req, res) => {
  const set = Math.max(1, Math.floor(Number(req.body?.set) || 1));
  const count = Math.floor(Number(req.body?.count));
  const stream = req.body?.stream === 'audit' ? 'audit' : 'random';
  if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'bad_count' });
  let pool = poolFiles();

  // An audit claim names the sheets it wants; a random claim must not be
  // allowed to. Letting a caller hand-pick sheets into the `random` stream
  // would silently poison the only unbiased sample there is.
  if (stream === 'audit' && Array.isArray(req.body?.files)) {
    const want = new Set(req.body.files.map((f) => path.basename(String(f))));
    pool = pool.filter((f) => want.has(f));
    if (!pool.length) return res.status(400).json({ error: 'none_available', available: 0 });
  } else {
    // shuffle so a batch spans states/LGAs rather than one contiguous block
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  }
  if (count > pool.length) return res.status(400).json({ error: 'not_enough', available: pool.length });
  const claimed = pool.slice(0, count);
  const sets = readSets();
  for (const f of claimed) sets[f] = set;
  writeJson('sets.json', sets);
  const streams = readStreams();
  for (const f of claimed) streams[keyOf(f)] = stream;
  writeJson('streams.json', streams);
  res.status(201).json({ claimed: claimed.length, remaining: pool.length - count, stream });
});

/**
 * How the labelled set splits between the two streams.
 *
 * The number to watch is the RANDOM count: if it stops growing while the audit
 * count climbs, the calibration set is quietly becoming a catalogue of broken
 * sheets and no honest accuracy figure can be computed from it any more.
 */
trainingRouter.get('/training/streams', (req, res) => {
  const streams = readStreams();
  const truth = readTruth();
  const approved = readJson('approved.json');
  const tally = { random: { labelled: 0, approved: 0 }, audit: { labelled: 0, approved: 0 }, untagged: { labelled: 0, approved: 0 } };
  for (const key of Object.keys(truth)) {
    const s = streams[key] || 'untagged';
    const t = tally[s] || tally.untagged;
    t.labelled++;
    if (approved[key]) t.approved++;
  }
  // Said plainly rather than left for the reader to work out. There are two
  // ways this set stops supporting a rate, and the second one is already true:
  // every label written before stream tagging existed is UNTAGGED, so its
  // provenance is unrecoverable. A figure computed over a mostly-untagged set
  // is not a rate either, and the first version of this check said nothing
  // about that because it only compared audit against random — both zero.
  const warnings = [];
  if (tally.audit.approved > tally.random.approved * 2) {
    warnings.push('the approved set is dominated by audit-selected sheets — accuracy figures from it are not a rate');
  }
  const totalApproved = tally.random.approved + tally.audit.approved + tally.untagged.approved;
  if (tally.untagged.approved > totalApproved / 2) {
    warnings.push(`${tally.untagged.approved} of ${totalApproved} approved labels predate stream tagging — `
      + 'their provenance cannot be recovered, so treat any accuracy figure over the whole set as unattributable');
  }
  res.json({ tally, warnings, warning: warnings[0] || null });
});

// Skip a sheet as unusable (blank / no data) — drop it from every queue for good.
trainingRouter.post('/training/skip', requireObserver, (req, res) => {
  const key = String(req.body?.key || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!key) return res.status(400).json({ error: 'bad_key' });
  const dropped = readDropped();
  dropped[key] = true;
  writeJson('dropped.json', dropped);
  res.status(201).json({ ok: true, available: poolFiles().length });
});

trainingRouter.get('/training/ocr/:file', requireObserver, async (req, res) => {
  const f = path.join(dir(), path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not_found' });
  const r = await ocrMatchCounts(fs.readFileSync(f), [{ party: 'X', count: 1 }]);
  res.json({ tokens: r?.tokens || [] });
});

/**
 * The eight numbered summary boxes on an EC8A. Kept in a SIDECAR rather than in
 * truth.json, which holds party counts and is read by six other consumers
 * (score_vision, ocr_calibrate, learn_inec, score_hand_labels and both review
 * pages) — reshaping it to fit the audit would break all of them.
 */
const BOX_FIELDS = ['registered', 'accredited', 'ballotsIssued', 'unusedBallots',
  'spoiled', 'rejected', 'totalValid', 'usedBallots'];

trainingRouter.post('/training/label', requireObserver, (req, res) => {
  const key = String(req.body?.key || '').replace(/[^A-Za-z0-9_-]/g, '');
  const counts = req.body?.counts;
  const set = Math.max(1, Math.floor(Number(req.body?.set) || 1));
  if (!key || typeof counts !== 'object') return res.status(400).json({ error: 'bad_label' });
  const clean = {};
  for (const [p, c] of Object.entries(counts)) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) clean[String(p).toUpperCase().slice(0, 6)] = n;
  }
  const truth = readTruth();
  const isNew = !truth[key];              // re-saving a sheet never re-counts
  truth[key] = clean;
  writeJson('truth.json', truth);

  // ── WHAT THE AUDIT NEEDS THAT truth.json CANNOT HOLD ────────────────────
  //
  // Two things, and without them a human label cannot settle the sheets that
  // are actually stuck.
  //
  // `complete` — truth.json stores only NON-ZERO counts, so a party absent from
  // the map is ambiguous: it either polled nothing or was never looked at. The
  // audit's whole difficulty is that same conflation (a blank cell versus an
  // unreadable one), and a label that reproduces it resolves nothing. This flag
  // is the labeller asserting they read every row, which makes every unlisted
  // party a definite zero. Zeros are deliberately NOT written into truth.json:
  // that map's shape is load-bearing for six other consumers.
  //
  // `boxes` — most sheets still in review are held back by a summary box, not
  // by the party column. A label with no box in it cannot move them, however
  // carefully the party rows were read.
  const meta = readJson('label_meta.json');
  const entry = meta[key] || {};
  if (req.body?.complete === true) entry.complete = true;
  const boxes = req.body?.boxes;
  if (boxes && typeof boxes === 'object') {
    const cleanBoxes = {};
    for (const f of BOX_FIELDS) {
      const n = Number(boxes[f]);
      // A box may legitimately be 0 (spoiled papers usually are), so the test
      // is >= 0, not > 0. IMPLAUSIBLE values are rejected rather than stored:
      // a polling unit cannot have 600,000 registered voters, and letting one
      // in manufactures discrepancies downstream.
      if (Number.isInteger(n) && n >= 0 && n < 10000) cleanBoxes[f] = n;
    }
    if (Object.keys(cleanBoxes).length) entry.boxes = { ...(entry.boxes || {}), ...cleanBoxes };
  }
  if (typeof req.body?.note === 'string' && req.body.note.trim()) {
    entry.note = req.body.note.trim().slice(0, 400);
  }
  if (Object.keys(entry).length) { meta[key] = entry; writeJson('label_meta.json', meta); }

  const tally = readCounts();
  if (isNew) { tally[set] = Number(tally[set] || 0) + 1; writeJson('train_counts.json', tally); }
  res.status(201).json({
    ok: true, labelled: Object.keys(truth).length, mine: Number(tally[set] || 0),
    complete: Boolean(entry.complete), boxes: Object.keys(entry.boxes || {}).length,
  });
});

// ---- label QA (owner-only, from the review console) ------------------------
// approved.json is the quality gate: only APPROVED labels feed ML training/
// benchmarks. Denying a label deletes it and unclaims the sheet, so it returns
// to the open pool for fresh re-labeling by anyone.
trainingRouter.post('/training/approve', requireAdmin, (req, res) => {
  const key = String(req.body?.key || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!key || !readTruth()[key]) return res.status(400).json({ error: 'not_labelled' });
  const approved = readJson('approved.json');
  approved[key] = true;
  writeJson('approved.json', approved);
  res.status(201).json({ ok: true, approved: Object.keys(approved).length });
});

trainingRouter.post('/training/deny', requireAdmin, (req, res) => {
  const key = String(req.body?.key || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!key) return res.status(400).json({ error: 'bad_key' });
  const truth = readTruth();
  if (!truth[key]) return res.status(400).json({ error: 'not_labelled' });
  delete truth[key];
  writeJson('truth.json', truth);
  const approved = readJson('approved.json');
  delete approved[key];
  writeJson('approved.json', approved);
  const sets = readSets();
  for (const f of Object.keys(sets)) if (keyOf(f) === key) delete sets[f];
  writeJson('sets.json', sets);
  res.status(201).json({ ok: true, pool: poolFiles().length });
});

/**
 * THE THIRD EXIT: the sheet itself cannot be read.
 *
 * Deny has exactly one meaning — "this label is wrong" — and exactly one
 * effect: the label is deleted and the sheet goes back in the pool for the next
 * person to fail on identically. That is a loop, and on a genuinely illegible
 * scan it never terminates; it just spends a different person's afternoon each
 * time. Two reviewers hitting Deny on the same unreadable sheet is not quality
 * control, it is the same failure twice.
 *
 * `illegible` says something different and useful: the paper INEC published
 * cannot be read by a careful human at full resolution. That is not a failed
 * labeller and not a discrepancy in the result — it is a finding about the
 * QUALITY OF THE PUBLISHED RECORD, which is a legitimate thing for an audit of
 * a transparency portal to report. A citizen cannot verify what a citizen
 * cannot read.
 *
 * The sheet leaves every queue permanently, like `skip`, but is recorded with
 * its reason and reviewer rather than silently dropped — `dropped.json` means
 * "blank / no data", which is a different claim.
 */
trainingRouter.post('/training/illegible', requireAdmin, (req, res) => {
  const key = String(req.body?.key || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!key) return res.status(400).json({ error: 'bad_key' });
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  const by = String(req.body?.by || 'admin').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 60);

  const illegible = readJson('illegible.json');
  illegible[key] = { reason: reason || 'unreadable at full resolution', by, at: new Date().toISOString() };
  writeJson('illegible.json', illegible);

  // Remove any label so it cannot feed ML, and unclaim the sheet so it stops
  // occupying a queue — but do NOT return it to the claimable pool, which is
  // precisely the loop this route exists to break.
  const truth = readTruth();
  if (truth[key]) { delete truth[key]; writeJson('truth.json', truth); }
  const approved = readJson('approved.json');
  if (approved[key]) { delete approved[key]; writeJson('approved.json', approved); }
  const sets = readSets();
  let changed = false;
  for (const f of Object.keys(sets)) if (keyOf(f) === key) { delete sets[f]; changed = true; }
  if (changed) writeJson('sets.json', sets);
  const dropped = readDropped();
  dropped[key] = true;                    // keeps it out of poolFiles() for good
  writeJson('dropped.json', dropped);

  res.status(201).json({ ok: true, illegible: Object.keys(illegible).length });
});

trainingRouter.get('/training/illegible', requireAdmin, (req, res) => {
  const illegible = readJson('illegible.json');
  res.json({ count: Object.keys(illegible).length, items: illegible });
});

/**
 * The audit's internal working files, in one authenticated call.
 *
 * These are deliberately NOT reachable as static files under /training — see
 * the denylist in server.js. The review console needs all three to render a
 * card, so serving them together behind the admin passphrase is both tidier
 * than three public fetches and the only version compatible with keeping this
 * an internal evidence base.
 */
trainingRouter.get('/training/meta', requireAdmin, (req, res) => {
  res.json({
    labelMeta: readJson('label_meta.json'),
    streams: readStreams(),
    illegible: readJson('illegible.json'),
  });
});
