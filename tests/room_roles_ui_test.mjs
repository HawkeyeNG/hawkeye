/**
 * WHAT EACH ROLE ACTUALLY SEES on the Team tab, read off the rendered page.
 *
 * The server's ladder is checked in role_ladder_test.mjs. This checks the other
 * half, which fails differently and more visibly: a room that OFFERS an action
 * the server will refuse teaches its managers that the room is broken, and a
 * room that hides one they are entitled to is a permission nobody can find.
 *
 * It also renders the Team tab in Hausa. Every string on this screen is painted
 * by script, so the markup sweep never sees any of it and a missing key shows up
 * as English on a Hausa page and nowhere else — the exact defect that took five
 * rounds to stop coming back. Asserted as "no English button labels survive",
 * with a CONTROL that runs the same page in English and demands they do.
 *
 *   node tests/room_roles_ui_test.mjs
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
  party: null, slug: 'adaeze-2027', scope_kind: 'state', members: 3, assigned: 2,
  zones: ['South South'], me_id: 1,
};
const MANAGERS = [
  { observer_id: 1, role: 'owner', scope_kind: '', scope_value: '' },
  { observer_id: 2, role: 'coordinator', scope_kind: 'lga', scope_value: 'Aniocha North' },
];
const MEMBERS = [
  { observer_id: 1, label: 'Ada', role: 'owner', shared: 0, joined_at: 1, assign_state: '', assigned: null, reported: null, status: 'unassigned' },
  { observer_id: 2, label: 'Bode', role: 'coordinator', shared: 0, joined_at: 2, assign_state: '', assigned: null, reported: null, status: 'unassigned' },
  { observer_id: 3, label: 'Chidi', role: null, shared: 0, joined_at: 3, assign_state: '', assigned: null, reported: null, status: 'unassigned' },
];

/* The reader is swapped between page loads; everything else is fixed. */
let ME = { role: 'owner', scope_kind: '', scope_value: '' };
let MEMBER_ONLY = false;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (url === '/api/groups') {
    const row = { id: GROUP.id, name: GROUP.name, kind: GROUP.kind, contest: GROUP.contest, scope: GROUP.scope, slug: GROUP.slug };
    return json(MEMBER_ONLY ? { managing: [], member: [row] } : { managing: [row], member: [] });
  }
  if (url === '/api/groups/7') return json({ ...GROUP, me: ME, managers: MANAGERS });
  if (url === '/api/groups/7/team') return json({ contest: GROUP.contest, members: MEMBERS });
  if (url === '/api/parties') return json([]);
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
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

