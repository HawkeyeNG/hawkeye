#!/usr/bin/env node
/**
 * Build the human-review queue for the flagged Osun sheets: tier A, conflict-first.
 *
 * WHAT THIS IS FOR. 3,742 EC8A sheets were read by a vision model. The triage
 * put 495 of them (with images) in tier A — the ones where a check actually
 * failed. A person now re-reads each one, and the model's answer is compared
 * against theirs. The comparison is only worth having if the person read the
 * sheet WITHOUT being shown the model's answer first, which is why the
 * prediction is written to a separate file the reviewer's page cannot fetch
 * until their own reading is committed. See routes/training.js for that gate.
 *
 * WHY tier_a AND NOT pass1Verdict. `pass1Verdict` looks like the verdict field
 * and is not: it is carried forward from pass 1, byte-identical in vlm_merged
 * and vlm_stage0 (2104/996/642), and absent entirely from vlm_stage0b, which is
 * the current generation. Building a queue on it would review the sheets an
 * older model run was unsure about. The current verdicts were computed from
 * stage0b by the triage and materialised into tier_a/b/c.json.
 *
 * WHY tier_b IS EXCLUDED, AND MUST STAY EXCLUDED. tier_b is a 300-sheet stride
 * sample across all 3,742 — the only unbiased estimate of the model's accuracy
 * this project has. Reviewing it as part of a flagged stream turns a random
 * sample into a selected one, and nothing downstream can detect that
 * afterwards. tier_a and tier_c do not overlap at all (verified: a n c = 0),
 * so excluding B costs nothing.
 *
 * WHERE THE PREDICTION GOES. backend/storage/audit_review/, NOT
 * backend/storage/training/. server.js:243 serves the whole training directory
 * over the public web, and its AUDIT_INTERNAL denylist matches
 * path.basename(req.path) against three literal filenames — so a per-key file
 * inside that directory would not be protected by it. The queue's membership
 * is itself sensitive: it is a list of where we suspect problems, before a
 * human has confirmed a single one.
 *
 * Usage:  node backend/scripts/build_review_queue.mjs [--force]
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const AUDIT = path.join(ROOT, 'audits/2026-osun-governorship');
const OUT = path.join(ROOT, 'backend/storage/audit_review');
const PRED = path.join(OUT, 'pred');

const force = process.argv.includes('--force');

/** The generation the predictions come from. Stored on every record so a later
 *  regeneration cannot silently change what a reviewer was compared against. */
const SOURCE = 'vlm_stage0b.jsonl';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function readJsonl(p) {
  const out = new Map();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    out.set(r.file, r);
  }
  return out;
}

// ---------------------------------------------------------------- inputs
const tierA = readJson(path.join(AUDIT, 'tier_a.json'));
const vlm = readJsonl(path.join(AUDIT, SOURCE));
const sheetsDir = path.join(AUDIT, 'sheets');

const withImage = tierA.filter((t) => t.file);
const noImage = tierA.length - withImage.length;

// A sheet in the queue with no model record would be a blank card; a sheet with
// no image would be an empty frame. Neither should reach a reviewer.
const missingRec = withImage.filter((t) => !vlm.has(t.file)).map((t) => t.file);
const missingImg = withImage.filter((t) => !fs.existsSync(path.join(sheetsDir, t.file)))
  .map((t) => t.file);
if (missingRec.length) throw new Error(`no ${SOURCE} record for: ${missingRec.slice(0, 5).join(', ')}`);
if (missingImg.length) throw new Error(`no image on disk for: ${missingImg.slice(0, 5).join(', ')}`);

// Location, joined from the register. tier_a's with-image rows carry no
// location at all (only the 21 "no sheet published" rows do), and a reviewer
// needs to know which unit's sheet is in front of them — the same name, ward and
// LGA are printed on the sheet, so this anchors nothing. The register's pu_code
// is already the queue key's format: 29-04-04-010.
const db = new Database(path.join(ROOT, 'backend/storage/hawkeye.db'), { readonly: true });
const puRow = db.prepare(
  'SELECT pu_code, name, ward, lga FROM polling_units WHERE pu_code = ?',
);

// ------------------------------------------------------- shape a prediction
const keyOf = (file) => file.replace(/\.[^.]+$/, '');

function predictionFor(rec) {
  const rows = rec.verify?.rows ?? [];
  const byConfidence = {};
  for (const r of rows) {
    byConfidence[r.confidence] = (byConfidence[r.confidence] ?? 0) + 1;
  }
  return {
    key: keyOf(rec.file),
    file: rec.file,
    source: SOURCE,
    /** The model's per-party reading. `value` is what it settled on; null where
     *  it could not. `confidence` says which of its two readings supported it. */
    parties: rows.map((r) => ({
      party: r.party,
      value: r.value ?? null,
      figures: r.figures ?? null,
      words: r.words ?? null,
      confidence: r.confidence ?? null,
    })),
    boxes: rec.sheet
      ? {
        registered: rec.sheet.registered ?? null,
        accredited: rec.sheet.accredited ?? null,
        ballotsIssued: rec.sheet.ballotsIssued ?? null,
        unusedBallots: rec.sheet.unusedBallots ?? null,
        spoiled: rec.sheet.spoiled ?? null,
        rejected: rec.sheet.rejected ?? null,
        totalValid: rec.sheet.totalValid ?? null,
        usedBallots: rec.sheet.usedBallots ?? null,
      }
      : null,
    boxMeta: rec.boxMeta ?? null,
    /** Sheet-level defects the triage found. `rowIntegrity` in particular can be
     *  OUR OWN error rather than INEC's — duplicated rows produced by the model
     *  — so it is surfaced to the reviewer as a caution, not as a finding. */
    defects: {
      rowIntegrity: rec.rowIntegrity ?? null,
      adjudicated: rec.adjudicated ?? null,
      implausible: rec.implausible ?? null,
      promptLeak: rec.promptLeak ?? null,
    },
    confidenceCounts: byConfidence,
  };
}

