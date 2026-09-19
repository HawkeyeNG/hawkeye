/**
 * EVERY SHIPPED SCRIPT PARSES, AND THE PAGES THAT LOAD THEM ACTUALLY RENDER.
 *
 * practice.js shipped with `(() => { ... }())` — the IIFE shape that is valid
 * for a function expression and a SyntaxError for an arrow. One bad character
 * kills the WHOLE FILE, so the practice screen rendered as a header, a banner
 * and a black rectangle, on the website and inside Lite, until a tester
 * screenshotted it.
 *
 * WHY NOTHING CAUGHT IT. tests/practice_card_save_test.mjs asserts the feature
 * by READING THE SOURCE with regexes. A regex matches a broken file exactly as
 * well as a working one — the test passed on a file no browser could run. A
 * source-reading test can prove a call site exists; it can never prove the file
 * loads.
 *
 * So this does two things a grep cannot: parse every script, and open the pages
 * that use them and require them to be alive.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const APP = '/home/elrio/hawkeye/app';
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ===================================================== 1. every script parses
{
  const scripts = fs.readdirSync(APP).filter((f) => f.endsWith('.js'));
  check('CONTROL there are scripts to check', scripts.length > 20, true);
  const broken = [];
  for (const f of scripts) {
    try {
      execFileSync('node', ['--check', path.join(APP, f)], { stdio: 'pipe' });
    } catch (e) {
      broken.push(`${f}: ${String(e.stderr || e).split('\n').find((l) => /Error/.test(l)) || 'parse error'}`);
    }
  }
  check(`all ${scripts.length} shipped scripts parse`, broken, []);

  /* CONTROL: the checker must be able to fail. A parse check that cannot
     reject a broken file is the shape of the bug it is here to prevent. */
  const tmp = path.join('/tmp', `hk-broken-${process.pid}.js`);
  fs.writeFileSync(tmp, 'const x = (() => { return 1; }());\n');
  let rejected = false;
  try { execFileSync('node', ['--check', tmp], { stdio: 'pipe' }); } catch { rejected = true; }
  fs.rmSync(tmp, { force: true });
  check('CONTROL it rejects the exact shape that shipped', rejected, true);
}

// ======================================= 2. the pages come up with no errors
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, office: 'President', contest: 'PRACTICE', closed: false,
      parties: [{ code: 'APC', name: 'APC' }, { code: 'PDP', name: 'PDP' }],
      units: [], items: [], rows: [], runs: [],
    }));
  }
  const f = path.join(APP, decodeURIComponent(u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/* The pages a broken script would render as a blank rectangle. Practice first,
   because that is the one that shipped broken. */
for (const page of ['practice.html', 'observe.html', 'index.html', 'situation-room.html']) {
  const ctx = await b.newContext({ viewport: { width: 400, height: 860 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await p.goto(`${base}/${page}`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(600);
  const state = await p.evaluate(() => ({
    /* Not "is there a body" — a broken script leaves the shell and empties the
       content. Measure the text a reader would actually see. */
    text: document.body.innerText.replace(/\s+/g, ' ').trim().length,
    paints: document.querySelectorAll('main *, .card, .sr-card, button').length,
  }));
  check(`${page}: no script threw`, errs, []);
  check(`${page}: it rendered something a person can read`,
    state, (v) => v.text > 120 && v.paints > 5);
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — every script parses and every page comes up');
process.exit(fail ? 1 : 0);
