// "HELP COVER THESE STATES" MUST BE ABOUT THE RACE ON SCREEN.
//
// The board showed one governorship — Jigawa — and the coverage card underneath
// asked for the whole contest: "0 of 28 states in this election have reports so
// far. Nothing has come in from: Abia · Adamawa · Akwa Ibom · Bauchi · ...".
// A reader looking at Jigawa was being recruited to go and cover 27 states
// running a different race. The card is a call to action, so it has to name
// somewhere the reader could actually act.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));
const LGAS = JSON.parse(fs.readFileSync(`${APP}/lga_geo.json`, 'utf8'));
const lgasOf = (st) => LGAS.lgas.filter((l) => l.key.split('|')[0] === st.toLowerCase())
  .map((l) => l.key.split('|')[1].replace(/\b[a-z]/g, (c) => c.toUpperCase()));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${typeof want === 'function' ? '(predicate)' : JSON.stringify(want)}`}`);
};

// A stub that answers gaps the way the real route now does, and records what it
// was asked — the request is half of what this test is about.
const gapsAsked = [];
let gapsStatus = 200;
const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const q = new URLSearchParams(qs || '');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url === '/api/coverage/gaps') {
    const region = q.get('region');
    gapsAsked.push({ contest: q.get('contest'), region });
    if (gapsStatus !== 200) return json({ error: 'unknown_region' }, gapsStatus);
    if (region) {
      // Narrowed: the server answers in that region's LGAs.
      return json({
        contest: q.get('contest'), level: 'lga', unit: 'LGA', unitPlural: 'LGAs',
        scope: { region, level: 'state', state: region },
        statesTotal: lgasOf(region).length, statesReported: 0, missing: lgasOf(region),
      });
    }
    return json({
      contest: q.get('contest'), level: 'state', unit: 'state', unitPlural: 'states', scope: null,
      statesTotal: 37, statesReported: 0, missing: ['Abia', 'Adamawa', 'Akwa Ibom', 'Jigawa'],
    });
  }
  if (url.startsWith('/api/national/')) {
    const state = q.get('state');
    if (state && !lgasOf(state).length) return json({ error: 'unknown_state' }, 404);
    return json({
      contest: url.split('/').pop(), level: state ? 'lga' : 'state',
      scope: state ? { state } : null, subunits: state ? lgasOf(state) : ['Jigawa', 'Kano'],
      updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [],
    });
  }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const card = () => p.evaluate(() => ({
  hidden: document.getElementById('gaps-card').hidden,
  title: document.getElementById('gaps-title').textContent,
  hint: document.getElementById('gaps-hint').textContent.trim(),
  chips: [...document.querySelectorAll('#gaps span')].map((e) => e.textContent),
}));

console.log('=== a board cropped to one state ===');
gapsAsked.length = 0;
await p.goto(`${base}/results.html?contest=GOV&state=Jigawa`, { waitUntil: 'networkidle' });
check('asks for that state, not the contest', gapsAsked, [{ contest: 'GOV', region: 'Jigawa' }]);
{
  const c = await card();
  check('names the place, not "these states"', c.title, 'Help cover Jigawa');
  // The whole point: the places listed are ones a reader in Jigawa can reach.
  check('lists Jigawa LGAs', c.chips.length, lgasOf('Jigawa').length);
  check('and no other state', c.chips, (v) => !v.includes('Abia') && v.includes('Auyo'));
  check('the sentence says where', c.hint, (t) => /LGAs in Jigawa have no reports/.test(t));
}

console.log('\n=== the whole contest, uncropped ===');
gapsAsked.length = 0;
await p.goto(`${base}/results.html?contest=GOV`, { waitUntil: 'networkidle' });
check('asks contest-wide', gapsAsked, [{ contest: 'GOV', region: null }]);
{
  const c = await card();
  // Unnarrowed the card is still right — it is the contest that is nationwide.
  check('keeps the generic heading', c.title, 'Help cover these states');
  check('and lists states', c.chips, (v) => v.includes('Abia'));
}

console.log('\n=== an unresolvable region ===');
// The server 404s rather than answering "0 of 0", which would read as full
// coverage. The card must go away, NOT keep the previous board's places under
// this board's heading — a stale list here is a wrong instruction, not a
// cosmetic bug.
gapsStatus = 404;
await p.goto(`${base}/results.html?contest=GOV&state=Jigawa`, { waitUntil: 'networkidle' });
check('the card is withdrawn', (await card()).hidden, true);
gapsStatus = 200;

check('no page errors', errs, []);

await b.close();
server.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);
