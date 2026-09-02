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

// ═══════════════════════════════════════════════════════════════════════════
// FLAGGED-SHEET REVIEW (Osun 2026 audit, tier A)
//
// A different job from the labelling above. Labelling builds a calibration set
// from unseen sheets; this re-reads the 495 sheets the audit's own checks
// FAILED on, to establish what each one actually says.
//
// BLIND FIRST. The reviewer is shown the sheet and nothing else. Only once
// their own reading is committed does the server release the machine's — and
// the commit is immutable, so the two can be compared honestly. This is not
// ceremony: the 20 sheets in hand_labels.json were labelled by a model shown
// its own earlier output, 16 of the 20 came back byte-identical, and the "97.7%
// correct" figure computed from them is an agreement rate wearing an accuracy's
// clothes. A reviewer shown a plausible number agrees with it; that is what
// anchoring is, and it is silent.
//
// WHAT IS WITHHELD. Not just the predicted counts — also the triage's reason
// and its arithmetic ("over-voting, excess 211", "margin 44, leader APC").
// Those name the answer as surely as the counts do.
//
// WHERE IT LIVES. storage/audit_review/, deliberately NOT storage/training/:
// server.js:243 serves the whole training directory publicly, and its
// AUDIT_INTERNAL denylist matches path.basename against three literal
// filenames, so per-key files placed there would not be covered by it.
// ═══════════════════════════════════════════════════════════════════════════

const REVIEW_SETS = 4; // train.html, train2.html, trainderek.html, traindavina.html

const reviewDir = () => {
  const d = path.join(path.dirname(config.dbPath), 'audit_review');
  fs.mkdirSync(path.join(d, 'pred'), { recursive: true });
  return d;
};
// A MISSING file is empty; an UNREADABLE one is an error. Swallowing both would
// turn a corrupt reviews.json into "nobody has reviewed anything", and the very
// next write would truncate the file and replace every stored review with one
// record. Committed readings are immutable and have no repair path, so that loss
// is permanent — let it throw instead.
const reviewJson = (name, fallback) => {
  const p = path.join(reviewDir(), name);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

// Write to a sibling temp file and rename, so a crash or a full disk mid-write
// leaves the previous file intact rather than a truncated one. rename(2) within
// a directory is atomic.
const writeReviewJson = (name, obj) => {
  const dest = path.join(reviewDir(), name);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, dest);
};

/** Reviewers are named explicitly. `requireObserver` admits anyone who passed a
 *  phone OTP — the same credential used to file an ordinary field report — and
 *  these endpoints write the audit's evidence base, immutably and with no delete
 *  route. Fails CLOSED when unset: an unconfigured deployment must not quietly
 *  accept audit readings from the public. Set REVIEW_OBSERVER_IDS=7,12,19,23. */
