/**
 * The EC8A cell contract: a model must READ a cell, DECLARE it empty, or ABSTAIN.
 *
 *   node tests/ec8a-blank-contract.test.mjs
 *
 * WHY. The Osun party pass returned **0 nulls in 21,630 cells** while reporting
 * 10,983 figures cells (50.8%) as the empty string. The schema said
 * `['string','null']`, so `""` satisfied it — the model always had an answer that
 * was neither a reading nor an abstention, and it took it every time. Downstream
 * `""` is treated as a blank, which becomes a ZERO VOTE.
 *
 * 2,813 of those blanks are provably wrong: the words cell on the SAME ROW
 * carries a value. The officer wrote the number out; the model said the cell was
 * empty.
 *
 * So `""` is no longer schema-legal, and `BLANK` is the explicit empty token.
 * This pins all four states, including the two that are easy to break by
 * accident: a drawn dash must still mean zero, and the 10,983 legacy empty
 * strings already in the archive must still read as blanks.
 */
import assert from 'node:assert';
import { resolveRow } from '../backend/src/services/ec8a_verify.js';
import { partyTableSchema, auditSchema, BOXES_SCHEMA } from '../backend/src/services/ec8a_prompt.js';

// ---- 1. the schema must not accept an empty string --------------------------
function cellSchemasOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'figures' || k === 'words') && v && typeof v === 'object') out.push([k, v]);
    if (v && typeof v === 'object') cellSchemasOf(v, out);
  }
  return out;
}
const schemas = [];
for (const s of [partyTableSchema(['A', 'B']), auditSchema(['A', 'B'])]) schemas.push(...cellSchemasOf(s));
// the eight summary boxes are keyed by BOX_FIELDS, not figures/words, so check them directly
for (const [k, v] of Object.entries(BOXES_SCHEMA.properties || {})) schemas.push([k, v]);
assert.ok(schemas.length >= 4, `expected several cell schemas, found ${schemas.length}`);

const allowsEmptyString = (sch) => {
  if (sch.type && sch.minLength === undefined && String(sch.type).includes('string')) return true;
  const branches = sch.anyOf || sch.oneOf || [];
  return branches.some((b) => String(b.type).includes('string') && !(b.minLength >= 1));
};
for (const [name, sch] of schemas) {
  assert.ok(!allowsEmptyString(sch), `${name} still accepts "" — the model can skip both reading and abstaining`);
}
console.log(`  PASS  ${schemas.length} cell schemas reject the empty string`);

// CONTROL: the checker must FAIL on the old schema, or it proves nothing.
assert.ok(allowsEmptyString({ type: ['string', 'null'] }), 'CONTROL FAILED: old permissive schema not detected');
assert.ok(allowsEmptyString({ anyOf: [{ type: 'string' }, { type: 'null' }] }), 'CONTROL FAILED: unbounded anyOf not detected');
console.log('  PASS  control — the old permissive schema IS flagged');

// ---- 2. the four states resolve correctly downstream ------------------------
const R = (figures, words) => resolveRow({ party: 'A', figures, words }, { emptyMeansZero: true });

assert.strictEqual(R('110', 'ONE HUNDRED AND TEN').value, 110, 'a read cell must resolve to its number');
assert.strictEqual(R('BLANK', 'BLANK').value, 0, 'BLANK on both sides is a corroborated empty cell = 0');
assert.strictEqual(R(null, null).value, null, 'null on both sides is unread, NOT zero');
// The documented decoration rule must survive: a struck-through figure keeps it.
assert.strictEqual(R('-02-', 'TWO').value, 2, 'a decorated figure must keep its value');
// A drawn stroke alone is a written zero.
assert.strictEqual(R('—', 'NIL').value, 0, 'a lone stroke is a written zero');
// Legacy archive rows written under the old prompt must still read as blank.
assert.strictEqual(R('', '').value, 0, 'legacy "" must still resolve as a blank, not become unread');
console.log('  PASS  read / BLANK / null / decorated / stroke / legacy "" all resolve correctly');

// ---- 3. the failure that started this: blank figures, words carry a value ----
const disagree = R('BLANK', 'FIFTY');
assert.notStrictEqual(disagree.value, 0, 'an empty figures cell against a written FIFTY must NOT silently publish 0');
console.log(`  PASS  BLANK vs "FIFTY" does not publish a zero (value=${JSON.stringify(disagree.value)}, confidence=${disagree.confidence})`);

console.log('\nCell contract holds: reading, declaring empty and abstaining are three distinct answers.');
