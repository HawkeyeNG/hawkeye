/** Dump the fixed/absolute overlay elements so the capture script can target them. */
import { chromium } from 'playwright';

const TOKEN = process.argv[2];
const ROUTE = process.argv[3] || '/osun';
const BASE = 'http://localhost:8092';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true });
await ctx.addInitScript((t) => {
  localStorage.setItem('hawkeye.auth.token', t);
  localStorage.setItem('hawkeye.auth.observer', '111');
}, TOKEN);
const page = await ctx.newPage();
await page.goto(BASE + ROUTE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const out = [];
  const walk = (root, label) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 20) continue;
      out.push({
        root: label,
        tag: el.tagName,
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 60)) || null,
        aria: el.getAttribute('aria-label'),
        pos: s.position,
        z: s.zIndex,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 70),
      });
    }
  };
  walk(document, 'document');
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.shadowRoot) walk(el.shadowRoot, 'shadow:' + el.tagName);
  }
  return {
    roots: Array.from(document.body.children).map((c) => c.id || c.tagName),
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '(inline)'),
    overlays: out.slice(-40),
  };
});

console.log(JSON.stringify(info, null, 1));
await browser.close();
