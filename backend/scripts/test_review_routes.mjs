/**
 * Regression test for the flagged-sheet review routes.
 *
 *   node backend/scripts/test_review_routes.mjs
 *
 * The feature's entire value rests on one property: a reviewer cannot see the
 * machine's reading until their own is committed and frozen. Everything else is
 * plumbing. So the tests are built around trying to BREAK that, not around
 * walking the happy path — a happy-path test would pass just as cheerfully if
 * the gate had been deleted, which is the failure mode worth guarding against.
 *
 * The two that matter most:
 *   - CONTROL: fetching the prediction before any blind reading must 409. If
 *     this ever returns 200 the audit's numbers are anchoring, not accuracy.
 *   - LEAK: the pre-commit payload must not carry the triage's reason or its
 *     arithmetic. "over-voting, excess 211" names the answer as surely as the
 *     counts do, and it would arrive looking like harmless context.
 *
 * Runs against a temp storage dir, so it touches nothing real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
const storage = path.join(tmp, 'storage');
const reviewDir = path.join(storage, 'audit_review');
fs.mkdirSync(path.join(reviewDir, 'pred'), { recursive: true });
fs.mkdirSync(path.join(storage, 'training'), { recursive: true });
process.env.DB_PATH = path.join(storage, 'test.db');
process.env.ADMIN_PASSPHRASE = 'test-pass';
// The review routes admit only named reviewers. 7 and 99 are both reviewers
// here, so the cross-reviewer tests below exercise the OWNERSHIP rule rather
// than merely bouncing off the allowlist.
process.env.REVIEW_OBSERVER_IDS = '7,99';

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
};
const ok_ = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
};

// ── a queue of two sheets, one of which carries anchoring triage numbers ────
const KEY = '29-04-04-010';
const KEY2 = '29-10-04-012';
const KEY3 = '29-13-03-012';
fs.writeFileSync(path.join(reviewDir, 'queue.json'), JSON.stringify({
  source: 'vlm_stage0b.jsonl',
  tier: 'a',
  count: 3,
  entries: [
    {
      key: KEY,
      file: `${KEY}.jpg`,
      tier: 'a',
      lga: 'Ayedire',
      ward: 'Oke-Osun',
      name: 'Laitan Village',
      triage: { verdict: 'flagged', why: 'over-voting above 10 votes', excess: 211, cast: 458, accredited: 247 },
      priority: { conflict: 15, contested: 0, unread: 0, single: 0 },
      predHash: 'deadbeefdeadbeef',
    },
    {
      key: KEY2,
      file: `${KEY2}.jpg`,
      tier: 'a',
      lga: 'Ejigbo',
      ward: "Elejigbo 'D'/Ejemu",
      name: 'Apake Open Space',
      triage: { verdict: 'review', why: 'an unread row could hold enough to lead', margin: 44, leader: 'APC' },
      priority: { conflict: 0, contested: 0, unread: 2, single: 0 },
      predHash: 'cafecafecafecafe',
    },
    {
      key: KEY3,
      file: `${KEY3}.jpg`,
      tier: 'a',
      lga: 'Ife East',
      ward: 'Ilode Ii',
      name: 'Omitoto Line 1',
      triage: { verdict: 'flagged', why: 'party column misses the total', shortfall: 17 },
      priority: { conflict: 1, contested: 0, unread: 0, single: 0 },
      predHash: 'f00df00df00df00d',
    },
  ],
}));
fs.writeFileSync(path.join(reviewDir, 'pred', `${KEY}.json`), JSON.stringify({
  key: KEY,
  file: `${KEY}.jpg`,
  source: 'vlm_stage0b.jsonl',
  parties: [
    { party: 'APC', value: 120, confidence: 'both' },
    { party: 'PDP', value: 98, confidence: 'conflict' },
    { party: 'ADC', value: null, confidence: 'empty' },
  ],
  boxes: { registered: 500, accredited: 247 },
  defects: { rowIntegrity: null, adjudicated: null, implausible: null, promptLeak: null },
  confidenceCounts: { both: 1, conflict: 1, empty: 1 },
}));

fs.writeFileSync(path.join(reviewDir, 'pred', `${KEY2}.json`), JSON.stringify({
  key: KEY2,
  file: `${KEY2}.jpg`,
  source: 'vlm_stage0b.jsonl',
  parties: [
    { party: 'APC', value: 10, confidence: 'both' },
    { party: 'PDP', value: 21, confidence: 'figures' },
  ],
  boxes: { registered: 300 },
  defects: {},
  confidenceCounts: { both: 1, figures: 1 },
}));

const { trainingRouter } = await import('../src/routes/training.js');

/** Minimal route driver: invoke the final handler, skipping auth middleware,
 *  with an observer stubbed in since the handlers record who reviewed. */
