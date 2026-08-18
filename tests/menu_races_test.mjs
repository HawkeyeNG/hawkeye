// The menu's Races entry. It was an accordion listing All Races / Osun 2026 /
// Presidency 2027 — a hand-kept subset of the page it sat above, with a finished
// election pinned to it. It is one link now; races.html does the rest.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
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
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 420, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

// Two pages, because the menu is assembled by script from each page's own static
// list plus injections — a change can work on one and break on another.
for (const page of ['index.html', 'results.html']) {
  console.log(`\n=== ${page} ===`);
  await p.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#menu-panel', { state: 'attached', timeout: 10000 });
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => {
    const panel = document.getElementById('menu-panel');
    const accs = [...panel.querySelectorAll('.menu-acc')].map((e) => e.textContent.trim());
    const links = [...panel.querySelectorAll('a')].map((a) => ({
      href: a.getAttribute('href'), text: a.textContent.trim(),
    }));
    return { accs, links };
  });
  const races = m.links.filter((l) => l.href === 'races.html');
  check('exactly one Races link', races.length, 1);
  check('labelled plainly', races[0]?.text, 'Races');
  check('no Races accordion', m.accs, (a) => !a.some((x) => /Races/i.test(x)));
  check('Osun 2026 is not pinned in the menu', m.links, (l) => !l.some((x) => x.href === 'osun.html'));
  // The Report accordion must survive — only the Races one was removed.
  check('the Report accordion is untouched', m.accs, (a) => a.some((x) => /Report/i.test(x)));
  check('the leaderboard is still there', m.links, (l) => l.some((x) => x.href === 'results.html'));
}

check('no page errors', errs, []);
await b.close();
server.close();

// The app's menu must make the same call.
// The web dropped the Races accordion; native kept it, listing All Races / Osun
// 2026 / Presidency 2027 for weeks after - a hand-kept list of three above a
// screen that derives every race and already groups them completed / ongoing /
// upcoming. Same class of drift as the leaderboard's default race, so it gets
// the same kind of pin. Source checks: there is no RN harness here.
console.log('\n=== the app menu matches ===');
const { readFileSync } = await import('node:fs');
const more = readFileSync('/home/elrio/hawkeye/native/src/app/(tabs)/more.tsx', 'utf8');
check('no Races accordion in the app menu', /acc:\s*'Races'/.test(more), false);
check('one plain Races row instead', /\{ label: 'Races', href: 'native:\/races'/.test(more), true);
// Osun was a finished election pinned to a menu. It stays REACHABLE - races.tsx
// links to it - it just is not a permanent menu entry any more.
check('Osun 2026 is not pinned in the app menu', /label: 'Osun 2026'/.test(more), false);
check('Report still collapses', /acc:\s*'Report'/.test(more), true);
const racesSrc = readFileSync('/home/elrio/hawkeye/native/src/app/races.tsx', 'utf8');
check('and /races still reaches Osun, so nothing is orphaned', /'\/osun'/.test(racesSrc), true);
check('and still reaches the presidency', /'\/candidates'/.test(racesSrc), true);
// Both platforms group by the same three statuses, derived from the date.
const webRaces = readFileSync('/home/elrio/hawkeye/app/races.html', 'utf8');
for (const [name, src] of [['races.html', webRaces], ['races.tsx', racesSrc]]) {
  check(name + ' groups completed/ongoing/upcoming',
    ['completed', 'ongoing', 'upcoming'].every((k) => src.includes("'" + k + "'")), true);
}


// Every category on /races must go somewhere. "Soon" was the pill for a contest
// with no page, written when only the presidency had one — Senate, Reps and
// State Assembly all have national boards now, so a dead row was stale UI, not a
// statement about the election.
const racesScreen = readFileSync('/home/elrio/hawkeye/native/src/app/races.tsx', 'utf8');
check('Senate/Reps/SHA link to their own board',
  racesScreen.includes('(tabs)/results?contest=${encodeURIComponent(c.code)}'), true);
check('the presidency still opens its field page', racesScreen.includes("'/candidates'"), true);
// A governorship is 28 separate elections; it expands rather than linking.
check('a governorship still expands instead', /c\.code === 'GOV'\s*\?\s*null/.test(racesScreen), true);
// "Open" beside a January 2027 date read as "reporting is open", which on an
// election app is the wrong thing to leave ambiguous.
check('no pill claims an unopened election is open', racesScreen.includes(": 'Open';"), false);
check('it says what tapping does', racesScreen.includes(": 'View';"), true);
// ScreenHeader already prints the title; the page printed it again one line down.
check('the page does not print its own title twice',
  /className="text-2xl font-bold text-ink">Races</.test(racesScreen), false);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
