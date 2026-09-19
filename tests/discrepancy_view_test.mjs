/**
 * WHERE OUR FIGURES AND THE OFFICIAL UPLOAD DISAGREE.
 *
 * Two properties carry this feature, and both are easy to lose:
 *
 *   1. RANKED BY ABSOLUTE VOTES, never by percentage. A 40-vote swing matters
 *      the same at a unit that polled 400 and one that polled 4,000; ranking by
 *      share makes small units scream and buries the units worth driving to.
 *   2. IT ACCUSES NOBODY. A transposed digit, a re-uploaded sheet and a stolen
 *      result are indistinguishable from here. The moment a campaign's own
 *      dashboard asserts fraud on its own authority it is a partisan
 *      instrument, and the ledger underneath it is worth nothing.
 *
 * The fixture is built so the two rankings DISAGREE: the biggest percentage
 * gap and the biggest vote gap are different units. A screen ranking by share
 * passes every other assertion here and fails the one that matters.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/discrepancy_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/* Tiny Corner: 40 of 60 votes moved — a 67% swing, the loudest by share.
   Big Hall:   300 of 4,000 moved — 7.5%, and by far the larger theft.
   A share-ranked screen puts Tiny Corner first. */
let PAYLOAD = {
  contest: 'PRES',
  compared: 120,
  truncated: false,
  items: [
    { pair_id: 2, pu_code: '37-06-02-200', unit: { name: 'Big Hall', ward: 'Garki', lga: 'AMAC', state: 'FCT' },
      doc_url: 'https://example.test/ec8a-200.pdf', seen_at: 1,
      diffs: [{ party: 'LP', ours: 1200, theirs: 900, delta: 300 }], worst: 300 },
    { pair_id: 1, pu_code: '37-06-02-141', unit: { name: 'Tiny Corner', ward: 'Garki', lga: 'AMAC', state: 'FCT' },
      doc_url: null, seen_at: 1,
      diffs: [{ party: 'APC', ours: 20, theirs: 60, delta: 40 }], worst: 40 },
    { pair_id: 3, pu_code: '37-06-02-300', unit: { name: 'Missing Party', ward: 'Garki', lga: 'AMAC', state: 'FCT' },
      doc_url: null, seen_at: 1,
      diffs: [{ party: 'NNPP', ours: 31, theirs: null, delta: 31 }], worst: 31 },
  ],
};

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u === '/api/groups') return json({ managing: [{ id: 1, name: 'Test Room', slug: 'test-room', kind: 'campaign', contest: 'PRES', members: 5 }], member: [] });
  if (u === '/api/groups/1') return json({
    id: 1, name: 'Test Room', kind: 'campaign', contest: 'PRES', scope: '', slug: 'test-room',
    scope_kind: '', members: 5, assigned: 5, pending: 0, zones: {}, me_id: 10,
    me: { role: 'owner', scope_kind: '', scope_value: '' },
    managers: [{ observer_id: 10, role: 'owner', scope_kind: '', scope_value: '' }],
    attendance: { checkedIn: 0, atUnit: 0, elsewhere: 0, expected: 5 },
  });
  if (u === '/api/groups/1/discrepancies') return json(PAYLOAD);
  if (u === '/api/groups/1/coverage') return json({ total: { units: 100, reported: 0 }, nodes: [], level: 'lga', coordinators: {}, mine: null });
  if (u.startsWith('/api/')) return json({ ok: true, items: [], rows: [], nodes: [], members: [] });
  const f = path.join(APP, decodeURIComponent(u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';

async function room() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } });
  await ctx.addInitScript((t) => { localStorage.setItem('hawkeye_token', t); }, jwt);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 180)));
  await p.goto(`${base}/situation-room.html?room=test-room`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1100);
  return { ctx, p, errs };
}

// ========================================================= with disagreements
{
  const { ctx, p, errs } = await room();
  check('CONTROL the room rendered', errs, []);
  const card = await p.evaluate(() => {
    const h = [...document.querySelectorAll('.sr-h2')].find((x) => /disagree/i.test(x.textContent));
    if (!h) return null;
    const box = h.closest('.sr-card');
    return {
      sub: box.querySelector('.sr-sub')?.textContent.replace(/\s+/g, ' ').trim() || '',
      rows: [...box.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim())),
      links: [...box.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      text: box.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  check('the card is shown', !!card, true);

  // THE ORDERING ASSERTION. Big Hall (300 votes, 7.5%) must beat Tiny Corner
  // (40 votes, 67%). A percentage ranking reverses these two.
  check('ranked by VOTES, not by share', card.rows.map((r) => r[0].split(/\d/)[0].trim()),
    (v) => v[0] === 'Big Hall' && v[1] === 'Tiny Corner');
  check('the largest gap is the unit\'s worst single party', card.rows[0][2], '300');

  // A party on one side and not the other is the most serious shape a
  // disagreement takes; it must not render as a blank or a zero.
  check('a party missing from one side says so, not "0"', card.rows[2][1],
    (t) => /not listed/i.test(t || '') && !/\b0\b/.test(t || ''));

  check('the denominator is stated', card.sub, (t) => /120/.test(t || ''));
  check('the upload is linked where there is one', card.links, ['https://example.test/ec8a-200.pdf']);

  /* IT ACCUSES NOBODY. This is the assertion that keeps the product neutral,
     and it is worth failing the build over. */
  check('no word of the copy assigns blame', card.text,
    (t) => !/(fraud|rigg|stolen result was|cheat|falsif|tamper)/i.test(t || ''));
  check('and it says a difference is not a verdict', card.text,
    (t) => /not a verdict/i.test(t || ''));
  await p.screenshot({ path: `${OUT}/card.png` });
  await ctx.close();
}

// =========== CONTROL: nothing compared yet must not read as a clean bill
{
  PAYLOAD = { contest: 'PRES', compared: 0, items: [], truncated: false };
  const { ctx, p } = await room();
  check('CONTROL nothing compared renders NO card', await p.evaluate(() =>
    document.body.innerText.toLowerCase().includes('disagree')), false);
  await ctx.close();
}

// ================= and compared-but-clean is also silent, for the same reason
{
  PAYLOAD = { contest: 'PRES', compared: 120, items: [], truncated: false };
  const { ctx, p } = await room();
  check('CONTROL compared with no differences is silent too', await p.evaluate(() =>
    document.body.innerText.toLowerCase().includes('disagree')), false);
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — ranked by votes, and it accuses nobody');
process.exit(fail ? 1 : 0);
