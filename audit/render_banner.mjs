import { chromium } from 'playwright';
import fs from 'node:fs';
const DL = '/mnt/c/Users/HP/Downloads';
let html = fs.readFileSync(new URL('./banner.html', import.meta.url), 'utf8');
const logo = fs.readFileSync(new URL('../design/hawk-mascot.png', import.meta.url).pathname).toString('base64');
html = html.replace('LOGO', `data:image/png;base64,${logo}`);
const b = await chromium.launch();
for (const [w, h, name] of [
  [1500, 500, 'hawkeye-x-header.png'],       // X / Twitter header
  [1640, 624, 'hawkeye-fb-cover.png'],       // Facebook Page cover
]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${DL}/${name}` });
  console.log('wrote', name, `${w}x${h}`);
  await p.close();
}
await b.close();
