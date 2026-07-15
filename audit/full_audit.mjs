// Full-system design/quality audit: EVERY page × light+dark × mobile+desktop.
// Per page: console errors, JS pageerrors, horizontal overflow, axe-core
// (serious+critical), screenshots for visual review; plus an internal
// broken-link crawl and Lighthouse on the core pages.
//   AUDIT_BASE=http://127.0.0.1:8430 node full_audit.mjs [--no-lh]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8430';
const OUT = process.env.OUT || '/tmp/hawkeye-audit';
fs.mkdirSync(OUT, { recursive: true });

const PUBLIC_PAGES = [
  '/index.html', '/observe.html?intent=observe', '/observe.html', '/results.html',
  '/dashboard.html', '/ledger.html', '/integrity.html', '/docket.html',
  '/case.html?id=1', '/collation.html', '/incidents.html', '/map-unit.html',
  '/candidates.html', '/political.html', '/how.html', '/guide.html', '/faq.html',
  '/privacy.html', '/about.html', '/terms.html', '/meta.html', '/404.html',
  '/notifications.html', '/profile.html',
];
const SIGNED_PAGES = ['/index.html', '/profile.html', '/notifications.html', '/observe.html'];
const NO_LH = process.argv.includes('--no-lh');

// -- mint a real observer token against the local backend --------------------
async function mintToken() {
  const { webcrypto } = crypto;
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  const dev = 'e'.repeat(64);
  const h = { 'content-type': 'application/json', 'x-device-id': dev };
  const phone = '0803' + String(crypto.randomInt(1000000, 9999999));
  let r = await fetch(BASE + '/api/observers/register', { method: 'POST', headers: h, body: JSON.stringify({ phone }) });
  const { devOtp } = await r.json();
  r = await fetch(BASE + '/api/observers/verify', { method: 'POST', headers: h, body: JSON.stringify({ phone, otp: devOtp, publicKeyJwk: jwk }) });
  const b = await r.json();
  return b.token;
}

const md = [`# Hawkeye FULL audit — ${new Date().toISOString()} — base ${BASE}\n`];
const problems = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function auditPage(ctx, p, theme, tag) {
  const page = await ctx.newPage();
  const consoleErrs = [], pageErrs = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 120)); });
  page.on('pageerror', (e) => pageErrs.push(String(e.message).slice(0, 120)));
  const row = { page: p, theme, tag };
  try {
    for (const [w, hgt, vp] of [[375, 812, 'm'], [1280, 800, 'd']]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(900);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (overflow) problems.push(`OVERFLOW-X ${p} [${theme}/${vp}${tag}]`);
      if (theme === 'light' && !tag) {
        const slug = p.replace(/[/?=.&]/g, '_');
        await page.screenshot({ path: `${OUT}/${slug}_${vp}.png`, fullPage: vp === 'm' });
      }
      if (tag && theme === 'light') {
        const slug = p.replace(/[/?=.&]/g, '_');
        await page.screenshot({ path: `${OUT}/AUTH${slug}_${vp}.png`, fullPage: vp === 'm' });
      }
    }
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    row.axe = bad.length;
    for (const v of bad.slice(0, 4)) problems.push(`AXE ${p} [${theme}${tag}] ${v.id}(${v.impact}) ${v.nodes.length}x e.g. ${(v.nodes[0]?.target || []).join(' ')}`);
    if (consoleErrs.length) problems.push(`CONSOLE ${p} [${theme}${tag}]: ${[...new Set(consoleErrs)].slice(0, 3).join(' | ')}`);
    if (pageErrs.length) problems.push(`JSERROR ${p} [${theme}${tag}]: ${[...new Set(pageErrs)].slice(0, 3).join(' | ')}`);
    console.log(`${tag || 'pub'}/${theme} ${p}: axe=${bad.length} cerr=${consoleErrs.length} jserr=${pageErrs.length}`);
  } catch (e) {
    problems.push(`LOADFAIL ${p} [${theme}${tag}] ${e.message.slice(0, 80)}`);
  } finally { await page.close(); }
}

// -- public pass: both themes -------------------------------------------------
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('hawkeye_theme', t); }, theme);
  await ctx.addInitScript(() => { try { navigator.serviceWorker?.getRegistrations?.().then((r) => r.forEach((x) => x.unregister())); } catch {} });
  for (const p of PUBLIC_PAGES) await auditPage(ctx, p, theme, '');
  await ctx.close();
}

// -- signed-in pass ------------------------------------------------------------
const token = await mintToken().catch((e) => (problems.push('TOKEN MINT FAILED ' + e.message), null));
if (token) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('hawkeye_token', t); localStorage.setItem('hawkeye_theme', 'light'); }, token);
  for (const p of SIGNED_PAGES) await auditPage(ctx, p, 'light', 'AUTH');
  await ctx.close();
}

// -- internal link crawl --------------------------------------------------------
const seen = new Map();
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const links = new Set();
  for (const p of PUBLIC_PAGES) {
    try {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
      for (const href of await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')))) {
        if (!href || href.startsWith('#') || /^(https?:|mailto:|tel:|javascript:)/.test(href)) continue;
        links.add(href.split('#')[0]);
      }
    } catch {}
  }
  for (const l of [...links].filter(Boolean)) {
    const url = BASE + (l.startsWith('/') ? l : '/' + l);
    try {
      const r = await fetch(url, { method: 'GET' });
      seen.set(l, r.status);
      if (r.status >= 400) problems.push(`BROKEN LINK ${l} -> ${r.status}`);
    } catch (e) { problems.push(`BROKEN LINK ${l} -> ${e.message.slice(0, 40)}`); }
  }
  await ctx.close();
}
await browser.close();

// -- lighthouse (core pages) ----------------------------------------------------
if (!NO_LH) {
  const { launch } = await import('chrome-launcher');
  const lighthouse = (await import('lighthouse')).default;
  const chrome = await launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  md.push('\n## Lighthouse (perf/a11y/best-practices/SEO)\n');
  for (const p of ['/index.html', '/observe.html?intent=observe', '/results.html', '/profile.html', '/dashboard.html']) {
    try {
      const r = await lighthouse(BASE + p, { port: chrome.port, output: 'json', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] });
      const c = r.lhr.categories;
      md.push(`- \`${p}\`: perf ${Math.round(c.performance.score * 100)} · a11y ${Math.round(c.accessibility.score * 100)} · bp ${Math.round(c['best-practices'].score * 100)} · seo ${Math.round(c.seo.score * 100)}`);
      console.log('LH', p, Math.round(c.performance.score * 100), Math.round(c.accessibility.score * 100));
    } catch (e) { md.push(`- \`${p}\`: LH error ${e.message.slice(0, 60)}`); }
  }
  await chrome.kill();
}

md.push('\n## Findings\n');
md.push(problems.length ? problems.map((x) => '- ' + x).join('\n') : '- No serious axe violations, console errors, JS errors, overflow, or broken links detected.');
md.push(`\n\nLink check: ${seen.size} unique internal links verified.`);
fs.writeFileSync('reports/full-latest.md', md.join('\n'));
console.log('\n==== FINDINGS ====');
console.log(problems.length ? problems.join('\n') : 'CLEAN');
console.log(`screenshots: ${OUT}`);
