/**
 * FLOW WALKTHROUGH — group `rooms`: joining a room, room check-in, running a
 * situation room, and a room notification landing in the right place — on web,
 * Lite and native.
 *
 *   node rooms.mjs [--surface web,lite,native] [--lang en,ha] [--flow 1,2,3,4]
 *
 * Output: tests/e2e/out/flows/rooms/ — <flow>-<NN>-<step>-<surface>-<lang>.png,
 * steps.json (per flow, per surface: ordered steps), checks.json (every check
 * with its control) and findings.json.
 *
 * SAFETY (shared brief): every context goes through installGuard
 * (tests/design-audit/lib.mjs). Every write a flow needs — join, accept, leave,
 * check-in, create/delete room, invite links, code check/withdraw/restore — is
 * answered by a FIXTURE below and never reaches production. No credential is
 * typed anywhere: the signed-out round trips are followed up to the sign-in
 * form, the `next` the form would honour is READ from the page, and the
 * signed-in half is entered with the fake token, exactly as the page would be
 * entered after a real sign-in.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  chromium, CHROME, SITE, REPO, VIEWPORTS, installGuard, contextOptions, webInit, nativeInit, sleep, log, SAFETY, UA_DESKTOP, FAKE_TOKEN,
} from '../../design-audit/lib.mjs';
import { makeFixtures } from '../../design-audit/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const SURFACES = arg('surface', 'web,lite,native').split(',');
const LANGS = arg('lang', 'en,ha').split(',');
const FLOWS = arg('flow', '1,2,3,4').split(',');
/* --only name,name: re-walk just these sub-walks (function names in rooms-flows.mjs);
   earlier results for everything else are kept as they are. */
const ONLY = arg('only', null) ? arg('only').split(',') : null;
const OUTDIR = path.join(REPO, 'tests/e2e/out/flows/rooms');
const NATIVE_DIR = process.env.NATIVE_DIR || '/home/elrio/hawkeye/tmp/design-audit-native-web';
fs.mkdirSync(OUTDIR, { recursive: true });

const NI18N = Object.fromEntries(['en', 'ha'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `native/src/lib/i18n/${l}.json`), 'utf8'))]));
const WI18N = Object.fromEntries(['en', 'ha'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `app/i18n/${l}.json`), 'utf8'))]));
/** Native string, {name}-style placeholders filled. */
const nt = (lang, key, vars = {}) => {
  let s = NI18N[lang][key] || NI18N.en[key] || key;
  for (const [a, b] of Object.entries(vars)) s = s.split(`{${a}}`).join(b);
  return s;
};
/** Web string, the same way (HTML stripped: we compare against innerText). */
const wt = (lang, key, vars = {}) => {
  let s = WI18N[lang][key] || WI18N.en[key] || key;
  for (const [a, b] of Object.entries(vars)) s = s.split(`{${a}}`).join(b);
  return s.replace(/<[^>]+>/g, '');
};

// ------------------------------------------------------------------ records
const STEPS = [];
const CHECKS = [];
const FINDINGS = new Map();

function recorder(flow, surface, lang, vp = 's360', variant = '') {
  const rec = { flow, surface, lang, vp, variant, steps: [] };
  STEPS.push(rec);
  let n = 0;
  return {
    rec,
    async step(page, name, { screen = '', asked = '', tap = '', note = '' } = {}) {
      const f = `${flow}${variant ? '-' + variant : ''}-${String(++n).padStart(2, '0')}-${slugify(name)}-${surface}-${lang}.png`;
      const shot = () => page.screenshot({ path: path.join(OUTDIR, f), timeout: 15000 }).then(() => true).catch(() => false);
      if (!(await shot())) { await sleep(1000); await shot(); }
      let url = '';
      try { const u = new URL(page.url()); url = u.pathname + u.search; } catch { url = page.url(); }
      rec.steps.push({ n, name, screen, asked, tap, note, url, img: f });
      return f;
    },
  };
}
const slugify = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);

