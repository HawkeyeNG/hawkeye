// Render the "Vote Safely" card.
//
// SQUARE IS THE PRIMARY. Instagram's profile grid crops every tile to a centre
// square, so a 4:5 card loses its top and bottom there and a landscape one
// loses its sides mid-word — which is exactly what happened to the two "install
// without the Play Store" posts, cut from 1920x1008 sources. At 1:1 the grid
// thumbnail IS the card.
//
// The 9:16 story shares the markup and adds safe-area padding, because IG and
// WhatsApp draw their own chrome over roughly the top 130px and bottom 150px.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';

const DL = '/mnt/c/Users/HP/Downloads';
let html = fs.readFileSync(new URL('./votesafely.html', import.meta.url), 'utf8');
const logo = fs.readFileSync('/home/elrio/hawkeye/design/hawk-crest.png').toString('base64');
html = html.replace('LOGO', `data:image/png;base64,${logo}`);

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
for (const [w, h, name] of [
  [1080, 1080, 'hawkeye-votesafely-square.png'],
  [1080, 1920, 'hawkeye-votesafely-story.png'],
]) {
  let sized = html.replace('width: 1080px; height: 1080px;', `width: ${w}px; height: ${h}px;`);
  if (h >= 1600) {
    sized = sized.replace('</style>', 'body { padding-top: 168px; padding-bottom: 190px; }</style>');
  }

  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(sized, { waitUntil: 'load' });
  await p.waitForTimeout(400);

  // Measure the CONTENT boxes, never document.scrollHeight: .hash is a
  // decorative field deliberately larger than the card and clipped by
  // `overflow: hidden`, so scrollHeight is ~3000px at every size and says
  // nothing about whether the words fit.
  const m = await p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const top = r('.top'), main = r('.main'), foot = r('.foot');
    return {
      client: document.body.clientHeight,
      topTop: Math.round(top.top), mainTop: Math.round(main.top),
      mainBottom: Math.round(main.bottom), footTop: Math.round(foot.top),
      footBottom: Math.round(foot.bottom),
    };
  });
  const bad = [];
  if (m.topTop < -1) bad.push('header clipped');
  if (m.footBottom > m.client + 1) bad.push('footer past the bottom edge');
  if (m.mainTop < m.topTop) bad.push('body overlaps header');
  if (m.mainBottom > m.footTop + 1) bad.push('body overlaps footer');
  if (bad.length) {
    console.error(`OVERFLOW at ${w}x${h}: ${bad.join('; ')}`, JSON.stringify(m));
    process.exitCode = 1;
  }

  await p.screenshot({ path: `${DL}/${name}` });
  console.log('wrote', name, `${w}x${h}`, bad.length ? 'FITS=NO' : 'fits=yes');
  await p.close();
}
await b.close();
