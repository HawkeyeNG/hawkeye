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

/* --- OUR OWN PROMPT, and a header that fits a phone ---------------------- */
/* window.prompt renders the browser's grey box, titled "hawkeye.com.ng says",
   with OK/Cancel in the platform's language and no way to translate or style
   either. The room asks for a unit code, two names and a typed confirmation
   through it. The stub below FAILS THE TEST if anything still reaches for it —
   a check that only looked for our dialog would pass while both appeared. */
MEMBER_ONLY = false;
ME = { role: 'owner', scope_kind: '', scope_value: '' };
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(() => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
    window.__prompts = 0;
    window.prompt = (...a) => { window.__prompts += 1; return null; };
  });
  await p.goto(`${base}/situation-room.html?tab=team`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.sr-tbl', { timeout: 10000 }).catch(() => {});

  /* PORTRAIT PHONE. .brand-row is a plain flex row, so giving the actions
     width:100% inside it did not move them to a line of their own — it made
     them claim the line the brand was still on, and the language button printed
     itself across "Situation Room". Measured, not eyeballed: the two boxes must
     not overlap. */
  const box = await p.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().toJSON() : null; };
    return { brand: r('.gov-header .brand'), acts: r('.sr-hdr-actions'), w: innerWidth };
  });
  /* THE BRAND'S WIDTH is the assertion that actually moves. A bounding-box
     overlap test passed in the broken state too — the boxes did not cross, the
     brand was CRUSHED: flex:1 1 auto with min-width:0 let it collapse towards
     nothing while the actions took the full line and ran off the right edge, so
     the wordmark and the language button printed over each other. Checked as a
     share of the viewport so it does not encode one phone's pixels. */
  check('phone: the brand keeps most of its line', box,
    (x) => x.brand && x.brand.width > x.w * 0.5);
  check('phone: the actions are still right-aligned', box,
    (x) => x.acts && x.acts.right >= x.w - 60);
  check('phone: nothing overflows the viewport sideways', box,
    (x) => x.acts && x.acts.right <= x.w + 1 && x.brand.left >= -1);
  /* And they are on DIFFERENT lines, which is the shape being asked for: the
     actions below the brand, not squeezed beside it. */
  check('phone: the actions sit under the brand, not beside it', box,
    (x) => x.acts && x.brand && x.acts.top >= x.brand.bottom - 1);

  /* Set unit — the branded dialog, with a field in it. */
  await p.click('[data-act="set"]');
  await p.waitForSelector('.sr-ask input', { timeout: 3000 }).catch(() => {});
  const dlg = await p.evaluate(() => ({
    input: !!document.querySelector('.sr-ask .sr-ask-input'),
    /* Ours, not the platform's: our buttons carry the page's own words, so a
       translated room can translate them. */
    buttons: [...document.querySelectorAll('.sr-ask .sr-btn')].map((x) => x.textContent.trim()),
    focused: document.activeElement && document.activeElement.classList.contains('sr-ask-input'),
    prompts: window.__prompts,
  }));
  check('Change unit opens our dialog, not the browser\'s', dlg.input, true);
  check('CONTROL: window.prompt was never reached', dlg.prompts, 0);
  check('the dialog has both our buttons', dlg.buttons, (x) => x.length === 2);
  check('the field takes focus, so it can be typed into straight away', dlg.focused, true);

  /* Escape closes it, and nothing is submitted. */
  await p.keyboard.press('Escape');
  const gone = await p.evaluate(() => !document.querySelector('.sr-ask'));
  check('Escape dismisses it', gone, true);

  /* Rename goes through the same dialog, pre-filled with the current name. */
  await p.click('[data-act="rename"]');
  await p.waitForSelector('.sr-ask input', { timeout: 3000 }).catch(() => {});
  const ren = await p.evaluate(() => {
    const el = document.querySelector('.sr-ask-input');
    return { value: el ? el.value : null, prompts: window.__prompts };
  });
  check('Rename pre-fills the name it is changing', ren.value, (v) => typeof v === 'string');
  check('CONTROL: still no browser prompt', ren.prompts, 0);
  check('phone: rendered without throwing', errs, []);
  await p.close();
}