/** A check: `flagged` true means the problem is present. `control` proves the check can fail the other way. */
function check(id, { flagged, detail, control = null, evidence = [] }) {
  CHECKS.push({ id, flagged: !!flagged, detail, control, evidence });
  return !!flagged;
}
function finding(f) {
  const prev = FINDINGS.get(f.id);
  if (prev) {
    for (const s of f.surfaces || []) if (!prev.surfaces.includes(s)) prev.surfaces.push(s);
    for (const e of f.evidence || []) if (!prev.evidence.includes(e)) prev.evidence.push(e);
    return;
  }
  if (!f.title) return; // a merge-only call for a finding that was never raised
  FINDINGS.set(f.id, { needsDevice: false, ...f, surfaces: [...(f.surfaces || [])], evidence: (f.evidence || []).map((e) => e) });
}
const ev = (f) => `tests/e2e/out/flows/rooms/${f}`;

// ------------------------------------------------------------------ fixture data
const NOW = Date.now();
const H = 3_600_000;
const UNIT = { pu_code: '24-16-05-007', name: 'LGEA Primary School, Ojota I', ward: 'Ojota', lga: 'Kosofe', state: 'Lagos' };
const UNIT2 = { pu_code: '24-16-05-011', name: 'Community Hall, Ogudu', ward: 'Ojota', lga: 'Kosofe', state: 'Lagos' };

const TOK = {
  ok: 'tokOKa1b2c3d4e5f6g7h8i9', gone: 'tok404a1b2c3d4e5f6g7h8i', rev: 'tokREVa1b2c3d4e5f6g7h8i', exp: 'tokEXPa1b2c3d4e5f6g7h8i',
  held: 'tokHELDa1b2c3d4e5f6g7h8', err: 'tok500a1b2c3d4e5f6g7h8i', hang: 'tokHANGa1b2c3d4e5f6g7h8',
  postExp: 'tokPEXPa1b2c3d4e5f6g7h8', postRev: 'tokPREVa1b2c3d4e5f6g7h8', postErr: 'tokP500a1b2c3d4e5f6g7h8', postNet: 'tokPNETa1b2c3d4e5f6g7h8',
};
const JOIN_ROOM = { group_id: 44, name: 'Ikeja Watch Collective', kind: 'cso', contest: 'GOV', scope: 'Lagos', scope_label: 'Lagos', slug: 'ikeja-watch' };

const memberRow = (o) => ({
  id: 12, name: 'Lagos Citizens Observer Network', kind: 'cso', contest: 'GOV', scope: 'Lagos', slug: 'lagos-citizens', manages: null,
  assigned_pu: UNIT.pu_code, assign_state: 'proposed', joined_at: NOW - 10 * 24 * H, member_state: '',
  assigned_name: UNIT.name, assigned_ward: UNIT.ward, assigned_lga: UNIT.lga, assigned_state: UNIT.state,
  scope_label: 'Lagos', party: null, party_claim: null, party_state: null, org: 'Sample Civic Trust', org_claim: null, org_state: 'verified', org_listed: true,
  ...o,
});
const INVITED_ROW = memberRow({ id: 19, name: 'Kosofe Ward Volunteers', contest: 'PRES', scope: '', scope_label: '', slug: 'kosofe-volunteers',
  assigned_pu: null, assign_state: '', member_state: 'invited', assigned_name: null, assigned_ward: null, assigned_lga: null, assigned_state: null, org: null, org_state: null, org_listed: null });
const JOINED_ROW = memberRow({ id: JOIN_ROOM.group_id, name: JOIN_ROOM.name, slug: JOIN_ROOM.slug, joined_at: NOW, assign_state: 'proposed' });

/**
 * One context's server. `state` is mutated by the writes it answers, so a join
 * shows up on My Groups afterwards, a leave takes the row away, and so on —
 * what the real routes do (backend/src/routes/groups.js), on invented rows.
 * `over` lets a test force one answer: over['POST /api/join/x'] = { status, json }.
 */
