/* Whole-product audit: crawls EVERY page in app/ (web view and app view) and
 * reports real defects rather than opinions. Complements layout.spec.js, which
 * guards a handful of known regressions; this one sweeps the entire surface.
 *
 * What it actually catches (all mechanical, no judgement calls):
 *   - JS console errors / unhandled rejections on any page
 *   - failed network requests (404 assets, broken images, dead API calls)
 *   - horizontal overflow (the classic phone-layout break)
 *   - text below 4.5:1 contrast (WCAG 1.4.3)
 *   - tap targets under 44px (WCAG 2.5.5)
 *   - images with no alt, buttons/links with no accessible name
 *   - inputs with no associated label
 *   - duplicate element ids (a real source of silent JS breakage here)
 *   - empty headings / placeholder text left in ("Lorem", "TODO", "TBD")
 *   - axe-core violations if @axe-core/playwright is installed (optional dep)
 *
 * Run:  npx playwright test tests/ui/audit.spec.js --reporter=list
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubApi, freezeMotion, contrast, APP_DIR } = require('./helpers');

// Every shipped page, minus internal tools nobody but the owner opens.
const SKIP = new Set(['review.html', 'meta.html', 'post.html', 'preview.html',
  'tiktok.html', 'train.html', 'train2.html', 'traindavina.html', 'trainderek.html']);
const PAGES = fs.readdirSync(APP_DIR)
  .filter((f) => f.endsWith('.html') && !SKIP.has(f))
  .sort();

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

// Collected across the whole run so one report lists everything.
const findings = [];
const note = (page, viewport, kind, detail) => findings.push({ page, viewport, kind, detail });

test.afterAll(() => {
  const out = path.join(__dirname, 'audit-report.json');
  fs.writeFileSync(out, JSON.stringify(findings, null, 2));
  const byKind = findings.reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {});
  console.log('\n=== UI AUDIT ===');
  console.log(`${findings.length} finding(s) across ${PAGES.length} page(s)`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
  console.log(`full report: ${out}\n`);
});

for (const vp of VIEWPORTS) {
  for (const page of PAGES) {
    test(`audit ${page} @ ${vp.name}`, async ({ page: p }) => {
      const errors = [];
      const netFails = [];
      p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      p.on('pageerror', (e) => errors.push(String(e)));
      p.on('requestfailed', (r) => netFails.push(`${r.url()} — ${r.failure()?.errorText}`));
      p.on('response', (r) => { if (r.status() >= 400) netFails.push(`${r.status()} ${r.url()}`); });

      await stubApi(p);
      await p.setViewportSize({ width: vp.width, height: vp.height });
      await p.goto('/' + page, { waitUntil: 'load' });
      await freezeMotion(p);
      await p.waitForTimeout(700); // let deferred scripts settle

      for (const e of errors) note(page, vp.name, 'console-error', e.slice(0, 300));
      for (const n of netFails) note(page, vp.name, 'network-failure', n.slice(0, 300));

      const dom = await p.evaluate(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        const label = (el) =>
          (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();

        // horizontal overflow — the page must never scroll sideways
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 1
          ? { scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth } : null;
        // …and which element causes it
        const wide = [...document.querySelectorAll('body *')].filter((el) => {
          const r = el.getBoundingClientRect();
          return vis(el) && (r.right > window.innerWidth + 1 || r.left < -1);
        }).slice(0, 5).map((el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''));

        const smallTargets = [...document.querySelectorAll('a,button,input[type=checkbox],input[type=radio],[role=button]')]
          .filter(vis)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => Math.min(r.width, r.height) < 44)
          .slice(0, 10)
          .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} "${label(el).slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);

        const noAlt = [...document.querySelectorAll('img')].filter((i) => vis(i) && i.getAttribute('alt') === null)
          .slice(0, 10).map((i) => i.getAttribute('src') || '(no src)');

        const unnamed = [...document.querySelectorAll('a,button')].filter((el) => vis(el) && !label(el) && !el.querySelector('img[alt]:not([alt=""])'))
          .slice(0, 10).map((el) => el.outerHTML.slice(0, 90));

        const unlabelled = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')]
          .filter((el) => vis(el)
            && !el.getAttribute('aria-label')
            && !el.getAttribute('placeholder')
            && !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
            && !el.closest('label'))
          .slice(0, 10).map((el) => (el.id || el.name || el.tagName.toLowerCase()));

        const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
        const dupeIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

        const emptyHeadings = [...document.querySelectorAll('h1,h2,h3')].filter((h) => vis(h) && !h.textContent.trim())
          .map((h) => h.tagName.toLowerCase());

        const body = document.body.innerText;
        const placeholders = ['lorem ipsum', 'todo', 'tbd', 'coming soon', 'xxx']
          .filter((w) => body.toLowerCase().includes(w));

        // contrast: sample visible text nodes and pair against the nearest painted background
        const bgOf = (el) => {
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && !/rgba?\(0, 0, 0, 0\)|transparent/.test(c)) return c;
          }
          return 'rgb(255,255,255)';
        };
        const textEls = [...document.querySelectorAll('p,span,a,li,h1,h2,h3,h4,label,small,button,td,th,div')]
          .filter((el) => vis(el) && el.children.length === 0 && el.textContent.trim().length > 2)
          .slice(0, 200)
          .map((el) => ({
            text: el.textContent.trim().slice(0, 40),
            fg: getComputedStyle(el).color,
            bg: bgOf(el),
            size: parseFloat(getComputedStyle(el).fontSize),
            weight: getComputedStyle(el).fontWeight,
            sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          }));

        return { overflow, wide, smallTargets, noAlt, unnamed, unlabelled, dupeIds, emptyHeadings, placeholders, textEls };
      });

      if (dom.overflow) {
        note(page, vp.name, 'horizontal-overflow',
          `scrollWidth ${dom.overflow.scrollWidth} > viewport ${dom.overflow.viewport}; suspects: ${dom.wide.join(', ') || 'none identified'}`);
      }
      for (const t of dom.smallTargets) note(page, vp.name, 'tap-target-under-44px', t);
      for (const s of dom.noAlt) note(page, vp.name, 'img-missing-alt', s);
      for (const h of dom.unnamed) note(page, vp.name, 'control-without-name', h);
      for (const i of dom.unlabelled) note(page, vp.name, 'input-without-label', i);
      for (const d of dom.dupeIds) note(page, vp.name, 'duplicate-id', d);
      for (const h of dom.emptyHeadings) note(page, vp.name, 'empty-heading', h);
      for (const w of dom.placeholders) note(page, vp.name, 'placeholder-text', w);

      // WCAG 1.4.3: 4.5:1 normal text, 3:1 for large (>=24px, or >=18.66px bold)
      for (const t of dom.textEls) {
        let ratio;
        try { ratio = contrast(t.fg, t.bg); } catch { continue; }
        const large = t.size >= 24 || (t.size >= 18.66 && Number(t.weight) >= 700);
        const min = large ? 3 : 4.5;
        if (ratio < min) {
          note(page, vp.name, 'low-contrast', `${t.sel} "${t.text}" ${ratio}:1 (needs ${min}) fg=${t.fg} bg=${t.bg}`);
        }
      }

      // Optional: axe-core, if installed. Catches a much wider ARIA/semantics set.
      try {
        const AxeBuilder = require('@axe-core/playwright').default;
        const res = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa']).analyze();
        for (const v of res.violations) {
          note(page, vp.name, `axe:${v.id}`, `${v.help} (${v.nodes.length} node(s))`);
        }
      } catch { /* not installed — the checks above still run */ }

      // The spec never fails: it is a REPORT. Failing per page would stop the
      // sweep at the first bad page, which is exactly the wrong behaviour when
      // you want the full picture before shipping.
      expect(true).toBe(true);
    });
  }
}
