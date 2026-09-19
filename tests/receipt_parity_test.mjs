/**
 * THE TWO RECEIPT CARDS SAY THE SAME THING.
 *
 * The web paints on a canvas and the app draws with react-native-svg. Those two
 * renderers cannot be compared to each other and there is no point trying —
 * what CAN be compared is the rule that decides every string on the card, which
 * is why it is a function on both sides (app/receipt.js:lines,
 * native/src/lib/receipt.ts:receiptLines) rather than something buried in a
 * paint routine. Same arrangement as political.ts and its web twin.
 *
 * A copy of the rule would pass a copy-shaped test; only the real pair can
 * disagree, so both SHIPPED implementations are loaded here.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/native/`);
const { transform } = require_('sucrase');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- the WEB rule, loaded the way observe.html loads it ------------------
const sandbox = { window: {}, document: { createElement: () => ({ getContext: () => ({}) }) } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${ROOT}/app/receipt.js`, 'utf8'), sandbox);
const web = sandbox.window.HAWKEYE_RECEIPT;

// ---- the NATIVE rule, transpiled from the shipped source -----------------
const SRC = `${ROOT}/native/src/lib/receipt.ts`;
const code = transform(fs.readFileSync(SRC, 'utf8'), { transforms: ['typescript', 'imports'], filePath: SRC }).code;
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(() => ({}), mod, mod.exports);
const rn = mod.exports;

check('web exports lines()', typeof web?.lines, 'function');
check('native exports receiptLines()', typeof rn?.receiptLines, 'function');

/**
 * Every shape a report can take, including the ones that only differ by one
 * field — a rule that agreed on the happy path and diverged on an empty vote
 * list would ship a blank card on one client only.
 */
/**
 * ONE TRANSLATOR, HANDED TO BOTH. lines() takes `t` as an argument precisely so
 * this test can pin it: with the same translator on both sides a difference is
 * a difference in the RULE, not in which bundle happened to load. Identity on
 * the English argument keeps the expected strings readable here; that the
 * translations exist at all is what the catalogues and keys_resolve prove.
 */
const T = (_k, english) => english;

const AT = Date.UTC(2026, 8, 19, 13, 32);
const CASES = {
  recorded: { puName: 'Ogbe-Udu Primary School', puCode: '10-18-03-001', ward: 'Udu III', lga: 'Udu', state: 'Delta', contest: 'SHA By-Election (Udu)', votes: [{ party: 'PDP', count: 120 }, { party: 'APC', count: 98 }], entryHash: 'a'.repeat(64), at: AT },
  queued: { puName: 'Ogbe-Udu Primary School', puCode: '10-18-03-001', ward: 'Udu III', lga: 'Udu', state: 'Delta', contest: 'SHA By-Election (Udu)', votes: [{ party: 'PDP', count: 120 }], entryHash: '', at: AT },
  practice: { puName: 'Practice Unit', puCode: '00-00-00-001', contest: 'Practice', votes: [{ party: 'Party A', count: 12 }], entryHash: 'c'.repeat(64), practice: true, at: AT },
  zeroVotes: { puName: 'Somewhere', contest: 'X', votes: [{ party: 'A', count: 0 }], entryHash: 'd'.repeat(64), at: AT },
  noVotes: { puName: 'Somewhere', contest: 'X', entryHash: 'e'.repeat(64), at: AT },
  empty: {},
  partialPlace: { puName: 'U', lga: 'Udu', contest: 'X', entryHash: 'f'.repeat(64), at: AT },
};

console.log('\n=== both clients build the same card, case for case ===');
for (const [name, data] of Object.entries(CASES)) {
  const a = web.lines(data, T);
  const b = rn.receiptLines(data, T);
  check(`${name} agrees field for field`, JSON.stringify(a) === JSON.stringify(b), true);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        console.log(`        ${k}: web ${JSON.stringify(a[k])} vs native ${JSON.stringify(b[k])}`);
      }
    }
  }
}

console.log('\n=== the practice card cannot pass for a real one ===');
for (const [who, L] of [['web', web.lines(CASES.practice, T)], ['native', rn.receiptLines(CASES.practice, T)]]) {
  check(`${who}: flagged practice`, L.practice, true);
  check(`${who}: says so in the title`, L.title, (t) => /not a real result/i.test(t));
  check(`${who}: says so in the status`, L.status, (t) => /rehearsal|never counted/i.test(t));
  // THE ONE THAT MATTERS. ledger.html cannot show a practice entry, so a verify
  // link would 404 and imply the rehearsal was published.
  check(`${who}: carries NO verify link`, L.verify, '');
  check(`${who}: never claims the public ledger`, L.status, (t) => !/Recorded on the public ledger/.test(t));
  // CONTROL: it still shows the practice chain's own hash, so the card can
  // teach what a ledger entry looks like.
  check(`${who}: CONTROL still shows the practice hash`, L.hash, 'c'.repeat(64));
}

console.log('\n=== controls: the comparator can see a difference ===');
check('a changed hash changes the card', web.lines(CASES.recorded, T).verify === web.lines(CASES.queued, T).verify, false);
check('practice differs from recorded', web.lines(CASES.practice, T).title === web.lines(CASES.recorded, T).title, false);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
