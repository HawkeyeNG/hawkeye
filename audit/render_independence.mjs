// Render the Independence Day 2026 card: 1080x1080 (grid-safe) + 1080x1920 story.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';

const DL = '/mnt/c/Users/HP/Downloads';
let html = fs.readFileSync(new URL('./independence.html', import.meta.url), 'utf8');
const logo = fs.readFileSync('/home/elrio/hawkeye/design/hawk-crest.png').toString('base64');
html = html.replace('LOGO', `data:image/png;base64,${logo}`);

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
for (const [w, h, name] of [
  [1080, 1080, 'hawkeye-independence-2026-square.png'],
  [1080, 1920, 'hawkeye-independence-2026-story.png'],
]) {
  let sized = html.replace('width: 1080px; height: 1080px;', `width: ${w}px; height: ${h}px;`);
  // IG/WhatsApp draw their own chrome over ~130px top and ~150px bottom of a story.
  if (h >= 1600) sized = sized.replace('</style>', '.card { padding-top: 200px; padding-bottom: 220px; }</style>');
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.setContent(sized, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${DL}/${name}` });
  console.log('wrote', name, `${w}x${h}`);
  await p.close();
}
await b.close();