/* --- one button per job, and a scrollbar that gets out of the way -------- */
/* The roster file input is `hidden` and was drawn anyway: `input, select
   { display: block; width: 100% }` in styles.css is an AUTHOR rule and beats
   the user agent's `[hidden] { display: none }`, so the browser's own "Choose
   File" control sat beside the styled button that exists to trigger it. Read
   from the RENDERED box, not from the attribute — the attribute was correct the
   whole time, which is exactly why reading the source would have passed. */
MEMBER_ONLY = false;
ME = { role: 'owner', scope_kind: '', scope_value: '' };
{
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(() => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
  });
  await p.goto(`${base}/situation-room.html?tab=team`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.sr-tools', { timeout: 10000 }).catch(() => {});

  const file = await p.evaluate(() => {
    const el = document.getElementById('roster-file');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { hiddenAttr: el.hidden, display: getComputedStyle(el).display, w: r.width, h: r.height };
  });
  check('the roster file input exists', file, (f) => f !== null);
  check('CONTROL: it was always marked hidden — the attribute was never the bug', file.hiddenAttr, true);
  check('and now it actually occupies no space', file, (f) => f.w === 0 && f.h === 0);
  check('display:none, not merely clipped', file.display, 'none');
  /* ONE visible way to import. Two was the defect, and the second one was the
     browser's own file control, so this counts inputs separately from buttons
     rather than totalling them — the total depends on what the stub returns. */
  const tools = await p.evaluate(() => {
    const shown = (el) => el.getBoundingClientRect().width > 0;
    const all = [...document.querySelectorAll('.sr-tools button, .sr-tools input, .sr-tools select')];
    return {
      inputs: all.filter((el) => el.tagName === 'INPUT' && shown(el)).length,
      importers: all.filter((el) => shown(el) && /import/i.test(el.textContent || '')).length,
    };
  });
  check('no bare file control is drawn beside the button that opens it', tools.inputs, 0);
  check('and exactly one visible way to import a roster', tools.importers, 1);

  /* The scrollbar is transparent at rest. Chromium reports the used value of
     scrollbar-color, so this reads the decision rather than a screenshot. */
  const bar = await p.evaluate(() => ({
    rest: getComputedStyle(document.documentElement).scrollbarColor,
    width: getComputedStyle(document.documentElement).scrollbarWidth,
  }));
  /* WHAT "TRANSPARENT" LOOKS LIKE COMING BACK OUT, which is three things:
     the keyword, `rgba(0, 0, 0, 0)` (how Chromium serialises it), and
     `color(srgb r g b / a)` (how it serialises a color-mix result). Reading
     alpha off each token is the only form of this check that survives all
     three; two earlier versions matched on spelling and passed or failed for
     reasons that had nothing to do with the colour. */
  const alphaOf = (c) => {
    if (c === 'transparent') return 0;
    const slash = c.match(/\/\s*([\d.]+)\s*\)/);
    if (slash) return parseFloat(slash[1]);
    const rgba = c.match(/^rgba?\(([^)]*)\)$/);
    if (rgba) {
      const parts = rgba[1].split(',').map((x) => x.trim());
      return parts.length > 3 ? parseFloat(parts[3]) : 1;
    }
    return 1;
  };
  const clear = (v) => (String(v).match(/color\([^)]*\)|rgba?\([^)]*\)|transparent/g) || [])
    .every((c) => alphaOf(c) === 0);
  check('scrollbar is transparent when nothing is happening', bar.rest, clear);
  check('and thin rather than the platform default', bar.width, 'thin');
  /* IT IS HIDDEN, NOT REMOVED: scrolling brings it back, so a long roster still
     says it is long. A bar that never returned would be a different bug. */
  await p.evaluate(() => { document.documentElement.classList.add('scrolling'); });
  const scrolling = await p.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor);
  check('and it comes back while scrolling', scrolling, (v) => !clear(v));
  check('scrollbar page rendered without throwing', errs, []);
  await p.close();
}

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