function call(method, routePath, { body = {}, params = {}, query = {}, observerId = 7 } = {}) {
  const layer = trainingRouter.stack.find(
    (l) => l.route?.path === routePath && l.route.methods[method],
  );
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  // Run the WHOLE chain except requireObserver, which needs a real JWT and is
  // stubbed by injecting req.observer. Taking only the last handler — as this
  // did originally — silently skips route middleware, so an authorisation rule
  // living in middleware could not be tested and a test asserting it would have
  // been measuring nothing.
  const stack = layer.route.stack.map((s) => s.handle).slice(1);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      type() { return this; },
      set() { return this; },
    };
    const req = { body, params, query, observer: { id: observerId }, headers: {} };
    let i = 0;
    const next = () => {
      const h = stack[i++];
      if (!h) return resolve({ status: 500, body: { error: 'chain exhausted' } });
      return h(req, res, next);
    };
    next();
  });
}

console.log('\nflagged-sheet review routes\n');

// ── 1. THE CONTROL ─────────────────────────────────────────────────────────
// Before anything else: prove the gate is shut. A test suite that cannot fail
// here is not testing the feature, it is describing it.
{
  const r = await call('get', '/training/review/pred/:key', { params: { key: KEY } });
  eq('CONTROL prediction is refused before any blind reading',
    [r.status, r.body.error], [409, 'blind_reading_required']);
}

// ── 2. the pre-commit payload must not name the answer ─────────────────────
{
  const r = await call('get', '/training/review/queue', { query: { set: 1, limit: 50 } });
  const item = r.body.items.find((x) => x.key === KEY);
  ok_('queue returns the sheet', Boolean(item));
  const text = JSON.stringify(item ?? {});
  for (const leak of ['triage', 'why', 'excess', 'accredited', 'verdict', 'priority', 'conflict', 'margin', 'leader', 'predHash']) {
    ok_(`LEAK pre-commit payload withholds "${leak}"`, !text.includes(leak), `-> ${text}`);
  }
  ok_('pre-commit payload keeps location (it is printed on the sheet)',
    text.includes('Ayedire') && text.includes('Laitan Village'));
}

// ── 3. committing a blind reading ──────────────────────────────────────────
{
  const r = await call('post', '/training/review/blind', {
    body: { key: KEY, parties: { APC: 120, PDP: 55, ADC: 0 }, boxes: { registered: 500, accredited: 247 }, complete: true, ms: 92000 },
  });
  eq('blind reading is accepted', [r.status, r.body.ok], [201, true]);

  const stored = JSON.parse(fs.readFileSync(path.join(reviewDir, 'reviews.json'), 'utf8'));
  // An explicit zero must survive. "ADC polled nothing" and "nobody read the ADC
  // row" is the exact distinction this whole review exists to settle, and
  // truth.json's non-zero-only convention would erase it.
  eq('an explicit zero is preserved', stored[KEY].blind.parties.ADC, 0);
  eq('the reviewer is recorded', stored[KEY].blind.by, 7);
}

// ── 4. the blind reading is immutable ──────────────────────────────────────
{
  const r = await call('post', '/training/review/blind', {
    body: { key: KEY, parties: { APC: 120, PDP: 98 } },  // now matching the machine
  });
  eq('a second blind reading is refused', [r.status, r.body.error], [409, 'blind_already_committed']);
  const stored = JSON.parse(fs.readFileSync(path.join(reviewDir, 'reviews.json'), 'utf8'));
  eq('the original blind reading is unchanged', stored[KEY].blind.parties.PDP, 55);
}

// ── 5. now the prediction is released ──────────────────────────────────────
{
  const r = await call('get', '/training/review/pred/:key', { params: { key: KEY } });
  eq('prediction is released after the blind commit', r.status, 200);
  ok_('it carries the machine reading', r.body.prediction?.parties?.length === 3);
  ok_('it now also carries the triage reason', r.body.triage?.why === 'over-voting above 10 votes');
  const stored = JSON.parse(fs.readFileSync(path.join(reviewDir, 'reviews.json'), 'utf8'));
  eq('which prediction was shown is stamped', stored[KEY].pred.hash, 'deadbeefdeadbeef');
}