/** Open the Team tab as `me`, in `lang`, and hand back what is on it. */
async function open(me, lang, memberOnly = false) {
  ME = me;
  MEMBER_ONLY = memberOnly;
  const p = await b.newPage({ viewport: { width: 1200, height: 1400 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  /* authgate.js runs in <head> and bounces a signed-out visitor to the sign-in
     funnel before a line of the room paints, so the page under test is only
     reachable with a token in hand. It PARSES the JWT and never verifies it --
     the stub server stands in for the backend -- so a far-future exp is all it
     needs. Without this every assertion below reads an empty page, and the
     failures would point at the room instead of at the harness. */
  await p.addInitScript((l) => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    try {
      localStorage.setItem("hawkeye_lang", l);   // underscore: that is i18n.js KEY, not its event name
      localStorage.setItem("hawkeye_token", enc({ alg: "none" }) + "." + enc({ sub: 1, exp: 4102444800 }) + ".x");
    } catch (e) { /* private mode */ }
  }, lang);
  await p.goto(`${base}/situation-room.html?tab=team`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.sr-tbl, .sr-empty, .sr-msg', { timeout: 10000 }).catch(() => {});
  const out = await p.evaluate(() => {
    const rowFor = (id) => [...document.querySelectorAll('tbody tr')]
      .find((tr) => tr.textContent.includes('#' + id) || tr.textContent.includes(id === 3 ? 'Chidi' : id === 2 ? 'Bode' : 'Ada'));
    const acts = (id) => {
      const tr = rowFor(id);
      return tr ? [...tr.querySelectorAll('[data-act]')].map((x) => x.dataset.act) : null;
    };
    return {
      header: [...document.querySelectorAll('#sr-actions button')].map((x) => x.id),
      onChidi: acts(3),
      onBode: acts(2),
      onSelf: acts(1),
      teamText: (document.getElementById('sr-body') || {}).textContent || '',
      loaded: !!document.querySelector('.sr-tbl'),
    };
  });
  out.errs = errs;
  await p.close();
  return out;
}

/* --- the owner: everything ---------------------------------------------- */
const owner = await open({ role: 'owner', scope_kind: '', scope_value: '' }, 'en');
check('owner: page rendered without throwing', owner.errs, []);
check('owner: team table painted', owner.loaded, true);
check('owner: header has rename and delete', owner.header,
  (h) => h.includes('rename-btn') && h.includes('del-btn') && h.includes('invite-btn'));
check('owner: can give access to a plain member, and remove them', owner.onChidi,
  (a) => a.includes('promote') && a.includes('remove') && a.includes('rename'));
check('owner: can demote the coordinator', owner.onBode, (a) => a.includes('demote'));
check('owner: no promote or remove on their own row', owner.onSelf,
  (a) => !a.includes('promote') && !a.includes('remove') && !a.includes('demote'));

/* --- a manager: coordinators yes, managers and removal no ---------------- */
const mgr = await open({ role: 'manager', scope_kind: '', scope_value: '' }, 'en');
check('manager: no Delete or Rename room in the header', mgr.header,
  (h) => !h.includes('del-btn') && !h.includes('rename-btn') && h.includes('invite-btn'));
check('manager: may give access', mgr.onChidi, (a) => a.includes('promote'));
check('manager: may NOT remove an observer from the roster', mgr.onChidi, (a) => !a.includes('remove'));

/* --- a ward coordinator delegates nobody --------------------------------- */
const ward = await open({ role: 'coordinator', scope_kind: 'ward', scope_value: 'Emu' }, 'en');
check('ward coordinator: may still set a unit and rename', ward.onChidi,
  (a) => a.includes('rename') && (a.includes('set') || a.includes('clear')));
check('ward coordinator: offers no promotion at all', ward.onChidi,
  (a) => !a.includes('promote') && !a.includes('demote') && !a.includes('remove'));

/* --- a plain observer reads and changes nothing -------------------------- */
const obs = await open({ role: 'observer', scope_kind: '', scope_value: '' }, 'en', true);
check('observer: reached the room at all', obs.loaded, true);
check('observer: no row actions anywhere', obs.onChidi, (a) => a === null || a.length === 0);
check('observer: no invite, new-room, delete or sign-out', obs.header,
  (h) => !h.includes('invite-btn') && !h.includes('new-btn') && !h.includes('del-btn') && !h.includes('leave-btn'));
check('observer: told why it is read-only', obs.teamText, (t) => /only its managers/i.test(t));

/* --- and it all translates ------------------------------------------------ */
/* CONTROL FIRST: these words must be PRESENT in English, or "absent in Hausa"
   proves nothing — a typo in the English fallback would pass the Hausa check
   for the wrong reason. */
const WORDS = ['Give access', 'Set unit', 'Remove', 'Rename'];
check('CONTROL: the English page really does say these', owner.teamText,
  (t) => WORDS.every((w) => t.includes(w)));
const ha = await open({ role: 'owner', scope_kind: '', scope_value: '' }, 'ha');
check('Hausa: the team tab rendered', ha.loaded, true);
check('Hausa: no English button labels survive', ha.teamText,
  (t) => WORDS.every((w) => !t.includes(w)));
check('Hausa: the role words are translated too', ha.teamText,
  (t) => t.includes('mamallaki') && !/\bowner\b/.test(t));

/* --- and the way IN to the room ------------------------------------------ */
/* A HIGHLIGHTED HEADING IS NOT A BUTTON. The room was reachable only by tapping
   the campaign's name, and a coloured heading reads as a heading — so people who
   had access never found the room they had access to. */
MEMBER_ONLY = true;
{
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(() => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
  });
  await p.goto(`${base}/my-groups.html`, { waitUntil: 'networkidle' });
  const links = await p.evaluate(() => [...document.querySelectorAll('.mg a')].map((a) => ({
    href: a.getAttribute('href'), text: a.textContent.trim(), btn: a.classList.contains('btn'),
  })));
  check('my groups: rendered without throwing', errs, []);
  check('my groups: a real button opens the room, not just the heading', links,
    (l) => l.some((x) => x.btn && x.href === '/room/adaeze-2027' && /situation room/i.test(x.text)));
  /* The LEADING SLASH is load-bearing: native.js rewrites it to the live host,
     and the Lite strip gate asserts it, because the room is not in that bundle. */
  check('my groups: every room link keeps its leading slash', links,
    (l) => l.every((x) => !/room\//.test(x.href) || x.href.startsWith('/room/')));
  await p.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall room-role UI checks passed');
process.exit(fail ? 1 : 0);
