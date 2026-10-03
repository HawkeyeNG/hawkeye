/**
 * Which pages fall back to the BROWSER's default link colours (unstyled links)?
 *   node probe-links.mjs
 * UA defaults: light #0000EE / visited #551A8B; dark (color-scheme: dark) #9E9EFF / #D0ADF0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, SITE, OUT, VIEWPORTS, installGuard, contextOptions, webInit, sleep, log } from './lib.mjs';
import { WEB } from './inventory.mjs';
import { makeFixtures } from './fixtures.mjs';

const UA = new Set(['rgb(0, 0, 238)', 'rgb(85, 26, 139)', 'rgb(158, 158, 255)', 'rgb(208, 173, 240)']);
const browser = await chromium.launch({ executablePath: CHROME });
const out = [];
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext(contextOptions(VIEWPORTS.s390, { theme }));
  await installGuard(ctx, { fixtures: makeFixtures('populated'), signedIn: true });
  for (const s of WEB) {
    const page = await ctx.newPage();
    const init = webInit({ signedIn: s.auth === 'in', theme });
    await page.addInitScript(init.script, init.arg);
    await page.goto(SITE + s.path, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await sleep(1500);
    const r = await page.evaluate((ua) => {
      const hits = [];
      for (const a of document.querySelectorAll('a[href], button')) {
        if (!a.getClientRects().length) continue;
        const c = getComputedStyle(a).color;
        if (ua.includes(c)) hits.push({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40), color: c });
      }
      return hits;
    }, [...UA]).catch(() => []);
    if (r.length) out.push({ id: s.id, theme, n: r.length, samples: r.slice(0, 6) });
    await page.close();
  }
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, 'probe-links.json'), JSON.stringify(out, null, 1));
for (const o of out) log(o.theme, o.id, o.n, o.samples.map((s) => `"${s.text}" ${s.color}`).join(' | '));
await browser.close();
process.exit(0);
