import { chromium } from 'playwright';
const OUT = '/mnt/c/Users/HP/Downloads';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
await p.goto('https://hawkeye.com.ng/ledger.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
// Headless Chromium lacks an emoji font, so glyphs render as tofu boxes. Hide the
// emoji-only chrome and strip leading emoji from buttons/badges for a clean shot.
await p.evaluate(() => {
  for (const sel of ['.theme-btn', '.bell-btn', '#hk-fab']) document.querySelectorAll(sel).forEach((e) => e.remove());
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️✅✔]/gu;
  document.querySelectorAll('button, .badge, h1, h2, strong, a').forEach((el) => {
    if (el.children.length === 0 && emoji.test(el.textContent)) el.textContent = el.textContent.replace(emoji, '').replace(/\s+/g, ' ').trim();
  });
});
await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}/hawkeye-ledger.png`, clip: { x: 0, y: 0, width: 1180, height: 1320 } });
console.log('wrote hawkeye-ledger.png');
await b.close();
