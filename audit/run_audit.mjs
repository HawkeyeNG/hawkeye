// One-command site audit: axe-core (accessibility/contrast, BOTH themes, every
// page) + Lighthouse (accessibility / best-practices / SEO on the core pages).
//   cd ~/hawkeye/audit && npm run audit          # full
//   node run_audit.mjs --no-lh                   # axe only (fast)
// Output: console summary + reports/latest.md (+ dated copy).
import fs from 'node:fs';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';

const BASE = process.env.AUDIT_BASE || 'https://hawkeye.com.ng';
const PAGES = [
  '/index.html', '/observe.html?intent=observe', '/results.html', '/dashboard.html',
  '/ledger.html', '/integrity.html', '/docket.html', '/case.html?id=1',
  '/collation.html', '/incidents.html', '/map-unit.html', '/candidates.html',
  '/political.html', '/how.html', '/guide.html', '/faq.html', '/privacy.html',
  '/about.html', '/train.html',
];
const LH_PAGES = ['/index.html', '/observe.html?intent=observe', '/results.html', '/docket.html', '/dashboard.html', '/faq.html'];
const NO_LH = process.argv.includes('--no-lh');

const md = [`# Hawkeye site audit — ${new Date().toISOString()}\n`];
let worst = 0;

// ---- axe pass: every page, light AND dark ----------------------------------
const browser = await chromium.launch({ args: ['--no-sandbox'] });
md.push('## axe-core (accessibility + contrast)\n');
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => localStorage.setItem('hawkeye_theme', t), theme);
  md.push(`### ${theme} theme\n`);
  for (const p of PAGES) {
    const page = await ctx.newPage();
    try {
      await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 30000 });
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const bad = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      worst += bad.length;
      const line = `- \`${p}\`: ${res.violations.length} violation(s), ${bad.length} serious+`;
      console.log(`[axe/${theme}] ${line.slice(2)}`);
      md.push(line);
      for (const v of bad.slice(0, 5)) {
        md.push(`  - **${v.id}** (${v.impact}): ${v.help} — ${v.nodes.length} node(s), e.g. \`${(v.nodes[0]?.target || []).join(' ')}\``);
      }
    } catch (e) {
      md.push(`- \`${p}\`: ERROR ${e.message.slice(0, 80)}`);
    } finally { await page.close(); }
  }
  await ctx.close();
}

// ---- Lighthouse pass: core pages --------------------------------------------
if (!NO_LH) {
  md.push('\n## Lighthouse (a11y / best-practices / SEO)\n');
  const chrome = await launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });
  for (const p of LH_PAGES) {
    try {
      const r = await lighthouse(BASE + p, {
        port: chrome.port, output: 'json', logLevel: 'error',
        onlyCategories: ['accessibility', 'best-practices', 'seo'],
      });
      const c = r.lhr.categories;
      const score = (k) => Math.round((c[k]?.score ?? 0) * 100);
      const line = `- \`${p}\`: a11y ${score('accessibility')} · best-practices ${score('best-practices')} · seo ${score('seo')}`;
      console.log(`[lh] ${line.slice(2)}`);
      md.push(line);
      const failing = Object.values(r.lhr.audits)
        .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode === 'binary')
        .slice(0, 6);
      for (const a of failing) md.push(`  - ${a.id}: ${a.title}`);
    } catch (e) {
      md.push(`- \`${p}\`: LH ERROR ${e.message.slice(0, 80)}`);
    }
  }
  await chrome.kill();
}

await browser.close();
fs.mkdirSync('reports', { recursive: true });
const out = md.join('\n') + '\n';
fs.writeFileSync('reports/latest.md', out);
fs.writeFileSync(`reports/${new Date().toISOString().slice(0, 10)}.md`, out);
console.log(`\nDone. ${worst} serious+ axe violations across themes. Full report: audit/reports/latest.md`);
