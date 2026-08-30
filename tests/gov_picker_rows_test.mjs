/**
 * THE GOVERNORSHIP STATE LIST — the contest is a floor the register may widen.
 *
 * govRows() decides which states the one-step governorship picker offers and
 * which carry the "off-cycle" tag. Its first version read
 *   names = universe.length ? universe : inCycle
 * which let the widening step SHRINK the list: a state the contest names but
 * the register's stateStats does not would vanish a moment after appearing, and
 * a reader in that state would conclude their race did not exist.
 *
 * That is the case a live check could never catch, because on today's data the
 * two lists agree. So it is pinned here against synthetic disagreement, with
 * the real data files as the control.
 *
 * Run: node tests/gov_picker_rows_test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../app/race-picker.js', import.meta.url), 'utf8');

// Lift the real govRows + norm out of the IIFE rather than restating them, so
// this cannot pass against a file that no longer behaves this way.
const grab = (name) => {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name}() not found in app/race-picker.js`);
  let i = SRC.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
};
const normSrc = /function norm\(s\) \{[^}]*\}/.exec(SRC)?.[0]
  ?? 'function norm(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"");}';
// eslint-disable-next-line no-new-func
const govRows = new Function(`${normSrc}\n${grab('govRows')}\nreturn govRows;`)();

let fail = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${label}\n        ${e.message}`);
  }
};
const names = (rows) => rows.map((r) => (typeof r === 'string' ? r : r.name));
const tagged = (rows) => rows.filter((r) => typeof r !== 'string').map((r) => r.name);

console.log('=== the real data (control) ===');
const contests = JSON.parse(fs.readFileSync(new URL('../backend/src/data/contests.json', import.meta.url), 'utf8'));
const gov = (Array.isArray(contests) ? contests : contests.contests).find((c) => c.code === 'GOV');
const pd = JSON.parse(fs.readFileSync(new URL('../app/political_data.json', import.meta.url), 'utf8'));
const universe = Object.keys(pd.stateStats ?? {});
const real = govRows(gov.states, universe);

check('offers 36 states (37 in the register, minus FCT)', () => {
  assert.strictEqual(real.length, 36, `got ${real.length}`);
});
check('tags exactly the 8 off-cycle governorships', () => {
  assert.deepStrictEqual(
    tagged(real).sort(),
    ['Anambra', 'Bayelsa', 'Edo', 'Ekiti', 'Imo', 'Kogi', 'Ondo', 'Osun'],
  );
});
check('never offers FCT — there is no governor to elect', () => {
  assert.ok(!names(real).some((n) => /^f\.?c\.?t\.?$/i.test(n) || /federal capital/i.test(n)));
});
check('every one of the contest\'s own states is present and UNtagged', () => {
  const off = new Set(tagged(real));
  for (const s of gov.states) {
    assert.ok(names(real).includes(s), `${s} missing from the picker`);
    assert.ok(!off.has(s), `${s} wrongly tagged off-cycle`);
  }
});

console.log('\n=== the regression: the register must not be able to SHRINK the list ===');
check('a contest state absent from the register still appears, untagged', () => {
  // Kano in the contest, missing from stateStats — the replace bug dropped it.
  const thin = universe.filter((s) => s !== 'Kano');
  const rows = govRows(gov.states, thin);
  assert.ok(names(rows).includes('Kano'), 'Kano was dropped by the widening step');
  assert.ok(!tagged(rows).includes('Kano'), 'Kano was tagged off-cycle');
});
check('an EMPTY register leaves the contest\'s own states intact', () => {
  const rows = govRows(gov.states, []);
  assert.strictEqual(rows.length, gov.states.length);
  assert.strictEqual(tagged(rows).length, 0);
});
check('a null register behaves the same', () => {
  assert.strictEqual(govRows(gov.states, null).length, gov.states.length);
});
check('a register that spells a contest state differently does not duplicate it', () => {
  const rows = govRows(['Akwa Ibom'], ['Akwa-Ibom', 'Lagos']);
  assert.deepStrictEqual(names(rows).filter((n) => /akwa/i.test(n)).length, 1,
    `Akwa Ibom appeared twice: ${JSON.stringify(names(rows))}`);
  assert.ok(!tagged(rows).some((n) => /akwa/i.test(n)), 'the contest\'s own state was tagged');
});
check('the spelt-out FCT is excluded too', () => {
  const rows = govRows(['Lagos'], ['Lagos', 'Federal Capital Territory', 'FCT']);
  assert.deepStrictEqual(names(rows), ['Lagos']);
});
check('membership is not answered by Object.prototype', () => {
  // norm() strips non-alphanumerics, so a hostile or odd name could land on a
  // prototype key. With a bare {} this returned truthy and mis-tagged it.
  const rows = govRows([], ['constructor', 'Lagos']);
  assert.deepStrictEqual(tagged(rows).sort(), ['Lagos', 'constructor'],
    'a prototype key was read as an in-cycle state');
});

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
