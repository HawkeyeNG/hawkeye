/**
 * THE ADMIN REVIEW ROUTES, over the real router.
 *
 * The one that must not be wrong: a reviewer must never receive another
 * reviewer's verdict. If that leaks, every later reading is an echo and the
 * panel is one opinion wearing three hats — and nothing about the output would
 * look different.
 *
 *   node backend/scripts/test_pair_routes.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/backend/');
const express = require_('express');

import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { pairsRouter } from '../src/routes/pairs.js';
import { buildPairs } from '../src/services/pairs.js';
import { submitReview } from '../src/services/review.js';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

/* The console gate reads config at request time; give it something to compare. */
const SECRET = 'test-secret-' + Date.now();
config.adminConsoleSecret = SECRET;

db.exec('BEGIN');
let server;
const cleanup = () => { try { db.exec('ROLLBACK'); } catch { /* done */ } if (server) server.close(); };
process.on('exit', cleanup);

const app = express();
app.use(express.json());
app.use('/api/pairs', pairsRouter);
server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (path, { reviewer = null, secret = SECRET, ...init } = {}) => {
  const r = await fetch(base + '/api/pairs' + path, {  // the router is MOUNTED there; calling base+path hit /meta and 404d
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-admin-secret': secret } : {}),
      ...(reviewer ? { 'x-reviewer-id': reviewer } : {}),
    },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  const pu = db.prepare('SELECT pu_code FROM polling_units LIMIT 1').get().pu_code;
  const CONTEST = 'ROUTETEST';
  db.prepare(`INSERT INTO results (pu_code, contest, votes_json, status, updated_at, confidence, matching_reports, total_reports)
              VALUES (?, ?, ?, 'reported', ?, 1.0, 1, 1)`)
    .run(pu, CONTEST, JSON.stringify([{ party: 'APC', count: 341 }]), Date.now());
  buildPairs({ irevId: 'RT2', contest: CONTEST });
  const pair = db.prepare('SELECT * FROM result_pairs WHERE contest = ?').get(CONTEST);

  /* --- the gate ------------------------------------------------------------ */
  check('no admin secret is refused', (await call('/meta', { secret: null })).status, 401);
  check('a wrong secret is refused', (await call('/meta', { secret: 'nope' })).status, 401);
  check('the right one gets in', (await call('/meta')).status, 200);
  check('the queue needs a reviewer name', (await call('/queue?kind=tally_match')).status, 400);

  /* --- queues are per reviewer --------------------------------------------- */
  const qA = await call('/queue?kind=tally_match&contest=' + CONTEST, { reviewer: 'alice' });
  check('alice sees the pair', qA.body.items.length, 1);
  await call(`/${pair.id}/review`, {
    reviewer: 'alice', method: 'POST',
    body: JSON.stringify({ kind: 'tally_match', verdict: 'mismatch' }),
  });
  check('after answering it leaves alice\'s queue',
    (await call('/queue?kind=tally_match&contest=' + CONTEST, { reviewer: 'alice' })).body.items.length, 0);
  check('CONTROL: but bob still has it',
    (await call('/queue?kind=tally_match&contest=' + CONTEST, { reviewer: 'bob' })).body.items.length, 1);
  check('alice cannot answer the same question twice',
    (await call(`/${pair.id}/review`, {
      reviewer: 'alice', method: 'POST',
      body: JSON.stringify({ kind: 'tally_match', verdict: 'match' }),
    })).status, 409);

  /* --- THE BLINDNESS RULE --------------------------------------------------- */
  const seen = await call(`/${pair.id}`, { reviewer: 'bob' });
  const blob = JSON.stringify(seen.body);
  check('bob can open the pair', seen.status, 200);
  /* alice said 'mismatch'. If that string reaches bob in ANY field, the reading
     he is about to give is not independent. */
  check('CONTROL: alice\'s verdict does not reach bob', /mismatch/.test(blob), false);
  check('CONTROL: nor her name', /alice/i.test(blob), false);
  check('and bob is told nothing about the panel he has not joined', seen.body.panels, []);
  /* Alice, who HAS answered, may see where her own reading landed. */
  const hers = await call(`/${pair.id}`, { reviewer: 'alice' });
  check('alice sees the panel she is part of', hers.body.panels.length, 1);
  check('  ...and that she answered it', hers.body.answered, ['tally_match']);

  /* --- the reply says how it stands, not what anyone said -------------------- */
  const posted = await call(`/${pair.id}/review`, {
    reviewer: 'bob', method: 'POST',
    body: JSON.stringify({ kind: 'tally_match', verdict: 'mismatch' }),
  });
  check('bob\'s reading settles it', posted.body.panel.state, 'agreed');
  check('CONTROL: and the reply carries no verdicts', /mismatch|alice/.test(JSON.stringify(posted.body)), false);

  /* --- a bad verdict is refused --------------------------------------------- */
  check('a verdict outside the vocabulary is refused',
    (await call(`/${pair.id}/review`, {
      reviewer: 'carol', method: 'POST',
      body: JSON.stringify({ kind: 'tally_match', verdict: 'probably fine' }),
    })).body.error, 'bad_verdict');

  /* --- single-address panels are surfaced ----------------------------------- */
  const sum = await call('/summary', { reviewer: 'alice' });
  check('the summary reports panels answered from one address',
    sum.body.singleAddressPanels, (v) => typeof v === 'number' && v >= 1);
} finally {
  cleanup();
  process.removeAllListeners('exit');
}

console.log(fail ? `\n${fail} FAILED` : '\nall admin review route checks passed');
process.exit(fail ? 1 : 0);