const REVIEW_IDS = new Set(
  String(process.env.REVIEW_OBSERVER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const requireReviewer = (req, res, next) => {
  if (!REVIEW_IDS.size) {
    return res.status(403).json({ error: 'reviewers_not_configured', hint: 'set REVIEW_OBSERVER_IDS' });
  }
  if (!REVIEW_IDS.has(String(req.observer.id))) return res.status(403).json({ error: 'not_a_reviewer' });
  return next();
};

const readQueue = () => reviewJson('queue.json', { entries: [] });
const readReviews = () => reviewJson('reviews.json', {});

// The sheet images stay in the audit tree; they are not copied into the public
// training mount. Resolved from dbPath so it follows a relocated storage dir.
const sheetsDir = () => path.join(
  path.dirname(path.dirname(path.dirname(config.dbPath))),
  'audits', '2026-osun-governorship', 'sheets',
);

const cleanKey = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

/** Sheets are striped across the four pages by queue position, so two reviewers
 *  never draw the same sheet and no lease/claim bookkeeping is needed. The queue
 *  is already conflict-first, so each stripe is conflict-first too. */
const setForIndex = (i) => (i % REVIEW_SETS) + 1;

/** Everything a reviewer may see BEFORE committing a reading. Location is on
 *  the sheet in front of them, so it anchors nothing and confirms they have the
 *  right unit. Note what is absent: verdict, why, triage numbers, priority. */
const reviewSafe = (e, i) => ({
  key: e.key,
  file: e.file,
  lga: e.lga,
  ward: e.ward,
  name: e.name,
  set: setForIndex(i),
});

// Both sanitisers REPORT what they refused rather than dropping it silently. A
// dropped cell used to vanish from the immutable blind record while the browser
// went on showing the reviewer their own typed value — and at the final it was
// scored as `dropped`, the bucket that means "the model invented a figure the
// human could not find". A typo would have been filed as evidence against the
// model. Refusing the request instead lets the reviewer fix it while nothing is
// committed yet.
const cleanParties = (obj) => {
  const out = {};
  const bad = [];
  if (!obj || typeof obj !== 'object') return { out, bad };
  for (const [p, c] of Object.entries(obj)) {
    const n = Number(c);
    // Unlike truth.json, an explicit 0 is KEPT here: "this party polled nothing"
    // and "this row was never read" are the exact distinction the audit is stuck
    // on, and collapsing them again would waste the review.
    if (Number.isInteger(n) && n >= 0 && n < 100000) out[String(p).toUpperCase().slice(0, 6)] = n;
    else bad.push(String(p).toUpperCase().slice(0, 6));
  }
  return { out, bad };
};

const cleanBoxes = (obj) => {
  const out = {};
  const bad = [];
  if (!obj || typeof obj !== 'object') return { out, bad };
  for (const f of BOX_FIELDS) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') continue;
    const n = Number(obj[f]);
    if (Number.isInteger(n) && n >= 0 && n < 10000) out[f] = n;
    else bad.push(f);
  }
  return { out, bad };
};

// ---- the queue ------------------------------------------------------------
trainingRouter.get('/training/review/queue', requireObserver, requireReviewer, (req, res) => {
  const q = readQueue();
  const reviews = readReviews();
  const want = Math.min(REVIEW_SETS, Math.max(1, Math.floor(Number(req.query.set) || 1)));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit) || 25)));

  const me = req.observer.id;
  const mine = q.entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => setForIndex(i) === want);
  // Two reasons a sheet is not pending for THIS reviewer: it is settled, or
  // someone else committed the blind reading on it. The second matters because
  // the reveal and the final are ownership-bound — serving such a sheet would
  // hand the reviewer a card they can never submit, and because the queue only
  // drops a sheet once it has a final, it would sit at the head of their queue
  // for good.
  const pending = mine.filter(({ e }) => {
    const r = reviews[e.key];
    if (r?.final) return false;
    return !r?.blind || r.blind.by === me;
  });

  res.json({
    set: want,
    // The 15 pre-printed party rows. Public — it is what was on the ballot —
    // and giving reviewers the labelled rows stops one being silently skipped.
    ballot: q.ballot || [],
    total: q.entries.length,
    mineTotal: mine.length,
    mineDone: mine.length - pending.length,
    doneAll: Object.values(reviews).filter((r) => r?.final).length,
    items: pending.slice(0, limit).map(({ e, i }) => ({
      ...reviewSafe(e, i),
      // Says only that THIS reviewer already locked a reading for this sheet —
      // never what it said, and never anything about the machine's. Lets the
      // page resume at the comparison instead of asking them to read it twice.
      resume: reviews[e.key]?.blind?.by === me,
    })),
  });
});

// ---- the sheet image ------------------------------------------------------
// Served through the API behind auth rather than from the public static mount:
// queue membership is a list of where we suspect a problem, before a human has
// confirmed one.
trainingRouter.get('/training/review/sheet/:key', requireObserver, requireReviewer, (req, res) => {
  const key = cleanKey(req.params.key);
  const entry = readQueue().entries.find((e) => e.key === key);
  if (!entry) return res.status(404).json({ error: 'not_in_queue' });
  const p = path.join(sheetsDir(), path.basename(entry.file));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'no_sheet' });
  res.type('image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(p).pipe(res);
});