// ── 6. a final needs a blind reading first ─────────────────────────────────
{
  const r = await call('post', '/training/review/final', { body: { key: KEY2, parties: { APC: 10 } } });
  eq('final is refused with no blind reading', [r.status, r.body.error], [409, 'blind_reading_required']);
}

// ── 7. agreement is computed server-side, not accepted from the client ─────
{
  const r = await call('post', '/training/review/final', {
    body: {
      key: KEY,
      parties: { APC: 120, PDP: 98, ADC: 0 },   // reviewer moved PDP to the machine's value
      boxes: { registered: 500, accredited: 247 },
      complete: true,
      // A client insisting it agreed on everything. It must be ignored.
      agreement: { parties: { compared: 99, same: 99, differs: [] } },
    },
  });
  eq('final is accepted', r.status, 201);
  const a = r.body.agreement;
  // APC: both read 120        -> same
  // PDP: machine 98, blind 55 -> a real disagreement
  // ADC: machine never read it, human read 0 -> NOT a disagreement. The model
  //      had no opinion, so this is a row the human recovered.
  eq('agreement counts the BLIND reading, not the final one', a.parties.same, 1);
  eq('the disagreement is identified', a.parties.differs.map((d) => d.party), ['PDP']);
  eq('a row the model could not read is counted as recovered, not wrong',
    a.parties.added.map((d) => d.party), ['ADC']);
  ok_('that recovered row is marked as unread by the model', a.parties.added[0]?.machineUnread === true);
  eq('nothing was claimed by the model and missed by the human', a.parties.dropped, []);
  ok_('the denominator counts only cells BOTH read', a.parties.compared === 2, `compared=${a.parties.compared}`);
  eq('the change of mind after reveal is recorded', a.humanChangedAfterReveal, true);
}

// ── 8. a final cannot be rewritten either ──────────────────────────────────
{
  const r = await call('post', '/training/review/final', { body: { key: KEY, parties: { APC: 1 } } });
  eq('a second final is refused', [r.status, r.body.error], [409, 'already_final']);
}

// ── 9. only sheets in the queue are servable ───────────────────────────────
{
  const r = await call('get', '/training/review/sheet/:key', { params: { key: '../../../etc/passwd' } });
  eq('a key outside the queue is refused', [r.status, r.body.error], [404, 'not_in_queue']);
}

// ── 10. the stats view ─────────────────────────────────────────────────────
{
  const r = await call('get', '/training/review/stats');
  eq('stats count the finished review', [r.body.final, r.body.blind], [1, 1]);
  eq('stats report the agreement rate over comparable cells only', r.body.agreementRate, 0.5);
  eq('stats report rows the human recovered', r.body.rowsRecovered, 1);
  eq('stats report rows the model could not support', r.body.rowsUnsupported, 0);
  eq('stats flag the change after reveal', r.body.changedAfterReveal, 1);
  ok_('a 92-second reading is not flagged as suspiciously fast',
    r.body.suspiciouslyFast.length === 0, JSON.stringify(r.body.suspiciouslyFast));
}


// ── 11. THE CRITICAL ONE: the gate is per-reviewer, not per-sheet ──────────
// The first version keyed both the reveal and the final on "does a blind reading
// exist for this sheet". With one reviewer that is indistinguishable from the
// correct rule, which is why the original suite passed while a second observer
// could read the machine's answer and author the settled reading.
{
  const K = KEY2;
  let r = await call('post', '/training/review/blind', {
    body: { key: K, parties: { APC: 10, PDP: 20 }, complete: true }, observerId: 7,
  });
  eq('reviewer 7 commits a blind reading on a second sheet', r.status, 201);

  r = await call('get', '/training/review/pred/:key', { params: { key: K }, observerId: 99 });
  eq('a DIFFERENT reviewer cannot see the machine reading',
    [r.status, r.body.error], [403, 'not_your_reading']);

  r = await call('post', '/training/review/final', {
    body: { key: K, parties: { APC: 10, PDP: 20 } }, observerId: 99,
  });
  eq('a DIFFERENT reviewer cannot settle the sheet',
    [r.status, r.body.error], [403, 'not_your_reading']);

  r = await call('get', '/training/review/pred/:key', { params: { key: K }, observerId: 7 });
  eq('the reviewer who committed it still can', r.status, 200);
}

