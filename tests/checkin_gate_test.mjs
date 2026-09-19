/**
 * THE GATE: check-in appears for people who have a coordinator, and for nobody
 * else.
 *
 * This is the assertion the feature lives or dies on. Hawkeye's premise is that
 * every citizen is an observer; showing a lone voter a button that says "let
 * your coordinator know you have arrived" would invent an authority over them
 * that does not exist, and would be the first place the product implied that
 * reporting is something you do for somebody.
 *
 * So the control here is the ORDINARY observer. If the card renders for them,
 * the feature is wrong no matter how well it works for an agent.
 *
 * The decision is the SERVER'S — /api/my/rooms is empty for a non-member — and
 * this test drives both answers from the server rather than from a client flag,
 * because a client that decides for itself is a client that can be wrong.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/checkin_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const UNIT = {
  pu_code: '37-06-02-141', name: 'Wonderland Estate', ward: 'Garki',
  lga: 'Abuja Municipal', state: 'FCT', lat: 9.0333, lng: 7.4833,
};

let rooms = [];
let checkInCalls = [];

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u === '/api/my/rooms') return json({ rooms });
  if (u === '/api/my/check-in') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    return req.on('end', () => {
      checkInCalls.push(JSON.parse(raw || '{}'));
      json({ ok: true, standing: 'verified', rooms: [] });
    });
  }
  if (u === '/api/register/unit') return json({ unit: UNIT });
  if (u.startsWith('/api/')) return json({ ok: true, units: [UNIT], contests: [], items: [], rows: [] });
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

/**
 * Drive the real flow far enough for a unit to be bound, then ask what the
 * check-in host holds. selectUnit() is the product's own entry point — calling
 * it is not a shortcut around the behaviour, it IS the behaviour.
 */
async function unitChosen() {
  const ctx = await b.newContext({
    viewport: { width: 420, height: 900 },
    permissions: ['geolocation'],
    geolocation: { latitude: UNIT.lat, longitude: UNIT.lng, accuracy: 8 },
  });
  await ctx.addInitScript((t) => {
    localStorage.setItem('hawkeye_token', t);
    localStorage.setItem('hawkeye_user', JSON.stringify({ id: 1, name: 'Test' }));
  }, jwt);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 180)));
  await p.goto(`${base}/observe.html`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => typeof window.selectUnit === 'function' || !!document.getElementById('checkin-host'), null, { timeout: 8000 }).catch(() => {});
  await p.evaluate((u) => {
    // enterReportFlow() first, exactly as the Telegram prefill path does.
    if (typeof enterReportFlow === 'function') enterReportFlow();
    selectUnit(u);
  }, UNIT).catch((e) => errs.push('select: ' + String(e).slice(0, 120)));
  await p.waitForTimeout(700);
  return { ctx, p, errs };
}

// ================================================== CONTROL: an ordinary voter
{
  rooms = [];
  const { ctx, p, errs } = await unitChosen();
  check('CONTROL the flow reached a chosen unit without errors', errs, []);
  const host = await p.evaluate(() => {
    const h = document.getElementById('checkin-host');
    return { present: !!h, hidden: h ? h.hidden : null, html: h ? h.innerHTML.trim().length : -1 };
  });
  check('CONTROL the host exists in the page', host.present, true);
  check('an observer with no room is shown NOTHING', { hidden: host.hidden, html: host.html }, { hidden: true, html: 0 });
  check('and no check-in is offered anywhere on the page', await p.evaluate(() =>
    document.body.innerText.toLowerCase().includes('coordinator')), false);
  await ctx.close();
}

// ======================================================= an agent with a room
{
  rooms = [{ id: 1, name: 'Obi 2027', kind: 'campaign', contest: 'PRES', assigned: { ...UNIT }, checkedIn: null }];
  checkInCalls = [];
  const { ctx, p, errs } = await unitChosen();
  check('CONTROL the same flow, same code, no errors', errs, []);
  check('a rostered agent IS offered a check-in', await p.evaluate(() =>
    !!document.getElementById('btn-checkin')), true);

  await p.evaluate(() => document.getElementById('btn-checkin').click());
  await p.waitForTimeout(900);
  check('it posts the unit they are REPORTING from', checkInCalls.map((c) => c.pu_code), [UNIT.pu_code]);
  check('with a real fix, not a placeholder', checkInCalls[0], (c) =>
    Math.abs(c.lat - UNIT.lat) < 0.01 && Math.abs(c.lng - UNIT.lng) < 0.01 && c.accuracy > 0);
  check('and the card reports what was recorded', await p.evaluate(() =>
    document.getElementById('checkin-host').innerText), (t) => /Checked in/i.test(t || ''));
  await p.screenshot({ path: `${OUT}/agent.png` });
  await ctx.close();
}

// ============================== assigned elsewhere: said plainly, not refused
{
  rooms = [{
    id: 1, name: 'Obi 2027', kind: 'campaign', contest: 'PRES',
    assigned: { pu_code: '37-06-02-999', name: 'Some Other Unit', ward: 'Garki', lga: 'AMAC', state: 'FCT' },
    checkedIn: null,
  }];
  const { ctx, p } = await unitChosen();
  const note = await p.evaluate(() => document.getElementById('checkin-note')?.innerText || '');
  check('an agent at a different unit is told what will be recorded', note,
    (t) => /Some Other Unit/.test(t || ''));
  // Being moved is ordinary. The copy must not scold.
  check('and is not warned off doing it', note, (t) => !/wrong|error|cannot|not allowed/i.test(t || ''));
  check('the button is still offered', await p.evaluate(() => !!document.getElementById('btn-checkin')), true);
  await ctx.close();
}

// ============================================ already checked in: no repeat ask
{
  rooms = [{
    id: 1, name: 'Obi 2027', kind: 'campaign', contest: 'PRES', assigned: { ...UNIT },
    checkedIn: { at: Date.now(), standing: 'verified', pu_code: UNIT.pu_code },
  }];
  const { ctx, p } = await unitChosen();
  check('somebody already checked in is not asked again', await p.evaluate(() =>
    !!document.getElementById('btn-checkin')), false);
  check('but is told it is done', await p.evaluate(() =>
    document.getElementById('checkin-host').innerText), (t) => /knows you are here/i.test(t || ''));
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — a coordinator you have, or nothing at all');
process.exit(fail ? 1 : 0);
