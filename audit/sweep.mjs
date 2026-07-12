import { chromium } from 'playwright';
const OUT = process.env.OUT || '/mnt/c/Users/HP/AppData/Local/Temp/claude/--wsl-localhost-Ubuntu-home-elrio-studybot/5ceb2c7d-66d5-4ce3-a395-d01c0c749e21/scratchpad';
const BASE = process.env.SWEEP_BASE || 'https://hawkeye.com.ng';
const pages = (process.env.PAGES || 'index,observe,results,dashboard,docket,incidents,collation,candidates').split(',');
const b = await chromium.launch();
for (const [w, tag] of [[390, 'm'], [1280, 'd']]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1.4 });
  await p.addInitScript(() => { try { navigator.serviceWorker?.getRegistrations?.().then((r) => r.forEach((x) => x.unregister())); } catch {} });
  for (const pg of pages) {
    try {
      await p.goto(`${BASE}/${pg}.html`, { waitUntil: 'networkidle', timeout: 25000 });
      await p.waitForTimeout(1200);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      await p.screenshot({ path: `${OUT}/sw_${pg}_${tag}.png`, fullPage: false });
      console.log(`${pg} ${tag}: overflowX=${overflow}`);
    } catch (e) { console.log(`${pg} ${tag}: ERR ${e.message.slice(0, 40)}`); }
  }
  await p.close();
}
await b.close();
