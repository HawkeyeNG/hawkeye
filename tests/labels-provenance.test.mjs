/**
 * Labels must never be usable without knowing who wrote them.
 *
 *   node tests/labels-provenance.test.mjs
 *
 * Every accuracy figure this project has quoted traces to hand_labels.json,
 * whose own header says its labeller was "claude-opus-5 ... NOT an independent
 * human labeller". 16 of its 20 sheets came back identical to the machine's own
 * earlier output. A ruler drawn by the thing being measured is not a ruler.
 *
 * So this pins the three properties that stop that happening again: human blind
 * readings win, the FINAL reading is never used as truth, and a caller cannot
 * obtain labels without also obtaining their provenance.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLabels, humanOnly, labelsFromReviews, PROVENANCE } from '../backend/src/services/labels.js';

const BALLOT = ['A', 'AA', 'APC', 'PDP'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-'));
const w = (n, o) => { const p = path.join(tmp, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };

const reviewsPath = w('reviews.json', {
  'S1': {
    blind: { by: 7, at: 1, parties: { A: 110, APC: 90 }, boxes: { registered: 949, accredited: 217 } },
    // A DIFFERENT final, on purpose: if the loader ever prefers this, the test fails.
    final: { by: 7, parties: { A: 999, APC: 999 } },
  },
  'S2': { blind: null },                       // started, not committed
});
const handPath = w('hand_labels.json', {
  _labeller: 'claude-opus-5, NOT an independent human labeller',
  _ballot: BALLOT,
  S1: { registered: 1, figures: [1, 1, 1, 1] },   // must LOSE to the human reading
  S3: { registered: 500, figures: [5, 5, 5, 5] }, // no human read this one
});

const loaded = loadLabels({ reviewsPath, handLabelsPath: handPath, ballot: BALLOT });

// ---- 1. the human blind reading wins, and the FINAL is never used ----------
assert.strictEqual(loaded.labels.S1._provenance, PROVENANCE.HUMAN_BLIND);
assert.strictEqual(loaded.labels.S1.registered, 949, 'human boxes must win over hand_labels');
assert.deepStrictEqual(loaded.labels.S1.figures, [110, null, 90, null], 'ballot order, unfilled = null not 0');
assert.notStrictEqual(loaded.labels.S1.figures[0], 999, 'the FINAL reading must never be used as truth');
console.log('  PASS  human blind wins; the post-reveal final is never truth; unfilled is null, not zero');

// ---- 2. model-authored labels survive only where no human read, and are marked
assert.strictEqual(loaded.labels.S3._provenance, PROVENANCE.MACHINE_AUTHORED);
assert.ok(!('S2' in loaded.labels), 'an uncommitted blind reading is not a label');
assert.strictEqual(loaded.provenance[PROVENANCE.HUMAN_BLIND], 1);
assert.strictEqual(loaded.provenance[PROVENANCE.MACHINE_AUTHORED], 1);
console.log('  PASS  model-authored labels fill only the gaps, and are stamped');

// ---- 3. provenance cannot be avoided ---------------------------------------
assert.ok(loaded.provenance.note.includes('not an accuracy'), 'a mixed set must say so in words');
for (const v of Object.values(loaded.labels)) {
  assert.ok(v._provenance, 'every label carries its provenance');
}
const only = humanOnly(loaded);
assert.deepStrictEqual(Object.keys(only.labels), ['S1']);
console.log('  PASS  every label carries provenance; a mixed set says so; humanOnly filters');

// ---- controls: the checks must be able to fail -----------------------------
const noHuman = loadLabels({ reviewsPath: path.join(tmp, 'missing.json'), handLabelsPath: handPath, ballot: BALLOT });
assert.strictEqual(noHuman.provenance[PROVENANCE.HUMAN_BLIND], 0);
assert.ok(noHuman.provenance.note.startsWith('NO HUMAN LABELS'),
  'CONTROL FAILED: a set with no human labels must say so first, not bury it');
assert.strictEqual(Object.keys(humanOnly(noHuman).labels).length, 0,
  'CONTROL FAILED: humanOnly must return nothing when no human has read anything');
// A blind reading with no parties is not a label.
assert.deepStrictEqual(labelsFromReviews({ X: { blind: {} } }, BALLOT), {},
  'CONTROL FAILED: an empty blind reading became a label');
console.log('  PASS  3 controls — no-human says so first, humanOnly empties, empty blind is not a label');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nA figure can no longer be quoted without knowing whether a human produced its ruler.');
