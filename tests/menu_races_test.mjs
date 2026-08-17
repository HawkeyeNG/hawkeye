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
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
