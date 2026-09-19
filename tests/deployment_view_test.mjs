/**
 * DEPLOYMENT: where have we put people, weighted by the voters behind them.
 *
 * The only view in the room that means anything WEEKS before the day, which is
 * when a campaign actually decides where to send anyone. Everything else on
 * that tab counts reports, and before election day there are none.
 *
 * TWO THINGS THIS EXISTS TO GET RIGHT, and both are easy to get wrong in a way
 * that reads plausibly:
 *
 *   1. Coverage is counted over UNITS, never members. Two agents down for one
 *      unit cover one unit's voters; counting them twice shows a ward as
 *      deployed while the ward beside it sits empty — the exact decision this
 *      number is for.
 *   2. The voter figure is a FLOOR. The register does not carry a count for
 *      every row, and a screen that implies a complete total is lying about the
 *      size of the hole.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/deployment_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/* Three LGAs. Ikeja has the most units covered but the biggest VOTER hole;
   Eti-Osa has fewer open units but they are large. A screen that ranks by
   units puts them in the wrong order, and that is the bug this data is shaped
   to catch. */
const NODES = [
  { key: 'Ikeja', name: 'Ikeja', units: 100, reported: 0, assigned: 40, on_unit: 0, mismatched: 0,
    member_reported: 0, watched: 0, assigned_units: 30, voters: 200000, assigned_voters: 40000, voters_unknown: 0 },
  { key: 'Eti-Osa', name: 'Eti-Osa', units: 50, reported: 0, assigned: 10, on_unit: 0, mismatched: 0,
    member_reported: 0, watched: 0, assigned_units: 10, voters: 190000, assigned_voters: 30000, voters_unknown: 12 },
  { key: 'Alimosho', name: 'Alimosho', units: 20, reported: 0, assigned: 20, on_unit: 0, mismatched: 0,
    member_reported: 0, watched: 0, assigned_units: 20, voters: 50000, assigned_voters: 50000, voters_unknown: 0 },
];

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
  if (u === '/api/groups/1/coverage') return json({
    level: 'lga', contest: 'PRES', area: null, coordinators: {}, mine: null, my_scope: null, nodes: NODES,
  });
  if (u.startsWith('/api/')) return json({ ok: true, items: [], rows: [], members: [], nodes: [] });
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
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript((t) => { localStorage.setItem('hawkeye_token', t); }, jwt);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 180)));
await p.goto(`${base}/situation-room.html?room=test-room`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.evaluate(() => document.querySelector('[data-tab="coverage"]').click());
await p.waitForTimeout(700);

const table = () => p.evaluate(() => ({
  heads: [...document.querySelectorAll('.sr-heads .sr-head')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()),
  cols: [...document.querySelectorAll('.sr-tbl thead th')].map((t) => t.textContent.trim()),
  rows: [...document.querySelectorAll('.sr-tbl tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim())),
  note: document.querySelector('.sr-note')?.textContent.replace(/\s+/g, ' ').trim() || '',
}));

// ========================================== CONTROL: the reporting view is untouched
{
  const t = await table();
  check('CONTROL the room rendered', errs, []);
  check('CONTROL coverage still opens on the REPORTING view', t.cols, (c) => c.includes('Reported'));
  /* The reporting view keeps the order the SERVER sent (it orders by name; this
     stub does not, deliberately). That is the control for the sort below: the
     deployment ranking has to be the deployment view's own doing, not something
     leaking back into the table everyone else reads. */
  check('CONTROL it keeps the server order, unsorted by the client',
    t.rows.map((r) => r[0].split(/\s/)[0]), ['Ikeja', 'Eti-Osa', 'Alimosho']);
}

// ==================================================== the deployment view
await p.evaluate(() => {
  const sel = document.getElementById('cov-filter');
  sel.value = 'undeployed';
  sel.dispatchEvent(new Event('change'));
});
await p.waitForTimeout(400);
{
  const t = await table();
  check('the table becomes a deployment table', t.cols,
    (c) => c.includes('Voters uncovered') && c.includes('Nobody') && !c.includes('Reported'));

  /* THE ORDERING IS THE PRODUCT. Ikeja has 70 open units against Eti-Osa's 40,
     and also the bigger voter hole (160k vs 160k — equal by voters, so units
     break the tie). Alimosho is fully covered and must not be listed at all. */
  check('fully covered places are not listed', t.rows.map((r) => r[0]),
    (v) => !v.some((x) => /Alimosho/.test(x)));
  check('the biggest hole is first', t.rows[0][0], (v) => /Ikeja/.test(v || ''));

  const ikeja = t.rows.find((r) => /Ikeja/.test(r[0]));
  check('it counts UNITS covered, not members', ikeja && ikeja[2], '30');
  check('and shows what is still open', ikeja && ikeja[3], '70');
  check('weighted by the voters behind them', ikeja && ikeja[4], '160,000');

  // The headline strip switches with it.
  check('the strip counts uncovered voters', t.heads.join(' | '),
    (v) => /Registered voters uncovered/.test(v || ''));
  check('and no longer talks about reports', t.heads.join(' | '),
    (v) => !/reported/i.test(v || ''));

  /* THE FLOOR, SAID OUT LOUD. 12 of Eti-Osa's units carry no registered-voter
     count, so the total is a lower bound and the screen has to say so — a
     number presented as complete would understate the hole it exists to size. */
  check('it admits the voter total is a floor', t.note, (v) => /floor/i.test(v || '') && /12/.test(v || ''));
  await p.screenshot({ path: `${OUT}/deployment.png` });
}

// ================== CONTROL: switch back, and the reporting view is unharmed
await p.evaluate(() => {
  const sel = document.getElementById('cov-filter');
  sel.value = 'all';
  sel.dispatchEvent(new Event('change'));
});
await p.waitForTimeout(400);
{
  const t = await table();
  check('CONTROL switching back restores the reporting table', t.cols, (c) => c.includes('Reported'));
  check('CONTROL with every place listed again', t.rows.length, 3);
  check('CONTROL and no page errors throughout', errs, []);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — deployment measured in voters, not in rows');
process.exit(fail ? 1 : 0);
