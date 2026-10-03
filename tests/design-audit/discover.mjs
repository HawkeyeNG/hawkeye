/**
 * Which /api/ endpoints does each screen call, and which of them need a session?
 * Drives fixtures.mjs. Read-only: lib.mjs installGuard (GET pass-through without
 * the token, writes blocked).
 *
 *   node discover.mjs --surface web|native [--pages a.html,b.html]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, SITE, NATIVE_DIR, VIEWPORTS, installGuard, contextOptions, webInit, nativeInit, startStatic, sleep, log, OUT, SAFETY } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const surface = arg('surface', 'web');
const WEB_PAGES = (arg('pages') || 'index.html,dashboard.html,profile.html,notifications.html,my-groups.html,situation-room.html,observe.html?intent=observe,incidents.html,collation.html,map-unit.html,choose-unit.html,ready.html,captain.html,results.html,race.html,practice.html').split(',');
const NATIVE_ROUTES = (arg('pages') || '/,/(tabs)/results,/(tabs)/alerts,/(tabs)/more,/profile,/my-groups,/reports-log,/report/result,/report/incident,/report/collation,/ready,/map-unit,/captain,/choose-unit').split(',');

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};
let base = SITE;
let server = null;
if (surface === 'native') { server = await startStatic(NATIVE_DIR); base = `http://127.0.0.1:${server.address().port}`; }

for (const p of surface === 'native' ? NATIVE_ROUTES : WEB_PAGES) {
  const calls = [];
  const ctx = await browser.newContext(contextOptions(VIEWPORTS.s390, { theme: 'dark' }));
  await installGuard(ctx, { signedIn: true, onApi: (c) => calls.push(c) });
  const init = surface === 'native' ? nativeInit({ signedIn: true }) : webInit({ signedIn: true });
  await ctx.addInitScript(init.script, init.arg);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  const url = base + (surface === 'native' ? p : '/' + p);
  try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); } catch (e) { errs.push('goto: ' + String(e.message).split('\n')[0]); }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(2500);
  const final = page.url();
  out[p] = { final, calls, errs };
  log(p, '->', final.replace(base, ''), calls.length, 'calls', calls.filter((c) => c.status >= 400).map((c) => `${c.method} ${c.path} ${c.status}`).join(' | '));
  await ctx.close();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `discover-${surface}.json`), JSON.stringify({ out, unknownAuth: [...SAFETY.unknownAuth], blocked: SAFETY.blockedWrites }, null, 1));
log('unknownAuth', JSON.stringify([...SAFETY.unknownAuth]));
log('blocked writes', JSON.stringify(SAFETY.blockedWrites));
await browser.close();
if (server) server.close();
