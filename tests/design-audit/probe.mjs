/**
 * Quick look at one screen: links, text and a screenshot. Read-only (lib.mjs guard).
 *   node probe.mjs --url https://hawkeye.com.ng/races.html [--links race] [--signed-in] [--lite] [--native] [--shot name]
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium, CHROME, VIEWPORTS, NATIVE_DIR, installGuard, contextOptions, webInit, nativeInit, startStatic, sleep, OUT } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const { FIXTURES } = await import('./fixtures.mjs').catch(() => ({ FIXTURES: null }));

const browser = await chromium.launch({ executablePath: CHROME });
let url = arg('url');
let server = null;
if (flag('native')) { server = await startStatic(NATIVE_DIR); url = `http://127.0.0.1:${server.address().port}${url}`; }
const vp = VIEWPORTS[arg('vp', 's390')];
const theme = arg('theme', 'dark');
const ctx = await browser.newContext(contextOptions(vp, { theme }));
const calls = [];
await installGuard(ctx, { crossOrigin: flag('native'), signedIn: flag('signed-in'), fixtures: FIXTURES ? FIXTURES : undefined, onApi: (c) => calls.push(c) });
const init = flag('native') ? nativeInit({ signedIn: flag('signed-in'), lang: arg('lang', 'en'), theme }) : webInit({ lite: flag('lite'), signedIn: flag('signed-in'), lang: arg('lang', 'en'), theme });
await ctx.addInitScript(init.script, init.arg);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
page.on('console', (m) => { if (/error|warn/.test(m.type())) console.log('console.' + m.type(), m.text().slice(0, 200)); });
await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch((e) => console.log('goto', e.message));
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await sleep(Number(arg('wait', 2500)));
console.log('final', page.url());
if (arg('eval')) console.log('eval', JSON.stringify(await page.evaluate(arg('eval')).catch((e) => 'ERR ' + e.message)));
const re = arg('links');
if (re) {
  const links = await page.evaluate((re) => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => new RegExp(re).test(h)), re);
  console.log([...new Set(links)].slice(0, 60).join('\n'));
}
console.log((await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, Number(arg('chars', 600))));
console.log('api', calls.map((c) => `${c.method} ${c.path} ${c.status} ${c.source}`).join('\n    '));
if (arg('shot')) {
  fs.mkdirSync(path.join(OUT, 'probe'), { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'probe', arg('shot') + '.png'), fullPage: flag('full') });
}
await browser.close();
if (server) server.close();