// ── 12. only named reviewers may touch these routes ───────────────────────
{
  // A sheet nobody has touched, so a 403 here can only come from the allowlist.
  const r = await call('post', '/training/review/blind', {
    body: { key: KEY3, parties: { APC: 1 } }, observerId: 1234,
  });
  eq('an observer who is not a named reviewer is refused',
    [r.status, r.body.error], [403, 'not_a_reviewer']);

  // CONTROL for the test above: the same request from a named reviewer must NOT
  // be refused, or the 403 above would prove nothing about the allowlist.
  const c = await call('get', '/training/review/queue', { query: { set: 1 }, observerId: 7 });
  ok_('CONTROL a named reviewer is not refused', c.status === 200, `got ${c.status}`);
}

// ── 13. a sheet another reviewer has blinded is not served ────────────────
// Otherwise it sits at the head of their queue forever: they cannot submit it
// (403) and the queue only drops a sheet once it has a FINAL.
{
  // KEY2 is queue index 1, so setForIndex puts it in set 2 — ask for the set it
  // is actually in, or this test passes for the wrong reason.
  const r = await call('get', '/training/review/queue', { query: { set: 2, limit: 50 }, observerId: 99 });
  const keys = r.body.items.map((i) => i.key);
  ok_('a sheet blinded by someone else is withheld from this reviewer', !keys.includes(KEY2),
    `got ${JSON.stringify(keys)}`);
}

// ── 14. an interrupted review resumes instead of wedging the queue ─────────
{
  const r = await call('get', '/training/review/queue', { query: { set: 2, limit: 50 }, observerId: 7 });
  const item = r.body.items.find((i) => i.key === KEY2);
  ok_('the sheet is still offered to the reviewer who blinded it', Boolean(item));
  eq('and it is flagged as resumable', item?.resume, true);
  const text = JSON.stringify(item ?? {});
  for (const leak of ['triage', 'why', 'excess', 'parties', 'value']) {
    ok_(`resume flag leaks nothing ("${leak}")`, !text.includes(leak));
  }
}

// ── 15. a figure out of range is refused, not silently dropped ────────────
// Dropping it wrote an incomplete IMMUTABLE reading, showed the reviewer their
// own typed value anyway, and then scored the missing cell as "the model
// invented a figure" — a typo filed as evidence against the model.
{
  const r = await call('post', '/training/review/blind', {
    body: { key: KEY3, parties: { APC: 123456, PDP: 55 } }, observerId: 7,
  });
  eq('an out-of-range figure is refused', [r.status, r.body.error], [400, 'out_of_range']);
  eq('and the offending field is named', r.body.fields, ['APC']);
  const stored = JSON.parse(fs.readFileSync(path.join(reviewDir, 'reviews.json'), 'utf8'));
  ok_('nothing was committed for that sheet', !stored[KEY3], JSON.stringify(stored[KEY3] || null));
}

// ── 16. a corrupt reviews.json must not read as "no reviews" ──────────────
// It used to: the reader swallowed every error and returned {}, and the next
// write truncated the file, replacing every committed reading with one record.
{
  const before = fs.readFileSync(path.join(reviewDir, 'reviews.json'), 'utf8');
  fs.writeFileSync(path.join(reviewDir, 'reviews.json'), '{ this is not json');
  let threw = false;
  try {
    await call('get', '/training/review/queue', { query: { set: 1 }, observerId: 7 });
  } catch { threw = true; }
  ok_('an unreadable reviews.json fails loudly rather than reading as empty', threw);
  fs.writeFileSync(path.join(reviewDir, 'reviews.json'), before);
  const after = JSON.parse(fs.readFileSync(path.join(reviewDir, 'reviews.json'), 'utf8'));
  ok_('and the earlier reviews are still there', Object.keys(after).length >= 2,
    `keys=${Object.keys(after).length}`);
}

