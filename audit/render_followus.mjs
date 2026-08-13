// Render the "follow us" card at the sizes each platform actually wants.
// Square for IG/FB feed, portrait for Stories/Status (WhatsApp status is 9:16).
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';

const DL = '/mnt/c/Users/HP/Downloads';
let html = fs.readFileSync(new URL('./followus.html', import.meta.url), 'utf8');
// Same transparent crest the banners use — icon-192/icon-foreground both bake in
// the opaque plate, which shows as a dark square on this gradient.
const logo = fs.readFileSync('/home/elrio/hawkeye/design/hawk-crest.png').toString('base64');
html = html.replace('LOGO', `data:image/png;base64,${logo}`);

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
for (const [w, h, name] of [
  [1080, 1080, 'hawkeye-follow-square.png'],
  [1080, 1920, 'hawkeye-follow-story.png'],
]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html.replace('width: 1080px; height: 1080px;', `width: ${w}px; height: ${h}px;`),
    { waitUntil: 'load' });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${DL}/${name}` });
  console.log('wrote', name, `${w}x${h}`);
  await p.close();
}
await b.close();