// ------------------------------------------------------------ order the queue
function priority(pred) {
  const c = pred.confidenceCounts;
  return {
    conflict: c.conflict ?? 0,
    contested: c.contested ?? 0,
    unread: (c.empty ?? 0) + (c.none ?? 0),
    single: (c.figures ?? 0) + (c.words ?? 0),
  };
}

fs.mkdirSync(PRED, { recursive: true });

const existingReviews = (() => {
  const p = path.join(OUT, 'reviews.json');
  return fs.existsSync(p) ? readJson(p) : {};
})();

const entries = [];
const unlocated = [];
let wrote = 0;
let skippedReviewed = 0;

for (const t of withImage) {
  const rec = vlm.get(t.file);
  const pred = predictionFor(rec);
  const key = pred.key;

  // A prediction a reviewer has already been compared against must not change
  // underneath the stored comparison.
  const dest = path.join(PRED, `${key}.json`);
  const keep = existingReviews[key] && fs.existsSync(dest) && !force;
  const body = JSON.stringify(pred, null, 1);
  if (keep) {
    skippedReviewed += 1;
  } else {
    fs.writeFileSync(dest, body);
    wrote += 1;
  }

  // Hash the exact bytes ON DISK, not the freshly computed object. When a
  // prediction is preserved because it has already been reviewed against, the
  // two differ — and stamping the new hash onto the old file would quietly
  // break the one record of which prediction a reviewer was shown.
  const onDisk = keep ? fs.readFileSync(dest, 'utf8') : body;

  const p = priority(pred);
  const loc = puRow.get(key);
  if (!loc) unlocated.push(key);

  // Everything the triage knows about WHY this sheet was flagged — including its
  // numbers (excess/cast/accredited, margin/leader/runnerUp). This is stored
  // server-side but must NOT reach a reviewer before they commit their own
  // reading: "over-voting, excess 211" hands them a number to agree with.
  // routes/training.js decides what leaves the server; see reviewSafe().
  const { file: _f, ...triage } = t;

  entries.push({
    key,
    file: t.file,
    tier: 'a',
    // Safe to show up front — it is printed on the sheet itself.
    lga: loc?.lga ?? null,
    ward: loc?.ward ?? null,
    name: loc?.name ?? null,
    // Withheld until a blind reading is committed.
    triage,
    priority: p,
    predHash: crypto.createHash('sha256').update(onDisk).digest('hex').slice(0, 16),
  });
}

// Conflict-first, then the model's other uncertainties, then filename so the
// order is stable across rebuilds — an unstable queue makes "who reviewed what
// first" unanswerable.
entries.sort((a, b) =>
  b.priority.conflict - a.priority.conflict
  || b.priority.contested - a.priority.contested
  || b.priority.unread - a.priority.unread
  || b.priority.single - a.priority.single
  || a.key.localeCompare(b.key));

// The ballot. Every sheet in this election carries the same 15 pre-printed party
// rows, so the LIST is public information — it is what a voter saw. Only the
// counts are the answer being withheld. Handing reviewers the 15 labelled rows
// saves them typing party codes 495 times and, more importantly, stops a row
// being silently skipped because nobody thought to add it.
const ballot = [...new Set(
  [...vlm.values()].flatMap((r) => (r.verify?.rows ?? []).map((x) => x.party).filter(Boolean)),
)].sort();
const perSheet = new Set(entries.map((e) => {
  const rec = vlm.get(e.file);
  return (rec.verify?.rows ?? []).map((x) => x.party).filter(Boolean).sort().join(',');
}));
if (perSheet.size !== 1) {
  console.log(`  NOTE: sheets do not all carry the same party list (${perSheet.size} variants);`
    + ' the union is used, so a reviewer may see a row that is not on their sheet.');
}

fs.writeFileSync(path.join(OUT, 'queue.json'), JSON.stringify({
  built: null, // stamped by the caller; Date.now() is avoided so rebuilds diff cleanly
  source: SOURCE,
  tier: 'a',
  note: 'tier_b is deliberately excluded: it is the only unbiased accuracy sample.',
  ballot,
  count: entries.length,
  entries,
}, null, 1));

// ------------------------------------------------------------------- report
const conflictSheets = entries.filter((e) => e.priority.conflict > 0).length;
console.log(`tier A rows:            ${tierA.length}`);
console.log(`  with an image:        ${withImage.length}`);
console.log(`  no sheet published:   ${noImage}  (skipped — nothing to review)`);
console.log(`predictions written:    ${wrote}`);
if (skippedReviewed) console.log(`  left alone (reviewed): ${skippedReviewed}  (use --force to overwrite)`);
console.log(`queue length:           ${entries.length}`);
console.log(`  with a conflict row:  ${conflictSheets}`);
console.log(`  located via register: ${entries.length - unlocated.length}/${entries.length}`);
if (unlocated.length) console.log(`  NOT located: ${unlocated.slice(0, 5).join(', ')}`);
console.log(`\nfirst 5 in review order:`);
for (const e of entries.slice(0, 5)) {
  console.log(`  ${e.key}  conflict=${e.priority.conflict} contested=${e.priority.contested} `
    + `unread=${e.priority.unread}  ${e.lga} / ${e.ward} / ${e.name}`);
}
console.log(`\npredictions -> ${path.relative(ROOT, PRED)}/`);
console.log(`queue       -> ${path.relative(ROOT, path.join(OUT, 'queue.json'))}`);
