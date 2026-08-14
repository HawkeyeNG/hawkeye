// Render the "Sign up today" card at the sizes each platform actually wants.
// Portrait 4:5 is the IG/FB feed size that takes the most vertical space,
// square for X and Telegram, 9:16 for Stories and WhatsApp status.
//
// One markup, three viewports: signup.html centres its middle block with
// `margin: auto 0` and pins the footer, so nothing needs a per-size rule.
// The renderer OVERWRITES the body height rather than scaling, so type stays
// at its designed size at every aspect ratio.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';

const DL = '/mnt/c/Users/HP/Downloads';
let html = fs.readFileSync(new URL('./signup.html', import.meta.url), 'utf8');
// The transparent crest, same as the banners: icon-192/icon-foreground both
// bake in the opaque plate, which shows as a dark square on this gradient.
const logo = fs.readFileSync('/home/elrio/hawkeye/design/hawk-crest.png').toString('base64');
html = html.replace('LOGO', `data:image/png;base64,${logo}`);

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
for (const [w, h, name] of [
  [1080, 1350, 'hawkeye-signup-portrait.png'],
  [1080, 1080, 'hawkeye-signup-square.png'],
  [1080, 1920, 'hawkeye-signup-story.png'],
]) {
  let sized = html.replace('width: 1080px; height: 1350px;', `width: ${w}px; height: ${h}px;`);

  // STORY SAFE AREA. The header and footer are pinned to the top and bottom
  // edges, which is right on a feed card and wrong on a 9:16 story: Instagram
  // and WhatsApp both draw their own chrome over roughly the top 130px and
  // bottom 150px, so the crest and the "not affiliated with INEC" line — the
  // two things that establish who is asking — sit under it. Only the tall crop
  // has the spare height to give, so only the tall crop pays for it.
  if (h >= 1600) {
    sized = sized.replace('</style>',
      'body { padding-top: 168px; padding-bottom: 190px; }</style>');
  }

  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(sized, { waitUntil: 'load' });
  await p.waitForTimeout(400);

  // GATE ON OVERFLOW. One markup at three heights is only safe if something
  // checks; at 1080 square the stack is closest to the edge, and a card that
  // silently clips its own call to action is worse than no card.
  //
  // Measure the CONTENT boxes, not document.scrollHeight: .hash is a decorative
  // field of hex deliberately larger than the card and clipped by
  // `overflow: hidden`, so scrollHeight is ~3400px at every size and says
  // nothing about whether the words fit.
  const over = await p.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const top = r('.top'), main = r('.main'), foot = r('.foot');
    return {
      client: document.body.clientHeight,
      topTop: Math.round(top.top),
      mainTop: Math.round(main.top),
      mainBottom: Math.round(main.bottom),
      footTop: Math.round(foot.top),
      footBottom: Math.round(foot.bottom),
    };
  });
  const bad = [];
  if (over.topTop < -1) bad.push('header clipped at the top');
  if (over.footBottom > over.client + 1) bad.push('footer past the bottom edge');
  if (over.mainTop < over.topTop) bad.push('body overlaps the header');
  if (over.mainBottom > over.footTop + 1) bad.push('body overlaps the footer');
  if (bad.length) {
    console.error(`OVERFLOW at ${w}x${h}: ${bad.join('; ')}`, JSON.stringify(over));
    process.exitCode = 1;
  }

  await p.screenshot({ path: `${DL}/${name}` });
  console.log('wrote', name, `${w}x${h}`, bad.length ? 'FITS=NO' : 'fits=yes');
  await p.close();
}
await b.close();
