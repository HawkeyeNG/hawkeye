/**
 * THE ROOM'S DIALOGS AND MAP, as a manager on a phone meets them.
 *
 * Three defects this guards, all invisible from the source:
 *
 * 1. "Give access" and "Invite observers" opened panels PREPENDED to the top of
 *    the page. Both buttons live where a manager has usually scrolled down to,
 *    so the tap opened something off-screen and looked like it did nothing.
 *    Asserted from a page scrolled to the BOTTOM: a real dialog must exist and
 *    sit inside the viewport. Against the old code there is no dialog at all.
 *
 * 2. The area picker flickered between dropdowns because every choice cleared
 *    the whole chain and re-fetched each list from the top. Asserted as: the
 *    select already answered is the SAME DOM element after the next one
 *    appears, and a list already fetched is never fetched twice.
 *
 * 3. Map shapes carried their numbers only in <title>, which a phone never
 *    shows. Asserted as: tapping a shape writes that shape's title out.
 *
 * Plus the grant itself now names the ward's parents, without which "Garki"
 * (FCT, Jigawa, Katsina) cannot be settled — see scope_parents_test.mjs.
 *
 *   node tests/room_dialogs_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const GROUP = {
  id: 7, name: 'Adaeze 2027', kind: 'campaign', contest: 'Governorship', scope: 'Delta',
  party: null, slug: 'adaeze-2027', scope_kind: 'state', members: 32, assigned: 0,
  zones: ['South South'], me_id: 1,
};
const ME = { role: 'owner', scope_kind: '', scope_value: '' };
const MANAGERS = [{ observer_id: 1, role: 'owner', scope_kind: '', scope_value: '' }];
const row = (id, label, role = null) => ({ observer_id: id, label, role, shared: 0, joined_at: id, assign_state: '', assigned: null, reported: null, status: 'unassigned' });
// Enough people that the page SCROLLS, with the one we act on at the very bottom.
const MEMBERS = [row(1, 'Ada', 'owner'), ...Array.from({ length: 30 }, (_, i) => row(100 + i, 'Filler ' + (i + 1))), row(3, 'Chidi')];

const LGAS = [{ key: 'Oshimili North', name: 'Oshimili North' }, { key: 'Ika South', name: 'Ika South' }];
const WARDS = {
  'Oshimili North': [{ key: 'Akwukwu', name: 'Akwukwu' }, { key: 'Ebu', name: 'Ebu' }],
  'Ika South': [{ key: 'Agbor', name: 'Agbor' }],
};
const node = (x) => ({ ...x, units: 10, reported: 0, assigned: 0, on_unit: 0, mismatched: 0, member_reported: 0, watched: 0 });

const hits = new Map();
let posted = null;
let tokens = [{ token: 'tok-one', uses: 2, revoked: 0, expires_at: Date.now() + 5 * 86400000 }];

const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const q = new URLSearchParams(qs || '');
  const json = (o, ms = 0) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  }, ms);
  hits.set(req.method + ' ' + req.url, (hits.get(req.method + ' ' + req.url) || 0) + 1);

  if (url === '/api/groups') {
    return json({ managing: [{ id: 7, name: GROUP.name, kind: GROUP.kind, contest: GROUP.contest, scope: GROUP.scope, slug: GROUP.slug }], member: [] });
  }
  if (url === '/api/groups/7') return json({ ...GROUP, me: ME, managers: MANAGERS });
  if (url === '/api/groups/7/team') return json({ contest: GROUP.contest, members: MEMBERS });
  if (url === '/api/groups/7/sources') return json({ sources: [] });
  if (url === '/api/parties') return json([]);
  if (url === '/api/groups/7/invites') {
    if (req.method === 'POST') {
      tokens.push({ token: 'tok-' + (tokens.length + 1), uses: 0, revoked: 0, expires_at: Date.now() + 7 * 86400000 });
      return json({ ok: true });
    }
    return json(tokens);
  }
  // Slow on purpose: a real round-trip is what made the old picker flicker.
  if (url === '/api/groups/7/coverage') {
    const lga = q.get('lga');
    return json({ level: lga ? 'ward' : 'lga', nodes: (lga ? WARDS[lga] || [] : LGAS).map(node) }, 150);
  }
  if (req.method === 'POST' && url === '/api/groups/7/managers/3') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { posted = JSON.parse(body || '{}'); json({ ok: true, role: posted.role }); });
    return undefined;
  }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const VIEW = { width: 390, height: 780 };   // a phone
const p = await b.newPage({ viewport: VIEW });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('dialog', (d) => d.accept());          // an alert() from a failed grant must not hang the run
await p.addInitScript(() => {
  const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  try {
    localStorage.setItem('hawkeye_lang', 'en');
    localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
  } catch (e) { /* private mode */ }
});
await p.goto(`${base}/situation-room.html?tab=team`, { waitUntil: 'networkidle' });
await p.waitForSelector('.sr-tbl', { timeout: 10000 }).catch(() => {});

