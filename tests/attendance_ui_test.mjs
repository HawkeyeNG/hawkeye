/**
 * ATTENDANCE, AS THE ROOM RENDERS IT.
 *
 * The backend test proves the rules; this proves a coordinator can see them.
 * The three states exist because a boolean would hide the middle one, and the
 * middle one is the whole point: an agent who checked in somewhere OTHER than
 * their assignment is the row that needs a phone call, and "present" would bury
 * them among the arrived while "absent" would send help to the wrong ward.
 *
 * The control is the empty case. The strip must be INVISIBLE before anyone
 * checks in — a row of noughts above the map every day of the year trains
 * everyone to scroll past the one screen that matters on the one day it does.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/attendance_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const ME = 10;
let attendanceOn = true;

const member = (id, label, assignedPu, att) => ({
  observer_id: id, label, role: null, shared: 0, joined_at: 1, assign_state: 'confirmed',
  assigned: assignedPu ? { pu_code: assignedPu, name: 'Unit ' + assignedPu, ward: 'Garki', lga: 'AMAC', state: 'FCT' } : null,
  reported: null,
  status: assignedPu ? 'silent' : 'unassigned',
  attendance: att,
});

const TEAM = () => ({
  contest: 'PRES',
  members: [
    // me: not checked in, so the button must be offered
    member(ME, 'Ada', '37-06-02-141', null),
    member(11, 'Bello', '37-06-02-142', attendanceOn
      ? { at: Date.now(), standing: 'verified', distanceM: 12, unit: { pu_code: '37-06-02-142', name: 'Unit 142', ward: 'Garki' }, atAssigned: true } : null),
    member(12, 'Chidi', '37-06-02-143', attendanceOn
      ? { at: Date.now(), standing: 'verified', distanceM: 40, unit: { pu_code: '37-06-02-999', name: 'Other Unit', ward: 'Garki' }, atAssigned: false } : null),
    member(13, 'Dupe', '37-06-02-144', attendanceOn
      ? { at: Date.now(), standing: 'unverified', distanceM: null, unit: { pu_code: '37-06-02-144', name: 'Unit 144', ward: 'Garki' }, atAssigned: true } : null),
    member(14, 'Emeka', '37-06-02-145', null),
  ],
});

const GROUP = () => ({
  id: 1, name: 'Test Room', kind: 'campaign', contest: 'PRES', scope: '', party: null, slug: 'test-room',
  scope_kind: '', members: 5, assigned: 5, pending: 0, zones: {}, me_id: ME,
  me: { role: 'owner', scope_kind: '', scope_value: '' },
  managers: [{ observer_id: ME, role: 'owner', scope_kind: '', scope_value: '' }],
  attendance: attendanceOn ? { checkedIn: 3, atUnit: 2, elsewhere: 1, expected: 5 } : { checkedIn: 0, atUnit: 0, elsewhere: 0, expected: 5 },
});

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u === '/api/groups') return json({ managing: [{ id: 1, name: 'Test Room', slug: 'test-room', kind: 'campaign', contest: 'PRES', members: 5 }], member: [] });
  if (u === '/api/groups/1') return json(GROUP());
  if (u === '/api/groups/1/team') return json(TEAM());
  if (u === '/api/groups/1/coverage') return json({ total: { units: 176846, reported: 0, on_unit: 0, mismatched: 0, assigned: 5 }, children: [] });
  if (u === '/api/groups/1/activity') return json({ items: [] });
  if (u === '/api/groups/1/incidents') return json({ items: [] });
  if (u.startsWith('/api/')) return json({ ok: true, items: [], rows: [], members: [] });
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

async function open(tab) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript((t) => { localStorage.setItem('hawkeye_token', t); }, jwt);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 180)));
  await p.goto(`${base}/situation-room.html?room=test-room`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  if (tab) {
    await p.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await p.waitForTimeout(700);
  }
  return { ctx, p, errs };
}

// ============================================================ the Overview strip
{
  const { ctx, p, errs } = await open(null);
  const strip = await p.evaluate(() => {
    const heads = [...document.querySelectorAll('.sr-heads')];
    return heads.map((h) => [...h.querySelectorAll('.sr-head')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()));
  });
  check('CONTROL the room rendered without errors', errs, []);
  const att = strip.find((g) => g.some((t) => /At their unit now/.test(t)));
  check('the attendance strip is on Overview', !!att, true);
  // The number and its label are one text node with no space between them.
  check('it leads with who is AT their unit', att && att[0], (v) => /^2\s*At their unit now/.test(v || ''));
  check('and counts who has not been heard from', att && att.join(' | '),
    (v) => /2\s*Not heard from/.test(v || ''));
  await p.screenshot({ path: `${OUT}/overview.png` });
  await ctx.close();
}

// ================================================================ the roster
{
  const { ctx, p, errs } = await open('team');
  check('CONTROL the team tab rendered without errors', errs, []);
  const rows = await p.evaluate(() => [...document.querySelectorAll('.sr-tbl.text tbody tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
  check('CONTROL the roster drew every member', rows.length, 5);
  const cell = (name) => (rows.find((r) => r[0].startsWith(name)) || [])[2];
  check('at their unit reads "At unit"', cell('Bello'), (v) => /At unit/.test(v || ''));
  check('the wrong unit reads "Elsewhere", not present', cell('Chidi'),
    (v) => /Elsewhere/.test(v || '') && !/At unit/.test(v || ''));
  check('a weak fix reads "Unconfirmed", never "At unit"', cell('Dupe'),
    (v) => /Unconfirmed/.test(v || '') && !/At unit/.test(v || ''));
  check('nobody heard from shows a dash', cell('Emeka'), (v) => /—|&mdash;|-/.test(v || ''));

  // The member's own button — and only their own.
  check('I am offered a check-in', await p.evaluate(() => !!document.getElementById('sr-checkin')), true);
  /* Count ELEMENTS, not occurrences of the string: innerHTML includes the
     page's own inline <script>, so matching the source counted the handler
     that implements the button as though it were more buttons. */
  check('there is exactly one check-in control', await p.evaluate(() =>
    document.querySelectorAll('#sr-checkin').length), 1);
  check('and none of them is on somebody else\'s row', await p.evaluate(() => {
    const label = document.getElementById('sr-checkin')?.textContent.trim();
    return [...document.querySelectorAll('.sr-tbl.text tbody button')]
      .filter((x) => x.textContent.trim() === label).length;
  }), 0);
  await p.screenshot({ path: `${OUT}/team.png` });
  await ctx.close();
}

// ============================ CONTROL: before anyone checks in, nothing shows
{
  attendanceOn = false;
  const { ctx, p } = await open(null);
  check('CONTROL with nobody checked in the strip is absent', await p.evaluate(() =>
    document.body.innerText.includes('At their unit now')), false);
  const { ctx: c2, p: p2 } = await open('team');
  check('CONTROL and the roster column is empty, not wrong', await p2.evaluate(() =>
    document.body.innerText.includes('At unit')), false);
  await ctx.close(); await c2.close();
  attendanceOn = true;
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — presence is visible, and honest about what it knows');
process.exit(fail ? 1 : 0);
