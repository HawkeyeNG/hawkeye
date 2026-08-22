/**
 * Send one push to every registered device. Dry-run by default.
 *
 *   node scripts/broadcast_push.mjs                      # audience only, sends nothing
 *   node scripts/broadcast_push.mjs --send --max 200     # real send, refuses above 200
 *
 *   --title "..."  --body "..."  --url https://...       # override the default copy
 *
 * WHY A SEPARATE SCRIPT AND NOT AN ADMIN BUTTON. A push cannot be recalled. A
 * button in a console gets clicked by accident; a command with `--send` and an
 * explicit `--max` does not. The default run prints the audience and the exact
 * copy and exits without sending, so the normal way to use this is to look at
 * what it WOULD do first.
 *
 * The `--max` guard is the one that matters. You state the audience you believe
 * you are addressing; if the database disagrees, nothing goes out. That is the
 * difference between messaging 19 observers and messaging 19,000 people.
 */
import { broadcast, pushConfigured, webPushConfigured } from '../src/services/push.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

// The default copy is the Play migration message. Kept here, in the repo, so
// what was sent is recoverable later — a push that exists only in someone's
// shell history is not auditable.
const TITLE = arg('title', 'Hawkeye is now on Google Play');
const BODY = arg('body',
  'Install the Play Store version — it is half the size, updates itself, and opens faster. '
  + 'Your account and saved units come with you.');
const URL = arg('url', 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer');

const send = has('send');
const max = Number(arg('max', 0)) || 0;

console.log('channels:');
console.log(`  FCM (Android)  ${pushConfigured() ? 'configured' : 'NOT configured — Android devices will not be reached'}`);
console.log(`  Web Push       ${webPushConfigured() ? 'configured' : 'NOT configured — browser subscriptions will not be reached'}`);

console.log('\nthe message, exactly as it will appear:');
console.log(`  title: ${TITLE}`);
console.log(`  body:  ${BODY}`);
console.log(`  opens: ${URL}`);

try {
  const r = await broadcast({
    title: TITLE,
    body: BODY,
    data: { url: URL, kind: 'play_migration' },
    dryRun: !send,
    confirm: send ? 'SEND' : null,
    maxAudience: max,
  });

  console.log(`\naudience: ${r.audience} device(s) — ${r.android} android, ${r.web} web`);
  if (r.dryRun) {
    console.log('\nDRY RUN — nothing was sent.');
    console.log(`To send for real:  node scripts/broadcast_push.mjs --send --max ${Math.max(r.audience, 1)}`);
  } else {
    console.log(`\nSENT: ${r.sent}   failed: ${r.failed}`);
    if (r.failed) console.log('Failures are usually stale tokens from uninstalled apps; they are pruned on 404.');
  }
} catch (e) {
  console.error(`\nrefused: ${e.message}`);
  process.exit(1);
}
process.exit(0);