const inView = async () => {
  const d = p.locator('[role="dialog"]');
  if (await d.count() !== 1) return { count: await d.count() };
  const r = await d.boundingBox();
  return { count: 1, top: Math.round(r.y), bottom: Math.round(r.y + r.height), fits: r.y >= 0 && r.y + r.height <= VIEW.height };
};
/* Scroll whichever element ACTUALLY overflows. Above 700px the room scrolls
   inside #sr-scroll with the window pinned; below it the document scrolls. A
   helper that only moved the window reported 0 on the wide layout and would have
   let every "inside the viewport" check pass against an unscrolled page. */
const toBottom = () => p.evaluate(() => {
  const pane = document.getElementById('sr-scroll');
  const doc = document.scrollingElement;
  const scroller = pane && pane.scrollHeight > pane.clientHeight + 5 ? pane : doc;
  // 'instant': styles.css sets html { scroll-behavior: smooth }, so a plain
  // scrollTop assignment animates and reads back 0 on the very next line.
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
  return { by: scroller === pane ? '#sr-scroll' : 'document', top: Math.round(scroller.scrollTop),
    doc: [doc.scrollHeight, doc.clientHeight], pane: pane ? [pane.scrollHeight, pane.clientHeight] : null };
});

/* --- Invite observers ---------------------------------------------------- */
check('the page actually scrolls (or the viewport test proves nothing)', await toBottom(), (s) => s.top > 200);
await p.click('#invite-btn');
await p.waitForSelector('[role="dialog"] code', { timeout: 5000 }).catch(() => {});
check('invite: opens ONE dialog, inside the viewport, from a scrolled page', await inView(), (v) => v.count === 1 && v.fits);
check('invite: shows the live link', await p.textContent('[role="dialog"]'), (t) => t.includes('/join/tok-one'));
await p.click('#inv-new');
await p.waitForFunction(() => document.querySelectorAll('[role="dialog"] code').length === 2, null, { timeout: 5000 }).catch(() => {});
check('invite: a new link redraws in place — still exactly one dialog, now two links',
  await p.evaluate(() => ({ dialogs: document.querySelectorAll('[role="dialog"]').length, links: document.querySelectorAll('[role="dialog"] code').length })),
  { dialogs: 1, links: 2 });
await p.click('.sr-sheet-x');
check('invite: the close button removes it and unlocks the page',
  await p.evaluate(() => ({ open: !!document.querySelector('[role="dialog"]'), locked: document.documentElement.classList.contains('modal-open') })),
  { open: false, locked: false });
await p.click('#invite-btn');
await p.waitForSelector('[role="dialog"]');
await p.keyboard.press('Escape');
check('invite: Escape closes it', await p.locator('[role="dialog"]').count(), 0);

/* --- Give access ---------------------------------------------------------- */
await toBottom();
await p.click('button[data-act="promote"][data-name="Chidi"]');
await p.waitForSelector('[role="dialog"] #pr-role', { timeout: 5000 }).catch(() => {});
check('give access: opens a dialog inside the viewport, from the bottom of the roster', await inView(), (v) => v.count === 1 && v.fits);
check('give access: nothing is prepended to the page any more',
  await p.evaluate(() => !!document.querySelector('#sr-body #promote-panel')), false);

await p.selectOption('#pr-role', 'coordinator');
await p.selectOption('#pr-kind', 'ward');
const ready = (step) => p.waitForFunction((s) => {
  const el = document.querySelector(`#pr-chain select[data-step="${s}"]`);
  return el && !el.disabled && el.options.length > 1;
}, step, { timeout: 5000 });
await ready('lga');
const lgaSel = await p.$('#pr-chain select[data-step="lga"]');
await p.selectOption('#pr-chain select[data-step="lga"]', 'Oshimili North');
await ready('ward');
check('picker: the answered LGA select is the SAME element after the ward list appears (no rebuild flicker)',
  await lgaSel.evaluate((el) => el.isConnected && el.value), 'Oshimili North');

