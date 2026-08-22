/**
 * Guard tests for the broadcast path.
 *
 *   node scripts/test_push_broadcast.mjs
 *
 * The only interesting question here is whether the things that STOP a send
 * actually stop it. A broadcast cannot be recalled, so every guard is tested
 * for refusal, not for the happy path — and the happy path is deliberately not
 * exercised, because a test that sends a real push is not a test.
 */
import { broadcast } from '../src/services/push.js';

let failures = 0;
const ok = (label, cond) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}`); }
};
const refuses = async (label, opts) => {
  try { await broadcast(opts); failures++; console.log(`  FAIL ${label} — it did NOT refuse`); }
  catch { console.log(`  ok   ${label}`); }
};

console.log('dry run is the default');
const d = await broadcast({ title: 't', body: 'b' });
ok('dryRun true unless asked otherwise', d.dryRun === true);
ok('sends nothing', d.sent === 0);
ok('still reports the audience', typeof d.audience === 'number');

console.log('\na real send must be deliberate');
await refuses('no confirm at all', { title: 't', body: 'b', dryRun: false });
await refuses('confirm is truthy but wrong', { title: 't', body: 'b', dryRun: false, confirm: true });
await refuses('confirm is lowercase', { title: 't', body: 'b', dryRun: false, confirm: 'send' });

console.log('\nthe audience guard');
// maxAudience is the guard that keeps a message meant for 19 people from
// reaching 19,000. With a real audience of 0 locally, -1 is the only value
// that can be exceeded — the point is that exceeding it refuses at all.
await refuses('audience larger than stated', {
  title: 't', body: 'b', dryRun: false, confirm: 'SEND', maxAudience: -1,
});

console.log('\ncopy is required');
await refuses('no title', { title: '', body: 'b' });
await refuses('no body', { title: 't', body: '' });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