function roomServer(opts = {}) {
  const st = {
    member: opts.member ? opts.member.map((x) => ({ ...x })) : [memberRow(), { ...INVITED_ROW }],
    managing: opts.managing ? opts.managing.map((x) => ({ ...x })) : [],
    rooms: opts.rooms || null, // /api/my/rooms override
    notifications: opts.notifications || null,
    calls: [],
    over: { ...(opts.over || {}) },
    groupDetail: opts.groupDetail || {},
    team: opts.team || {},
    invites: opts.invites || {},
    codes: opts.codes || {},
  };
  const base = makeFixtures('populated');
  const J = (status, json) => ({ status, json });
  const fx = (method, url) => {
    const p = url.pathname;
    const key = `${method} ${p}`;
    st.calls.push(key + (url.search || ''));
    if (st.over[key] !== undefined) {
      const o = st.over[key];
      return typeof o === 'function' ? o(url) : o;
    }
    // --- join ---------------------------------------------------------------
    const jm = /^\/api\/join\/([^/]+)$/.exec(p);
    if (jm) {
      const t = decodeURIComponent(jm[1]);
      if (method === 'GET') {
        if (t === TOK.gone) return J(404, { error: 'no_such_invite' });
        if (t === TOK.rev) return J(410, { error: 'invite_revoked' });
        if (t === TOK.exp) return J(410, { error: 'invite_expired' });
        if (t === TOK.held) return J(409, { error: 'room_pending_verification' });
        if (t === TOK.err) return J(500, { error: 'internal' });
        return J(200, JOIN_ROOM);
      }
      if (method === 'POST') {
        if (t === TOK.postExp) return J(410, { error: 'invite_expired' });
        if (t === TOK.postRev) return J(410, { error: 'invite_revoked' });
        if (t === TOK.postErr) return J(500, { error: 'internal' });
        if (st.member.some((x) => x.id === JOIN_ROOM.group_id)) return J(200, { ok: true, already: true, group_id: 44, name: JOIN_ROOM.name, proposed_pu: UNIT.pu_code });
        st.member.unshift({ ...JOINED_ROW });
        return J(201, { ok: true, group_id: 44, name: JOIN_ROOM.name, proposed_pu: UNIT.pu_code });
      }
    }
    // --- the observer's own memberships --------------------------------------
    if (method === 'GET' && p === '/api/groups') return J(200, { managing: st.managing, member: st.member });
    const acc = /^\/api\/groups\/(\d+)\/accept$/.exec(p);
    if (acc && method === 'POST') {
      const g = st.member.find((x) => x.id === Number(acc[1]) && x.member_state === 'invited');
      if (!g) return J(404, { error: 'nothing_to_accept' });
      g.member_state = ''; g.joined_at = Date.now(); g.assigned_pu = UNIT.pu_code; g.assign_state = 'proposed'; g.assigned_name = UNIT.name; g.assigned_ward = UNIT.ward; g.assigned_lga = UNIT.lga;
      return J(200, { ok: true });
    }
    const dec = /^\/api\/groups\/(\d+)\/decline$/.exec(p);
    if (dec && method === 'POST') {
      const g = st.member.find((x) => x.id === Number(dec[1]) && x.assigned_pu);
      if (!g) return J(404, { error: 'nothing_to_decline' });
      g.assign_state = 'declined';
      return J(200, { ok: true });
    }
    const mem = /^\/api\/groups\/(\d+)\/membership$/.exec(p);
    if (mem && method === 'DELETE') { st.member = st.member.filter((x) => x.id !== Number(mem[1])); return J(200, { ok: true }); }
    // --- attendance ------------------------------------------------------------
    if (method === 'GET' && p === '/api/my/rooms') {
      if (st.rooms) return J(200, { rooms: st.rooms });
      return J(200, { rooms: st.member.filter((x) => x.member_state === '').map((x) => ({ id: x.id, name: x.name, kind: x.kind, contest: x.contest,
        assigned: x.assigned_pu && x.assign_state !== 'declined' ? { pu_code: x.assigned_pu, name: x.assigned_name, ward: x.assigned_ward, lga: x.assigned_lga, state: x.assigned_state } : null,
        checkedIn: x.checkedIn || null })) });
    }
    if (method === 'POST' && p === '/api/my/check-in') {
      for (const x of st.member) x.checkedIn = { at: Date.now(), standing: 'verified', pu_code: UNIT.pu_code };
      if (st.rooms) for (const r of st.rooms) r.checkedIn = { at: Date.now(), standing: 'verified', pu_code: UNIT.pu_code };
      return J(200, { ok: true, standing: 'verified', rooms: st.member.map((x) => ({ group_id: x.id, standing: 'verified' })) });
    }
    const ci = /^\/api\/groups\/(\d+)\/check-in$/.exec(p);
    if (ci && method === 'POST') {
      const g = st.member.find((x) => x.id === Number(ci[1]));
      if (g) g.checkedIn = { at: Date.now(), standing: 'verified', pu_code: UNIT.pu_code };
      if (st.rooms) for (const r of st.rooms) if (r.id === Number(ci[1])) r.checkedIn = { at: Date.now(), standing: 'verified', pu_code: UNIT.pu_code };
      const tm = st.team[ci[1]];
      if (tm) for (const m of tm.members) if (m.observer_id === 7) m.attendance = { at: Date.now(), standing: 'verified', distanceM: 12, unit: { pu_code: UNIT.pu_code, name: UNIT.name, ward: UNIT.ward }, atAssigned: true };
      return J(200, { ok: true, standing: 'verified', distanceM: 12, atAssignedUnit: true });
    }
    // --- the room itself -------------------------------------------------------
    const gd = /^\/api\/groups\/(\d+)$/.exec(p);
    if (gd && method === 'GET' && st.groupDetail[gd[1]]) return J(200, st.groupDetail[gd[1]]);
    if (gd && method === 'DELETE') {
      const id = Number(gd[1]);
      const n = (st.groupDetail[gd[1]] || {}).members || 0;
      st.managing = st.managing.filter((x) => x.id !== id);
      st.member = st.member.filter((x) => x.id !== id);
      delete st.groupDetail[gd[1]];
      return J(200, { ok: true, removed_members: n });
    }
    const sub = /^\/api\/groups\/(\d+)\/(coverage|activity|tally|discrepancies|incidents|team|sources|invites|wards-geo)$/.exec(p);
    if (sub && method === 'GET') {
      const [, id, what] = sub;
      if (what === 'coverage') return J(200, { level: 'state', contest: 'GOV', area: {}, restricted: false, coordinators: {}, mine: null, my_scope: null, totals: { units: 13325, reported: 0 }, nodes: [] });
      if (what === 'activity') return J(200, { reports: [] });
      if (what === 'tally') return J(200, { contest: 'GOV', unitsReporting: 0, inDispute: 0, national: [] });
      if (what === 'discrepancies') return J(200, { contest: 'GOV', compared: 0, items: [], truncated: false });
      if (what === 'incidents') return J(200, { ours_total: 0, incidents: [] });
      if (what === 'team') return J(200, st.team[id] || { contest: 'GOV', restricted: false, members: [] });
      if (what === 'sources') return J(200, { sources: [] });
      if (what === 'invites') return J(200, st.invites[id] || []);
      if (what === 'wards-geo') return J(200, { wards: [] });
    }
    const inv = /^\/api\/groups\/(\d+)\/invites$/.exec(p);
    if (inv && method === 'POST') {
      const list = (st.invites[inv[1]] = st.invites[inv[1]] || []);
      const token = `tokNEW${String(list.length + 1).padStart(2, '0')}x1y2z3w4v5u6t7`;
      list.unshift({ token, uses: 0, expires_at: Date.now() + 14 * 24 * H, revoked: 0, created_at: Date.now() });
      return J(201, { token, expires_at: Date.now() + 14 * 24 * H });
    }
    const invd = /^\/api\/groups\/(\d+)\/invites\/([^/]+)$/.exec(p);
    if (invd && method === 'DELETE') {
      for (const t of st.invites[invd[1]] || []) if (t.token === invd[2]) t.revoked = 1;
      return J(200, { ok: true });
    }
    const mgr = /^\/api\/groups\/(\d+)\/managers\/(\d+)$/.exec(p);
    if (mgr && method === 'DELETE') {
      const id = Number(mgr[1]);
      if (Number(mgr[2]) === 7) { st.managing = st.managing.filter((x) => x.id !== id); st.member = st.member.filter((x) => x.id !== id); delete st.groupDetail[mgr[1]]; }
      return J(200, { ok: true });
    }
    const oc = /^\/api\/groups\/(\d+)\/org-codes\/(check|withdraw|restore)$/.exec(p);
    if (oc && method === 'POST') return st.codes[oc[2]] ? st.codes[oc[2]]() : J(403, { error: 'not_allowed' });
    if (method === 'POST' && p === '/api/groups') return st.over.create ? st.over.create() : J(500, { error: 'no fixture' });
    if (method === 'GET' && p === '/api/group-races') {
      const c = url.searchParams.get('contest');
      if (c === 'PRES') return J(200, { kind: 'national', column: '', states: [], races: [] });
      return J(200, { kind: 'state', column: 'state', states: ['Lagos', 'Ogun', 'Oyo'], races: ['Lagos', 'Ogun', 'Oyo'] });
    }
    if (method === 'GET' && p === '/api/notifications' && st.notifications) return J(200, st.notifications);
    if (method === 'POST' && p === '/api/notifications/read') return J(200, { ok: true });
    return base(method, url);
  };
  return { st, fx };
}

