/**
 * Publish the EC8A summary boxes to the review console.
 *
 *   node scripts/sync_label_boxes.mjs
 *
 * truth.json holds party counts and nothing else, and reshaping it would break
 * ocr_calibrate.js, score_vision.js, learn_inec.js and the training route all at
 * once. So the boxes ride alongside in storage/training/boxes.json, which the
 * static /training mount already serves and which nothing else reads.
 *
 * Re-run after editing hand_labels.json - a denied label means a number in there
 * was wrong, and the card must show the corrected one.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'storage/audit-osun2026/hand_labels.json';
const OUT = 'storage/training/boxes.json';
const FIELDS = ['registered', 'accredited', 'spoiled', 'rejected', 'totalValid', 'usedBallots'];

const labels = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

let written = 0;
for (const [key, L] of Object.entries(labels)) {
  if (key.startsWith('_')) continue;
  const box = {};
  for (const f of FIELDS) if (Number.isInteger(L[f])) box[f] = L[f];
  // Carry the note through: it is the reviewer's fastest route to "why does this
  // one look odd?" - a blank cell, an angled photo, a genuine anomaly.
  if (L._anomaly) box.note = L._anomaly;
  else if (L._note) box.note = L._note;
  box.source = 'claude';
  existing[key] = box;
  written++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(existing, null, 1));
console.log(`wrote ${written} sheet(s) to ${OUT} (${Object.keys(existing).length} total)`);
