/**
 * End-to-end test of the party-table merge, with no GPU and no network.
 *
 *   node scripts/test_party_merge.mjs
 *
 * Synthesises a third-pass file against real pass-1 records and runs the merge,
 * so the plumbing is proven before an hour of inference produces data that has
 * nowhere correct to go. The cases are the ones that decide whether the pass is
 * worth paying for at all:
 *
 *   - a sheet whose rows pass 1 could not read, where pass 3 reports EMPTY
 *     cells, should become resolvable
 *   - a sheet where the two passes disagree on a number must NOT resolve
 *   - a sheet the pass never covered must come through completely untouched
 *   - a TOTAL row disagreeing with #7 must surface as a finding
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partymerge-'));
const p = (n) => path.join(dir, n);
let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
};

const boxes = {
  registered: 500, ballotsIssued: 500, unusedBallots: 210,
  accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
};
// 280 valid votes spread over the ballot: two parties carry it, the rest zero.
const votes = { APC: 150, A: 130 };
const mkRows = (fn) => OSUN_2026_BALLOT.map((party) => fn(party, votes[party] || 0));

const words = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR'];
const spell = (n) => (n === 150 ? 'ONE HUNDRED AND FIFTY' : (n === 130 ? 'ONE HUNDRED AND THIRTY' : words[n] || String(n)));

// --- pass 1: the zero rows came back null, exactly as the old prompt forced --
const pass1 = [
  {
    file: 'unreadable-zeros.jpg',
    sheet: { ...boxes, parties: mkRows((party, v) => (v ? { party, figures: String(v), words: spell(v) } : { party, figures: null, words: null })) },
    verify: { summary: { verdict: 'review' }, rows: mkRows((party, v) => ({ party, value: v || null, confidence: v ? 'both' : 'none' })) },
  },
  {
    file: 'passes-disagree.jpg',
    sheet: { ...boxes, parties: mkRows((party, v) => ({ party, figures: String(v), words: spell(v) })) },
    verify: { summary: { verdict: 'publishable' }, rows: mkRows((party, v) => ({ party, value: v, confidence: 'both' })) },
  },
  {
    file: 'not-covered.jpg',
    sheet: { ...boxes, parties: mkRows((party, v) => ({ party, figures: String(v), words: spell(v) })) },
    verify: { summary: { verdict: 'publishable' }, rows: mkRows((party, v) => ({ party, value: v, confidence: 'both' })) },
  },
  {
    file: 'bad-total-row.jpg',
    sheet: { ...boxes, parties: mkRows((party, v) => ({ party, figures: String(v), words: spell(v) })) },
    verify: { summary: { verdict: 'publishable' }, rows: mkRows((party, v) => ({ party, value: v, confidence: 'both' })) },
  },
  {
    file: 'p3-self-conflict.jpg',
    sheet: { ...boxes, parties: mkRows((party, v) => ({ party, figures: String(v), words: spell(v) })) },
    verify: { summary: { verdict: 'publishable' }, rows: mkRows((party, v) => ({ party, value: v, confidence: 'both' })) },
  },
];
fs.writeFileSync(p('full.jsonl'), `${pass1.map((r) => JSON.stringify(r)).join('\n')}\n`);
fs.writeFileSync(p('boxes.jsonl'), `${pass1.map((r) => JSON.stringify({
  file: r.file, boxesRaw: Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, String(v)])),
})).join('\n')}\n`);

// --- pass 3 -----------------------------------------------------------------
const party3 = [
  // The officer drew a stroke in every nil row; pass 3 can finally say so.
  {
    file: 'unreadable-zeros.jpg',
    parties: mkRows((party, v) => (v ? { party, figures: String(v), words: spell(v) } : { party, figures: '', words: '-' })),
    totalRow: { figures: '280', words: 'TWO HUNDRED AND EIGHTY' },
  },
  // Pass 3 reads APC as 151 in BOTH cells where pass 1 read 150 in both. Two
  // internally consistent passes flatly disagreeing: nobody gets to pick.
  {
    file: 'passes-disagree.jpg',
    parties: mkRows((party, v) => (party === 'APC'
      ? { party, figures: '151', words: 'ONE HUNDRED AND FIFTY ONE' }
      : { party, figures: String(v), words: spell(v) })),
    totalRow: { figures: '280', words: 'TWO HUNDRED AND EIGHTY' },
  },
  // Pass 3 contradicts ITSELF on APC (figures 151, words one hundred and
  // fifty) while pass 1 is internally consistent at 150. Three of the four
  // readings say 150, so 150 is carried — but the row is no longer "read twice
  // and agreed", and must not let the sheet claim to be.
  {
    file: 'p3-self-conflict.jpg',
    parties: mkRows((party, v) => (party === 'APC'
      ? { party, figures: '151', words: 'ONE HUNDRED AND FIFTY' }
      : { party, figures: String(v), words: spell(v) })),
    totalRow: { figures: '280', words: 'TWO HUNDRED AND EIGHTY' },
  },
  // The officer's own total contradicts both #7 and the column.
  {
    file: 'bad-total-row.jpg',
    parties: mkRows((party, v) => ({ party, figures: String(v), words: spell(v) })),
    totalRow: { figures: '279', words: 'TWO HUNDRED AND SEVENTY NINE' },
  },
];
fs.writeFileSync(p('party.jsonl'), `${party3.map((r) => JSON.stringify(r)).join('\n')}\n`);

execFileSync('node', [
  path.join(import.meta.dirname, 'merge_party_pass.mjs'),
  p('full.jsonl'), p('boxes.jsonl'), p('party.jsonl'), p('out.jsonl'),
], { stdio: 'pipe' });

const out = new Map(fs.readFileSync(p('out.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).map((r) => [r.file, r]));

console.log('\nthe pass earns its keep');
const zeros = out.get('unreadable-zeros.jpg');
eq('every row now resolves', zeros.verify.rows.filter((r) => r.value === null).length, 0);
eq('the sum is checkable', zeros.verify.checks.find((c) => c.name === 'party_sum').status, 'pass');
eq('and the sheet clears', zeros.verify.summary.verdict, 'publishable');

console.log('\ndisagreement is not resolved by picking');
const dis = out.get('passes-disagree.jpg');
const apc = dis.verify.rows.find((r) => r.party === 'APC');
eq('the disputed row has NO value', apc.value, null);
eq('and is labelled a conflict', apc.confidence, 'conflict');
eq('the sheet drops out of publishable', dis.verify.summary.verdict, 'review');

console.log('\na pass that contradicts itself does not get to certify the row');
const self = out.get('p3-self-conflict.jpg');
const selfApc = self.verify.rows.find((r) => r.party === 'APC');
eq('the majority reading is carried', selfApc.value, 150);
eq('but it is marked contested', selfApc.confidence, 'contested');
eq('counted as single-sourced', self.verify.summary.contested, 1);
eq('so the sheet cannot be publishable', self.verify.summary.verdict, 'review');
eq('the sum still reconciles', self.verify.checks.find((c) => c.name === 'party_sum').status, 'pass');

console.log('\nsheets the pass never saw are untouched');
const un = out.get('not-covered.jpg');
eq('no total_row check invented', un.verify.checks.some((c) => c.name === 'total_row'), false);
eq('verdict preserved', un.verify.summary.verdict, 'publishable');

console.log('\nthe officer\'s own total is now checked');
const bad = out.get('bad-total-row.jpg');
eq('a contradicting TOTAL row fails', bad.verify.checks.find((c) => c.name === 'total_row').status, 'fail');
// `review`, not `flagged`: the check is low severity because 60% of its
// real-world disagreements turned out to be misreads. It blocks publication
// and queues the sheet for a human without asserting a discrepancy.
eq('it blocks publication', bad.verify.summary.verdict, 'review');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
