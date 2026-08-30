/**
 * TWO NATIVE UI RULES, PINNED AGAINST THE SOURCE.
 *
 * native/ has no test runner (no jest, no vitest), so these read the actual
 * expressions out of the .tsx and evaluate them — the same technique as
 * fetchdata_scheme_test.mjs. It is not a substitute for running the app, but it
 * does catch the two specific regressions below, neither of which is visible
 * to tsc or eslint.
 *
 * 1. THE CHOOSER FLASH. Tapping an election card on Home pushes the Results tab
 *    with ?contest=…&n=…, but applyLink() cannot act until the catalogue
 *    arrives. Until then race and wholeContest are both null, so the screen
 *    decided nothing had been chosen and painted the full contest CHOOSER —
 *    "Rank a single seat instead" — for a few frames before the board it was
 *    asked for. Reported on Android and iOS.
 *
 * 2. THE STAT STRIP. Every cell had flex-1, so "31" got exactly as much room as
 *    "6 Feb 2027". On a 390pt phone that is ~71pt a cell against ~85pt of bold
 *    date, and the date truncated to "6 Feb 2..." beside a half-empty column.
 *
 * Run: node tests/native_race_ui_test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';

const RESULTS = fs.readFileSync(new URL('../native/src/app/(tabs)/results.tsx', import.meta.url), 'utf8');
const RACE = fs.readFileSync(new URL('../native/src/components/race.tsx', import.meta.url), 'utf8');

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

// ── 1. the chooser flash ────────────────────────────────────────────────────
const pendingSrc = /const linkPending =\s*([\s\S]*?);\n/.exec(RESULTS)?.[1];
const choosingSrc = /const choosing = ([^;]+);/.exec(RESULTS)?.[1];
assert.ok(pendingSrc, 'linkPending not found in results.tsx');
assert.ok(choosingSrc, 'choosing not found in results.tsx');
console.log(`  linkPending = ${pendingSrc.replace(/\s+/g, ' ').trim()}`);
console.log(`  choosing    = ${choosingSrc.trim()}`);

/** Evaluate the REAL expressions against a simulated screen state. */
function isChoosing({ picking = false, race = null, wholeContest = null, linkContest, linkScope, linkNonce, appliedKey = null }) {
  const scope = `const picking=${JSON.stringify(picking)},race=${JSON.stringify(race)},`
    + `wholeContest=${JSON.stringify(wholeContest)},linkContest=${JSON.stringify(linkContest ?? undefined)},`
    + `linkScope=${JSON.stringify(linkScope ?? undefined)},linkNonce=${JSON.stringify(linkNonce ?? undefined)},`
    + `appliedKey=${JSON.stringify(appliedKey)};`;
  // eslint-disable-next-line no-new-func
  return Function(`${scope}
    const nothingChosen = !race && !wholeContest;
    const linkPending = ${pendingSrc};
    return (${choosingSrc});`)();
}

console.log('\n=== the flash: a link on its way in must NOT paint the chooser ===');
check('catalogue still loading, link inbound -> no chooser', () => {
  assert.strictEqual(
    isChoosing({ linkContest: 'GOV', linkNonce: '123', appliedKey: null }), false,
    'the chooser would flash while /api/contests is in flight',
  );
});
check('the one frame after the catalogue lands, before applyLink -> no chooser', () => {
  // contests are loaded but applyLink has not run yet: appliedKey is still null.
  assert.strictEqual(isChoosing({ linkContest: 'GOV', linkNonce: '123', appliedKey: null }), false);
});
check('link applied and resolved to a board -> no chooser', () => {
  assert.strictEqual(
    isChoosing({ linkContest: 'GOV', linkNonce: '123', appliedKey: 'GOV||123', wholeContest: 'GOV' }),
    false,
  );
});

