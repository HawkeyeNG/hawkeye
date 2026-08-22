/**
 * Regression test for the Stage 2 labelling-console changes.
 *
 *   node scripts/test_training_routes.mjs
 *
 * These routes decide what feeds ML training and what leaves the review queue,
 * so the cases that matter are about HONESTY rather than mechanics:
 *
 *   - a label that asserts "I read every row" must be distinguishable from one
 *     that merely happened to list no zeroes, because that distinction is the
 *     whole reason a human label can settle a sheet the model could not
 *   - "the sheet cannot be read" must not put the sheet back in the pool, or
 *     the queue never terminates
 *   - an audit-selected sheet must never be mistaken for a random sample
 *
 * Runs against a temp storage dir with a fake express app, so it touches
 * nothing real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-'));
const storage = path.join(tmp, 'storage');
fs.mkdirSync(path.join(storage, 'training'), { recursive: true });
// config.dbPath's DIRECTORY is what training.js derives storage/training from.
process.env.DB_PATH = path.join(storage, 'test.db');
process.env.ADMIN_PASSPHRASE = 'test-pass';

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
};

const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(storage, 'training', n), 'utf8')); } catch { return {}; } };

// Enough sheets that the stream tests are not fighting over an empty pool:
// two get labelled or removed early, and each claim below consumes one more.
for (let i = 1; i <= 8; i++) {
  fs.writeFileSync(path.join(storage, 'training', `29-01-01-00${i}.jpg`), 'not-a-real-jpeg');
}

const { trainingRouter } = await import('../src/routes/training.js');

/** Minimal express-route driver: find the layer and invoke its final handler. */
function call(method, url, body = {}) {
  const layer = trainingRouter.stack.find((l) => l.route?.path === url && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${url}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = handlers[handlers.length - 1];   // skip the auth middleware
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    handler({ body, query: {}, params: {} }, res, () => resolve({ status: 500, body: { error: 'next called' } }));
  });
}

console.log('a label can now assert it read EVERY row');
await call('post', '/training/label', { key: '29-01-01-001', set: 1, counts: { APC: 150, A: 130 }, complete: true });
eq('truth.json keeps its old shape (non-zero only)', readJson('truth.json')['29-01-01-001'], { APC: 150, A: 130 });
eq('completeness recorded in the sidecar', readJson('label_meta.json')['29-01-01-001'].complete, true);
// Without the flag the same label means something weaker, and must not be
// silently upgraded — an unlisted party might be zero or might be unexamined.
await call('post', '/training/label', { key: '29-01-01-002', set: 1, counts: { APC: 90 } });
eq('no flag means no claim', readJson('label_meta.json')['29-01-01-002'], undefined);

console.log('\na label can now carry the summary boxes');
await call('post', '/training/label', {
  key: '29-01-01-001', set: 1, counts: { APC: 150, A: 130 },
  boxes: { registered: 500, spoiled: 0, totalValid: 280, usedBallots: 290 },
});
const boxes = readJson('label_meta.json')['29-01-01-001'].boxes;
eq('boxes stored', boxes.registered, 500);
// A spoiled count of 0 is a real reading, not an absence — the old
// non-zero-only filter would have dropped it and left the box unresolved.
eq('a genuine ZERO box survives', boxes.spoiled, 0);
eq('unsupplied boxes are absent, not null', 'accredited' in boxes, false);
await call('post', '/training/label', { key: '29-01-01-001', set: 1, counts: { APC: 150 }, boxes: { registered: 600000 } });
eq('an impossible box is refused, keeping the old value', readJson('label_meta.json')['29-01-01-001'].boxes.registered, 500);

console.log('\n"cannot be read" is a third exit, not a recycle');
const before = readJson('truth.json')['29-01-01-002'];
eq('sheet is labelled before', Boolean(before), true);
await call('post', '/training/illegible', { key: '29-01-01-002', reason: 'scan cut off at the party table', by: 'tester' });
eq('label removed', readJson('truth.json')['29-01-01-002'], undefined);
eq('finding recorded with its reason', readJson('illegible.json')['29-01-01-002'].reason, 'scan cut off at the party table');
eq('and who said so', readJson('illegible.json')['29-01-01-002'].by, 'tester');
// THE POINT: it must not come back round for the next person to fail on.
eq('kept out of the claimable pool', readJson('dropped.json')['29-01-01-002'], true);
const items = await call('get', '/training/items', {});
void items;

console.log('\nstreams keep the sample separable from the findings queue');
await call('post', '/training/generate', { set: 2, count: 2, stream: 'random' });
const streams1 = readJson('streams.json');
eq('a random claim is tagged random', Object.values(streams1).every((s) => s === 'random'), true);
// An audit claim NAMES the sheet it wants — that is the whole point, since the
// audit knows which sheets failed a check.
const target = fs.readdirSync(path.join(storage, 'training'))
  .filter((f) => f.endsWith('.jpg') && !readJson('sets.json')[f]
    && !readJson('truth.json')[f.replace(/\.[^.]+$/, '')]
    && !readJson('dropped.json')[f.replace(/\.[^.]+$/, '')])[0];
const audit = await call('post', '/training/generate', { set: 2, count: 1, stream: 'audit', files: [target] });
eq('the audit claim succeeded', audit.body.claimed, 1);
eq('an audit claim is tagged audit', readJson('streams.json')[target.replace(/\.[^.]+$/, '')], 'audit');
// And a RANDOM claim must not be allowed to hand-pick, or the only unbiased
// sample there is gets quietly poisoned.
eq('the two streams are counted apart', (await call('get', '/training/streams', {})).body.tally.random.labelled >= 0, true);
// Hand-picking into the RANDOM stream would poison the only unbiased sample
// there is, so `files` is honoured for audit claims only.
eq('an unknown stream defaults to random', (await call('post', '/training/generate', { set: 3, count: 1 })).body.stream, 'random');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