// ------------------------------------------------------------------ browser plumbing
const browser = await chromium.launch({ executablePath: CHROME, args: ['--font-render-hinting=none', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let nativeServer = null;
let NATIVE_BASE = '';

/** The native export, with /join/<token> served by join/[token].html (expo's dynamic route). */
function startNative(dir) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(dir, url === '/' ? 'index.html' : url);
    if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
    if (/^\/join\/[^/]+$/.test(url)) f = path.join(dir, 'join', '[token].html');
    else if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (fs.existsSync(`${f}.html`)) f = `${f}.html`;
      else if (fs.existsSync(path.join(f, 'index.html'))) f = path.join(f, 'index.html');
      else f = path.join(dir, '+not-found.html');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/**
 * A page on one surface. `server` is a roomServer(); `extra(ctx)` adds routes
 * AFTER the guard (Playwright gives the later route precedence) — aborts and
 * hangs for the failure cases.
 */
async function open(surface, { lang = 'en', signedIn = true, vp = 's360', server = roomServer(), geo = true, extra = null, desktop = false } = {}) {
  const V = VIEWPORTS[vp];
  const o = contextOptions(V, { theme: 'dark', mobile: !desktop, ua: desktop ? UA_DESKTOP : undefined });
  if (!geo) o.permissions = [];
  else o.permissions = ['geolocation', 'camera', 'clipboard-read', 'clipboard-write'];
  const ctx = await browser.newContext(o);
  await installGuard(ctx, { signedIn, crossOrigin: surface === 'native', fixtures: server.fx });
  // Never follow a messenger deep link (brief): anything that tries is stopped here.
  await ctx.route(/^(https?:\/\/(wa\.me|t\.me|api\.whatsapp\.com)\/)/, (r) => r.abort('blockedbyclient'));
  const init = surface === 'native' ? nativeInit({ signedIn, lang }) : webInit({ lite: surface === 'lite', signedIn, lang });
  await ctx.addInitScript(init.script, init.arg);
  // After the storage/shell init (so a Capacitor stub exists to extend) and after
  // the guard (so its routes win): the per-test aborts, hangs and plugin stubs.
  if (extra) await extra(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => {
    const m = String(e.message || e).slice(0, 200);
    // React #418/#419/#423/#425: the static export's pre-rendered HTML not
    // matching a client that reads storage (signed in) or a dynamic route —
    // an artifact of serving the export, not of the app on a phone.
    if (surface === 'native' && /Minified React error #4(18|19|23|25)/.test(m)) return;
    const at = String(e.stack || '').split('\n').slice(1, 3).map((x) => x.trim()).join(' ; ');
    let where = '';
    try { where = new URL(page.url()).pathname; } catch { /* */ }
    errors.push(`${m} [${where}] ${at}`.slice(0, 400));
  });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  return { ctx, page, errors, server };
}

const text = (page) => page.evaluate(() => document.body.innerText).catch(() => '');
const has = async (page, s) => (await text(page)).includes(s);
async function waitText(page, s, timeout = 12000) {
  return page.waitForFunction((t) => document.body && document.body.innerText.includes(t), s, { timeout }).then(() => true).catch(() => false);
}
async function waitAny(page, list, timeout = 12000) {
  return page.waitForFunction((ts) => ts.some((t) => document.body && document.body.innerText.includes(t)), list, { timeout }).then(() => true).catch(() => false);
}
/** Web: the page's language has landed (i18n.js sets <html lang>). */
async function webLang(page, lang) {
  if (lang === 'en') return;
  await page.waitForFunction((l) => document.documentElement.lang === l, lang, { timeout: 12000 }).catch(() => {});
  await sleep(400);
}
async function gotoWeb(page, p, lang) {
  await page.goto(SITE + p, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await webLang(page, lang);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}
async function gotoNative(page, p) {
  await page.goto(NATIVE_BASE + p, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 20000 }).catch(() => {});
  await sleep(1800);
}
/** Native: tap the first VISIBLE element whose text is exactly `label`. */
async function ntap(page, label, { exact = true, first = false } = {}) {
  const loc = page.getByText(label, { exact });
  const n = await loc.count().catch(() => 0);
  // Last match by default: a confirm sheet's button is drawn after the list
  // button that opened it. `first` for a list, top to bottom.
  for (let k = 0; k < n; k++) {
    const l = loc.nth(first ? k : n - 1 - k);
    if (await l.isVisible().catch(() => false)) { await l.click({ timeout: 6000 }).catch(() => {}); return true; }
  }
  return false;
}
const visible = async (page, label, exact = true) => {
  const loc = page.getByText(label, { exact });
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
  return false;
};
/** The web dialog (dialog.js): its message, then press OK / Cancel. */
async function webDialog(page, press = 'ok', timeout = 6000) {
  const box = page.locator('.hk-dlg').last();
  const ok = await box.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  if (!ok) return null;
  const msg = (await box.innerText().catch(() => '')).trim();
  if (press) await box.locator(press === 'ok' ? '.hk-dlg-ok' : '.hk-dlg-cancel').click().catch(() => {});
  await sleep(300);
  return msg;
}

/**
 * THE STUCK-STATE DETECTOR: does the page still say it is loading/checking after
 * `ms`? Controlled in flow 1 against a request that never answers (must be
 * stuck) and one that answers (must not be).
 */
const LOADING_WORDS = ['Loading…', 'Checking that invitation…', 'Joining…', 'Ana lodawa', 'Ana dubawa'];
async function stuck(page, ms = 9000, words = LOADING_WORDS) {
  await sleep(ms);
  const t = await text(page);
  return words.some((w) => t.includes(w));
}

/**
 * ENGLISH LEFT IN A HAUSA SCREEN: visible lines that are exactly an English
 * string from app/i18n/en.json (or native en.json) whose Hausa differs.
 * Control: the same detector run on the English render of the page must fire.
 */
const EN_LINES = new Map();
for (const [dict, haDict] of [[WI18N.en, WI18N.ha], [NI18N.en, NI18N.ha]]) {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || v.length < 6 || /\{/.test(v)) continue;
    const plain = v.replace(/<[^>]+>/g, '').trim();
    if (haDict[k] && haDict[k] !== v && !EN_LINES.has(plain)) EN_LINES.set(plain, k);
  }
}
async function englishLeft(page) {
  const t = await text(page);
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
  return [...new Set(lines.filter((l) => EN_LINES.has(l)))];
}

// ------------------------------------------------------------------ run
const runs = [];
const want = (f) => FLOWS.includes(String(f));
try {
  if (SURFACES.includes('native')) {
    nativeServer = await startNative(NATIVE_DIR);
    NATIVE_BASE = `http://127.0.0.1:${nativeServer.address().port}`;
  }
  const flows = await import('./rooms-flows.mjs');
  const H_ = { open, text, has, waitText, waitAny, webLang, gotoWeb, gotoNative, ntap, visible, webDialog, stuck, englishLeft, recorder, check, finding, ev, nt, wt,
    roomServer, memberRow, INVITED_ROW, JOINED_ROW, JOIN_ROOM, TOK, UNIT, UNIT2, NOW, H, SITE, OUTDIR, sleep, log, NATIVE_BASE: () => NATIVE_BASE, SAFETY, FAKE_TOKEN,
    on: (name) => !ONLY || ONLY.includes(name) };
  for (const f of ['1', '2', '3', '4']) {
    if (!want(f)) continue;
    log(`flow ${f}`);
    await flows[`flow${f}`](H_, { surfaces: SURFACES, langs: LANGS });
  }
} catch (e) {
  console.error('RUN ERROR', e);
  runs.push({ error: String(e.stack || e) });
} finally {
  await browser.close().catch(() => {});
  if (nativeServer) nativeServer.close();
  /* A PARTIAL RUN (--flow / --surface) REPLACES ONLY WHAT IT WALKED: earlier
     results for other flows, and for other surfaces of the same flow, are kept. */
  const prev = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(OUTDIR, f), 'utf8')); } catch { return d; } };
  const ran = (flow) => FLOWS.includes(String(flow).split('-')[0]);
  // Steps: one record per (flow, surface, lang, variant); a re-walk replaces its own.
  const key = (r) => `${r.flow}|${r.surface}|${r.lang}|${r.variant}`;
  const fresh = new Set(STEPS.map(key));
  const steps = prev('steps.json', []).filter((r) => !fresh.has(key(r))
    && !(!ONLY && ran(r.flow) && SURFACES.includes(r.surface) && LANGS.includes(r.lang))).concat(STEPS);
  // Checks: by id (ids carry their surface/lang).
  const freshIds = new Set(CHECKS.map((c) => c.id));
  const checks = (prev('checks.json', {}).checks || []).filter((c) => !freshIds.has(c.id)).concat(CHECKS);
  const findings = [];
  for (const f of prev('findings.json', [])) {
    if (!ran(f.flow) || ONLY) { findings.push(f); continue; }
    const surfaces = f.surfaces.filter((s) => !SURFACES.includes(s));
    if (!surfaces.length) continue;
    findings.push({ ...f, surfaces, evidence: f.evidence.filter((e) => !SURFACES.some((s) => e.includes(`-${s}-`))) });
  }
  for (const f of FINDINGS.values()) {
    const old = findings.find((x) => x.id === f.id);
    if (old) { old.surfaces = [...new Set([...old.surfaces, ...f.surfaces])]; old.evidence = [...new Set([...old.evidence, ...f.evidence])]; } else findings.push(f);
  }
  // Evidence: enough to see it, not every language and surface it repeated on.
  for (const f of findings) f.evidence = f.evidence.slice(0, 6);
  const order = { P1: 1, P2: 2, P3: 3 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity]) || String(a.flow).localeCompare(String(b.flow)));
  fs.writeFileSync(path.join(OUTDIR, 'steps.json'), JSON.stringify(steps, null, 1));
  fs.writeFileSync(path.join(OUTDIR, 'checks.json'), JSON.stringify({ checks, runs, safety: { ...SAFETY, unknownAuth: [...SAFETY.unknownAuth] } }, null, 1));
  fs.writeFileSync(path.join(OUTDIR, 'findings.json'), JSON.stringify(findings, null, 1));
  log(`steps ${STEPS.length} · checks ${CHECKS.length} (${CHECKS.filter((c) => c.flagged).length} flagged) · findings ${FINDINGS.size}`);
  log(`safety: passGet=${SAFETY.passGet} fixtures=${SAFETY.fixtures} blockedWrites=${SAFETY.blockedWrites.length} sentry=${SAFETY.sentry}`);
  if (SAFETY.blockedWrites.length) log('blocked writes:', SAFETY.blockedWrites.slice(0, 20).join(' | '));
}
process.exit(0);