// ---- 1. commit the blind reading (immutable) ------------------------------
trainingRouter.post('/training/review/blind', requireObserver, requireReviewer, (req, res) => {
  const key = cleanKey(req.body?.key);
  const entry = readQueue().entries.find((e) => e.key === key);
  if (!entry) return res.status(404).json({ error: 'not_in_queue' });

  const reviews = readReviews();
  // Immutable by design. If re-submission were allowed, a reviewer could read
  // the machine's answer and then quietly restate their own to match it, which
  // is precisely the measurement this endpoint exists to protect.
  if (reviews[key]?.blind) return res.status(409).json({ error: 'blind_already_committed' });

  const { out: parties, bad: badParties } = cleanParties(req.body?.parties);
  const { out: boxes, bad: badBoxes } = cleanBoxes(req.body?.boxes);
  // Refuse BEFORE writing: the blind reading is immutable, so a partial one
  // cannot be corrected afterwards.
  if (badParties.length || badBoxes.length) {
    return res.status(400).json({ error: 'out_of_range', fields: [...badParties, ...badBoxes] });
  }
  if (!Object.keys(parties).length && !Object.keys(boxes).length && req.body?.unreadable !== true) {
    return res.status(400).json({ error: 'empty_reading' });
  }

  reviews[key] = {
    ...(reviews[key] || {}),
    blind: {
      parties,
      boxes,
      // The reviewer asserting they read every row, which turns every party
      // absent from `parties` into a definite zero rather than an unknown.
      complete: req.body?.complete === true,
      // Some sheets genuinely cannot be read — that is a finding, not a failure.
      unreadable: req.body?.unreadable === true,
      by: req.observer.id,
      at: new Date().toISOString(),
      // Client-reported, so treat as a smoke alarm rather than evidence: a
      // four-second "reading" of a 18-row sheet did not happen.
      clientMs: Math.max(0, Math.floor(Number(req.body?.ms) || 0)) || null,
    },
  };
  writeReviewJson('reviews.json', reviews);
  res.status(201).json({ ok: true, key });
});

// ---- 2. release the machine's reading (gated on step 1) -------------------
trainingRouter.get('/training/review/pred/:key', requireObserver, requireReviewer, (req, res) => {
  const key = cleanKey(req.params.key);
  const entry = readQueue().entries.find((e) => e.key === key);
  if (!entry) return res.status(404).json({ error: 'not_in_queue' });

  const reviews = readReviews();
  // THE GATE. Everything else in this feature is arrangement; this is the part
  // that makes the comparison mean something.
  //
  // It is keyed on the REVIEWER, not on the sheet. Testing only that some blind
  // reading exists would mean the first person to commit unlocks the machine's
  // answer for everyone else — so a second reviewer could read it, then author
  // the sheet's settled reading having seen it, and `humanChangedAfterReveal`
  // would compare against the FIRST reviewer's numbers and report clean. The
  // property this feature exists to guarantee would then hold only by the
  // accident of one person ever touching a sheet.
  const blind = reviews[key]?.blind;
  if (!blind) return res.status(409).json({ error: 'blind_reading_required' });
  if (blind.by !== req.observer.id) return res.status(403).json({ error: 'not_your_reading' });

  let pred;
  try {
    pred = JSON.parse(fs.readFileSync(path.join(reviewDir(), 'pred', `${key}.json`), 'utf8'));
  } catch { return res.status(404).json({ error: 'no_prediction' }); }

  // Stamp which prediction was shown, so a later rebuild cannot change what the
  // reviewer was actually compared against.
  if (!reviews[key].pred) {
    reviews[key].pred = { hash: entry.predHash, source: pred.source, shownAt: new Date().toISOString() };
    writeReviewJson('reviews.json', reviews);
  }

  res.json({
    key,
    prediction: pred,
    // Released together with the prediction, for the same reason: it names the
    // answer. `rowIntegrity` in particular may be OUR duplication bug rather
    // than anything wrong with INEC's sheet.
    triage: entry.triage,
    blind: reviews[key].blind,
  });
});

