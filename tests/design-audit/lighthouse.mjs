/**
 * Lighthouse on the key signed-out web pages: mobile form factor, SIMULATED
 * throttling (Lighthouse's default mobile profile = slow 4G: 150 ms RTT,
 * 1.6 Mbps, 4x CPU slowdown). Sentry and the Cloudflare beacon are blocked so a
 * test run never lands in the owner's monitoring.
 *
 *   CHROME_PATH=... node lighthouse.mjs [--only landing,signup]
 * Output: out/lighthouse/<id>.html (full report) + out/lighthouse/summary.json
 */
import fs from 'node:fs';
import path from 'node:path';

import { HERE, OUT, SITE, PAGES, CHROME, log } from './lib.mjs';
import { WEB } from './inventory.mjs';


import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const only = arg('only') ? arg('only').split(',') : null;
const pages = WEB.filter((s) => s.key && (!only || only.includes(s.id)));
const dir = path.join(OUT, 'lighthouse');
fs.mkdirSync(dir, { recursive: true });

const summary = [];
for (const p of pages) {
  const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const url = PAGES + p.path;
    const r = await lighthouse(url, {
      port: chrome.port, output: 'html', logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      blockedUrlPatterns: ['*sentry.io*', '*cloudflareinsights.com*'],
      locale: 'en-US',
    });
    const lhr = r.lhr;
    fs.writeFileSync(path.join(dir, `${p.id}.html`), r.report);
    const a = (id) => lhr.audits[id] || {};
    const row = {
      id: p.id, url,
      scores: Object.fromEntries(Object.entries(lhr.categories).map(([k, v]) => [k, Math.round((v.score || 0) * 100)])),
      fcp: a('first-contentful-paint').displayValue, lcp: a('largest-contentful-paint').displayValue,
      tbt: a('total-blocking-time').displayValue, cls: a('cumulative-layout-shift').displayValue, si: a('speed-index').displayValue,
      bytes: a('total-byte-weight').displayValue,
      lcpEl: (a('largest-contentful-paint-element').details?.items?.[0]?.items?.[0]?.node?.snippet || '').slice(0, 120),
      fails: Object.values(lhr.audits).filter((x) => x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== 'informative' && x.scoreDisplayMode !== 'notApplicable' && x.scoreDisplayMode !== 'manual')
        .map((x) => ({ id: x.id, title: x.title, score: x.score, value: x.displayValue || '' })).slice(0, 40),
      runtimeError: lhr.runtimeError?.message || null,
    };
    summary.push(row);
    log(p.id, JSON.stringify(row.scores), 'LCP', row.lcp, 'TBT', row.tbt, 'CLS', row.cls);
  } catch (e) {
    summary.push({ id: p.id, error: String(e.message || e).slice(0, 300) });
    log(p.id, 'ERROR', e.message);
  } finally {
    await chrome.kill();
  }
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), profile: 'mobile, simulated slow 4G (150 ms RTT, 1.6 Mbps, 4x CPU)', pages: summary }, null, 1));
log('wrote', path.join(dir, 'summary.json'));