// ── 17. the reviewer list is a file, and it is read per request ───────────
// Adding someone must not need a restart — that is the whole reason it is not
// only an env var. And the refusal must name the caller, because an observer
// has no other way to discover the id they need to be added under.
{
  const F = path.join(reviewDir, 'reviewers.json');
  fs.writeFileSync(F, JSON.stringify({ observers: [4242] }));
  let r = await call('get', '/training/review/queue', { query: { set: 1 }, observerId: 4242 });
  eq('an observer named only in reviewers.json is admitted', r.status, 200);

  fs.writeFileSync(F, JSON.stringify({ observers: [] }));
  r = await call('get', '/training/review/queue', { query: { set: 1 }, observerId: 4242 });
  eq('removing them takes effect on the very next request',
    [r.status, r.body.error], [403, 'not_a_reviewer']);
  eq('the refusal names the caller so they can be added', r.body.you, 4242);

  // A malformed file must not widen access to everyone.
  fs.writeFileSync(F, 'not json at all');
  r = await call('get', '/training/review/queue', { query: { set: 1 }, observerId: 4242 });
  eq('a malformed reviewers.json refuses rather than admitting',
    [r.status, r.body.error], [403, 'not_a_reviewer']);
  fs.rmSync(F, { force: true });
}

// ── 18. the bundled prediction file is equivalent to the per-key ones ─────
// Deploying to the live host means one upload per file, so 490 per-key files
// are shipped as one bundle. If the server could not read the bundle, the
// reveal would 404 in production and nowhere else.
{
  const perKey = path.join(reviewDir, 'pred', `${KEY3}.json`);
  const pred = { key: KEY3, file: `${KEY3}.jpg`, source: 'vlm_stage0b.jsonl',
    parties: [{ party: 'APC', value: 7, confidence: 'both' }], boxes: {}, defects: {} };
  fs.writeFileSync(perKey, JSON.stringify(pred));
  fs.writeFileSync(path.join(reviewDir, 'pred.json'), JSON.stringify({ [KEY3]: pred }));

  await call('post', '/training/review/blind', {
    body: { key: KEY3, parties: { APC: 7 } }, observerId: 99,
  });
  let r = await call('get', '/training/review/pred/:key', { params: { key: KEY3 }, observerId: 99 });
  eq('the per-key prediction is read', [r.status, r.body.prediction?.parties?.[0]?.value], [200, 7]);

  // CONTROL: with the per-key file gone, only the bundle can answer. If this
  // passes without the bundle being read, the test proves nothing.
  fs.rmSync(perKey);
  r = await call('get', '/training/review/pred/:key', { params: { key: KEY3 }, observerId: 99 });
  eq('and so is the bundle when the per-key file is absent',
    [r.status, r.body.prediction?.parties?.[0]?.value], [200, 7]);

  fs.rmSync(path.join(reviewDir, 'pred.json'));
  r = await call('get', '/training/review/pred/:key', { params: { key: KEY3 }, observerId: 99 });
  eq('CONTROL with neither present it is a 404, so the two above meant something',
    [r.status, r.body.error], [404, 'no_prediction']);
}

// ── 19. reviewers are manageable without a shell ──────────────────────────
// The live host has no SSH, so the admin console is the only way to add someone.
{
  const F = path.join(reviewDir, 'reviewers.json');
  fs.rmSync(F, { force: true });
  let r = await call('post', '/training/review/reviewers', { body: { observer: 'abc' } });
  eq('a non-numeric observer id is refused', [r.status, r.body.error], [400, 'bad_observer_id']);

  r = await call('post', '/training/review/reviewers', { body: { observer: '77777' } });
  eq('an observer who does not exist is refused', [r.status, r.body.error], [404, 'no_such_observer']);

  // Remove needs no such check — taking access away from a stale id is safe.
  fs.writeFileSync(F, JSON.stringify({ observers: ['4242'] }));
  r = await call('post', '/training/review/reviewers', { body: { observer: '4242', action: 'remove' } });
  eq('removing works and reports the new list', [r.status, r.body.observers], [201, []]);
  const after = JSON.parse(fs.readFileSync(F, 'utf8'));
  eq('and it is written to disk', after.observers, []);
  fs.rmSync(F, { force: true });
}

// ── 20. a sheet with no local file and no URL is an honest 404 ────────────
{
  const r = await call('get', '/training/review/sheet/:key', { params: { key: KEY3 }, observerId: 99 });
  eq('no image and no upstream URL reports no_sheet', [r.status, r.body.error], [404, 'no_sheet']);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