// ---- 3. the settled reading ----------------------------------------------
trainingRouter.post('/training/review/final', requireObserver, requireReviewer, (req, res) => {
  const key = cleanKey(req.body?.key);
  const entry = readQueue().entries.find((e) => e.key === key);
  if (!entry) return res.status(404).json({ error: 'not_in_queue' });

  const reviews = readReviews();
  const rec = reviews[key];
  if (!rec?.blind) return res.status(409).json({ error: 'blind_reading_required' });
  // Only the person who committed the blind reading may settle the sheet. Without
  // this, someone who read the machine's answer first could author the final.
  if (rec.blind.by !== req.observer.id) return res.status(403).json({ error: 'not_your_reading' });
  if (rec.final) return res.status(409).json({ error: 'already_final' });

  const { out: parties, bad: badParties } = cleanParties(req.body?.parties);
  const { out: boxes, bad: badBoxes } = cleanBoxes(req.body?.boxes);
  if (badParties.length || badBoxes.length) {
    return res.status(400).json({ error: 'out_of_range', fields: [...badParties, ...badBoxes] });
  }

  // Agreement is computed HERE, from the two stored readings — never taken from
  // the client. It is the output of the whole exercise, and a client-supplied
  // "yes I agreed" would be worth nothing.
  let pred = null;
  try {
    pred = JSON.parse(fs.readFileSync(path.join(reviewDir(), 'pred', `${key}.json`), 'utf8'));
  } catch { /* prediction missing; agreement stays null */ }

  let agreement = null;
  if (pred) {
    // The model's row list includes rows it could NOT read (value null). Scoring
    // those as disagreements would reproduce, inside this very metric, the
    // blank-versus-unread conflation the review exists to resolve: "the model
    // said 98 and the human said 55" and "the model read nothing and the human
    // read 0" are different events and are counted separately below.
    const machine = {};
    const unread = new Set();
    for (const row of pred.parties || []) {
      if (!row.party) continue;
      const p = String(row.party).toUpperCase().slice(0, 6);
      if (row.value === null || row.value === undefined) unread.add(p);
      else machine[p] = Number(row.value);
    }
    const human = rec.blind.parties;
    let same = 0;
    const differs = []; const added = []; const dropped = [];
    for (const p of new Set([...Object.keys(machine), ...Object.keys(human)])) {
      const m = machine[p]; const h = human[p];
      if (m !== undefined && h !== undefined) {
        if (m === h) same += 1; else differs.push({ party: p, machine: m, human: h });
      } else if (m === undefined) {
        // The human read a row the model could not. This is the review's whole
        // point, and it is coverage gained — never an accuracy loss.
        added.push({ party: p, human: h, machineUnread: unread.has(p) });
      } else {
        // The model produced a number the human could not find on the sheet.
        dropped.push({ party: p, machine: m });
      }
    }
    agreement = {
      // The denominator is only the cells BOTH of them read, so the rate means
      // "when they both had an answer, how often did it match".
      parties: { compared: same + differs.length, same, differs, added, dropped },
      // Did seeing the machine's answer change the reviewer's mind? A high rate
      // here is the anchoring signal to watch.
      humanChangedAfterReveal: JSON.stringify(parties) !== JSON.stringify(rec.blind.parties)
        || JSON.stringify(boxes) !== JSON.stringify(rec.blind.boxes),
    };
  }

  rec.final = {
    parties,
    boxes,
    complete: req.body?.complete === true,
    unreadable: req.body?.unreadable === true,
    note: typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 400) : null,
    by: req.observer.id,
    at: new Date().toISOString(),
  };
  rec.agreement = agreement;
  reviews[key] = rec;
  writeReviewJson('reviews.json', reviews);

  const done = Object.values(reviews).filter((r) => r?.final).length;
  res.status(201).json({ ok: true, key, agreement, done, total: readQueue().entries.length });
});

// ---- progress, for the console -------------------------------------------
trainingRouter.get('/training/review/stats', requireAdmin, (req, res) => {
  const q = readQueue();
  const reviews = readReviews();
  const finals = Object.entries(reviews).filter(([, r]) => r?.final);
  let agreed = 0; let compared = 0; let changed = 0;
  let added = 0; let dropped = 0;
  const fast = [];
  for (const [key, r] of finals) {
    if (r.agreement) {
      agreed += r.agreement.parties.same;
      compared += r.agreement.parties.compared;
      added += r.agreement.parties.added.length;
      dropped += r.agreement.parties.dropped.length;
      if (r.agreement.humanChangedAfterReveal) changed += 1;
    }
    if (r.blind?.clientMs && r.blind.clientMs < 15000) fast.push({ key, ms: r.blind.clientMs });
  }
  res.json({
    total: q.entries.length,
    blind: Object.values(reviews).filter((r) => r?.blind).length,
    final: finals.length,
    partyCellsCompared: compared,
    partyCellsAgreed: agreed,
    agreementRate: compared ? Number((agreed / compared).toFixed(4)) : null,
    // Rows the human read that the model could not — the reason for doing this
    // at all. Reported separately so they can never inflate the rate above.
    rowsRecovered: added,
    // Rows the model produced that the human could not find. A rising number
    // here means the model is inventing figures, which is the worse failure.
    rowsUnsupported: dropped,
    changedAfterReveal: changed,
    // Not an accusation — a queue to look at. A sheet read in eight seconds may
    // have been blank, or may not have been read.
    suspiciouslyFast: fast.sort((a, b) => a.ms - b.ms).slice(0, 20),
  });
});