// Away and back: the first LGA's wards must come from the cache, not the network.
await p.selectOption('#pr-chain select[data-step="lga"]', 'Ika South');
await ready('ward');
await p.selectOption('#pr-chain select[data-step="lga"]', 'Oshimili North');
await ready('ward');
check('picker: a list already fetched is not fetched again',
  hits.get('GET /api/groups/7/coverage?lga=Oshimili+North'), 1);
check('picker: the ward list follows the LGA it now sits under',
  await p.$$eval('#pr-chain select[data-step="ward"] option', (os) => os.map((o) => o.value).filter(Boolean)), ['Akwukwu', 'Ebu']);

await p.selectOption('#pr-chain select[data-step="ward"]', 'Ebu');
await p.click('#pr-go');
await p.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 5000 }).catch(() => {});
check('give access: the grant names the ward AND its local government', posted,
  (x) => x && x.role === 'coordinator' && x.scope_kind === 'ward' && x.scope_value === 'Ebu' && x.scope_lga === 'Oshimili North');
check('give access: the dialog closes on success', await p.locator('[role="dialog"]').count(), 0);

/* --- Map taps ------------------------------------------------------------- */
const tap = await p.evaluate(() => {
  const host = document.createElement('div');
  host.innerHTML = `<svg class="sr-map" viewBox="0 0 100 50">
    <path d="M0 0H40V40H0Z"><title>Akwukwu — 10% reported</title></path>
    <path d="M50 0H90V40H50Z"><title>Ebu — 60% reported</title></path></svg>`;
  document.body.appendChild(host);
  wireMapTaps(host);
  const info = host.querySelector('.sr-map-info');
  const [a, bb] = host.querySelectorAll('path');
  const before = info.textContent;
  bb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const afterB = { text: info.textContent, picked: bb.classList.contains('is-picked') };
  a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const afterA = { text: info.textContent, onlyA: a.classList.contains('is-picked') && !bb.classList.contains('is-picked') };
  host.remove();
  return { before, afterB, afterA };
});
check('map: before any tap, it says the map can be tapped', tap.before, (t) => /tap/i.test(t));
check('map: tapping a shape writes out that shape’s own numbers', tap.afterB, { text: 'Ebu — 60% reported', picked: true });
check('map: tapping another moves the highlight, never leaves two', tap.afterA, { text: 'Akwukwu — 10% reported', onlyA: true });

/* --- Map zoom --------------------------------------------------------------
   Units bunch where people live, and on a phone card a bunch is one smudge no
   finger can tap apart. B sits at (60,60) so zooming onto it needs no clamping
   and the centre can be asserted exactly. */
const zoom = await p.evaluate(() => {
  const host = document.createElement('div');
  host.innerHTML = `<svg class="sr-map" viewBox="0 0 100 100" style="width:300px;height:300px">
    <circle cx="20" cy="20" r="2"><title>A</title></circle>
    <circle cx="60" cy="60" r="2"><title>B</title></circle></svg>`;
  document.body.appendChild(host);
  wireMapTaps(host);
  wireMapZoom(host);
  const svg = host.querySelector('svg');
  const vb = () => svg.getAttribute('viewBox').split(' ').map(Number);
  const btn = (z) => host.querySelector(`[data-z="${z}"]`);
  const start = { out: btn('out').disabled, all: btn('all').disabled };
  btn('in').click();
  const once = { vb: vb(), r: +svg.querySelector('circle').getAttribute('r'), out: btn('out').disabled };
  btn('all').click();
  svg.querySelectorAll('circle')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  btn('in').click();
  const v = vb();
  const centre = [+(v[0] + v[2] / 2).toFixed(2), +(v[1] + v[3] / 2).toFixed(2)];
  btn('all').click();
  const reset = vb();
  host.remove();
  return { start, once, centre, reset };
});
check('zoom: − and reset are disabled while the whole map shows', [zoom.start.out, zoom.start.all], [true, true]);
check('zoom: + shows half the width, and − becomes available', [zoom.once.vb[2], zoom.once.out], [50, false]);
check('zoom: dots keep their size on SCREEN (radius halves as the map doubles)', zoom.once.r, 1);
check('zoom: + after tapping a unit zooms onto that unit', zoom.centre, [60, 60]);
check('zoom: reset returns to the whole map', zoom.reset, [0, 0, 100, 100]);

check('no page errors across the whole run', errs, []);

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall dialog and map checks passed');
process.exit(fail ? 1 : 0);