console.log('\n=== ...but the chooser must still be reachable ===');
check('no link at all, nothing chosen -> chooser (the tab opened cold)', () => {
  assert.strictEqual(isChoosing({}), true);
});
check('link applied but unresolvable -> chooser, not a permanent Loading', () => {
  // applyLink stamps the key even when the contest code is unknown, so an
  // unusable link falls back to the chooser instead of hanging.
  assert.strictEqual(isChoosing({ linkContest: 'NOPE', linkNonce: '9', appliedKey: 'NOPE||9' }), true);
});
check('the reader opened the picker themselves -> chooser wins over everything', () => {
  assert.strictEqual(
    isChoosing({ picking: true, wholeContest: 'GOV', linkContest: 'GOV', appliedKey: 'GOV||' }), true,
  );
});
check('a NEW tap on a different card re-pends (the nonce changes)', () => {
  assert.strictEqual(
    isChoosing({ linkContest: 'SEN', linkNonce: '456', appliedKey: 'GOV||123', wholeContest: 'GOV' }),
    false,
  );
});

// ── 2. the stat strip ───────────────────────────────────────────────────────
console.log('\n=== the stat strip sizes columns by content ===');
const weighSrc = /const weigh = \(([\s\S]*?)\) =>\s*([\s\S]*?);\n/.exec(RACE);
/** The real weigh(), with its TypeScript parameter annotations stripped so node
 *  can evaluate the body verbatim. The BODY is never rewritten — that is the
 *  part under test. */
const makeWeigh = () => {
  assert.ok(weighSrc, 'weigh() not found in race.tsx');
  const params = weighSrc[1]
    .split(',')
    .map((p) => p.split(':')[0].trim())
    .filter(Boolean)
    .join(', ');
  // eslint-disable-next-line no-new-func
  return Function(`return (${params}) => ${weighSrc[2]};`)();
};
check('the strip no longer gives every cell an equal fifth', () => {
  assert.ok(!/cells\.map\(\[[\s\S]{0,200}?className="flex-1 items-center"/.test(RACE),
    'a cell still uses flex-1');
  assert.ok(/flexBasis: 0/.test(RACE), 'flexBasis: 0 not found — growth will not be proportional');
  assert.ok(/flexGrow: weigh\(/.test(RACE), 'flexGrow is not derived from the content');
});
check('the label cannot wrap instead of the value', () => {
  const strip = RACE.slice(RACE.indexOf('const weigh ='), RACE.indexOf('<RaceMap'));
  assert.strictEqual((strip.match(/numberOfLines=\{1\}/g) ?? []).length, 2,
    'both the value and the label should be single-line');
});
check('weigh() gives the date column more room than "LGAs"', () => {
  assert.ok(weighSrc, 'weigh() not found in race.tsx');
  // eslint-disable-next-line no-new-func
  const weigh = makeWeigh();
  const cells = [['6 Feb 2027', 'Election day'], ['TBD', 'Candidates'], ['APC', 'Held by'],
    [31, 'LGAs'], ['~4,353', 'Units']];
  const w = cells.map(([n, l]) => weigh(n, l));
  const total = w.reduce((a, b) => a + b, 0);
  const CARD = 358;           // a 390pt phone, less the screen's own padding
  const date = (w[0] / total) * CARD;
  const lgas = (w[3] / total) * CARD;
  console.log(`        date column ${date.toFixed(0)}pt (was ${(CARD / 5).toFixed(0)}pt), LGAs ${lgas.toFixed(0)}pt`);
  // "6 Feb 2027" at 16pt bold needs roughly 85pt.
  assert.ok(date >= 90, `date column only ${date.toFixed(0)}pt — still truncates`);
  assert.ok(date > lgas, 'the date column is not wider than the LGA count');
  assert.ok(lgas >= 28, `"LGAs" squeezed to ${lgas.toFixed(0)}pt`);
});
check('every column still fits on the narrowest supported phone', () => {
  const weigh = makeWeigh();
  const cells = [['6 Feb 2027', 'Election day'], ['TBD', 'Candidates'], ['APC', 'Held by'],
    [31, 'LGAs'], ['~4,353', 'Units']];
  const w = cells.map(([n, l]) => weigh(n, l));
  const total = w.reduce((a, b) => a + b, 0);
  const CARD = 320 - 32;      // iPhone SE 1st gen, less padding
  for (let i = 0; i < cells.length; i++) {
    const got = (w[i] / total) * CARD;
    const need = String(cells[i][1]).length * 5.2;   // 10px label, ~5.2pt a char
    assert.ok(got >= need * 0.85,
      `"${cells[i][1]}" gets ${got.toFixed(0)}pt, needs about ${need.toFixed(0)}pt`);
  }
});

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
