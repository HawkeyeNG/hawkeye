/**
 * The iOS capture screenshot, for BOTH native and Lite.
 *
 *   node tests/ui/make_ios_capture.mjs            # -> /tmp/1-capture.ios.png
 *
 * WHY THIS IS DRAWN RATHER THAN CAPTURED. On iPhone both apps hand sheet
 * capture to Apple's VisionKit document camera (`VNDocumentCameraViewController`
 * — native via react-native-document-scanner-plugin, Lite via the hawkeye-vision
 * plugin). iOS draws that control at runtime, so no browser and no emulator can
 * render it, and there is no screen in either codebase to point a harness at.
 *
 * The layout here is traced from photographs of the real control on the user's
 * device (2026-08-28): circular close button top-left, a dark prompt pill
 * reading "Position the document in view.", the current filter name above a row
 * of Flash / Filters / Shutter, and the shutter. Nothing here is invented UI —
 * it is the same chrome, over our own specimen sheet.
 *
 * The sheet is the SPECIMEN (`backend/scripts/make_specimen_ec8a.mjs`): blank,
 * struck SPECIMEN, unit 00-00-00-000, which is in no register. A real EC8A
 * carries a real unit's real votes and must never go on a store listing.
 *
 * GEOMETRY. Rendered at 440x956 CSS @3 = 1320x2868, the same raw frame the rest
 * of the set uses. make_store_screenshots.mjs fits the raw shot to roughly a
 * 0.465 aspect with `position: top`, which trims about 21px off the bottom of a
 * 2868-tall frame — so the shutter is kept clear of the last ~60 CSS px.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(HERE + '/');
const { chromium } = require_('playwright-core');
const CHROME = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const SHEET = arg('sheet', '/tmp/specimen-ec8a.png');
const OUT = arg('out', '/tmp/1-capture.ios.png');

if (!fs.existsSync(SHEET)) {
  console.error(`no specimen at ${SHEET} — run:\n  cd backend && node scripts/make_specimen_ec8a.mjs --out ${SHEET}`);
  process.exit(2);
}
const sheet = `data:image/png;base64,${fs.readFileSync(SHEET).toString('base64')}`;

/* THE VIEWPORT META IS LOAD-BEARING. Without it, Chromium in isMobile mode lays
   the page out at its 980px default and scales the result down to the 440px
   viewport — so every absolute offset lands at 440/980 of where it belongs. The
   first render put the shutter at 40% of the frame instead of 86% and the sheet
   at a third of its size, and it looked like a styling mistake rather than a
   layout-width one. */
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 440px; height: 956px; overflow: hidden; background: #000;
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Inter, system-ui, sans-serif; }
  .scene { position: absolute; inset: 0; overflow: hidden; }

  /* The surface the sheet is lying on. Kept plain and slightly vignetted: a
     photographed desk would date the image and pull attention off the sheet. */
  .surface { position: absolute; inset: -10%;
    background:
      radial-gradient(120% 80% at 50% 20%, #6d6a63 0%, #4a4843 45%, #2e2d2a 100%); }
  .surface::after { content: ""; position: absolute; inset: 0;
    background: radial-gradient(70% 55% at 50% 46%, rgba(255,255,255,0.10), rgba(0,0,0,0) 70%); }

  /* The sheet, near-square to the lens with a touch of rotation so it reads as
     photographed rather than pasted. It fills the frame the way the app's own
     guidance asks for ("fill this frame top to bottom"). */
  .sheet { position: absolute; left: 50%; top: 42%;
    width: 350px; transform: translate(-50%, -50%) rotate(-0.7deg);
    box-shadow: 0 18px 42px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4); }
  .sheet img { display: block; width: 100%; height: auto; }


  /* Top chrome */
  .close { position: absolute; left: 19px; top: 68px; width: 46px; height: 46px;
    border-radius: 50%; background: rgba(60,60,62,0.82);
    display: flex; align-items: center; justify-content: center; }
  .prompt { position: absolute; left: 50%; top: 110px; transform: translateX(-50%);
    background: rgba(28,28,30,0.78); color: #fff; font-size: 15.5px; font-weight: 600;
    letter-spacing: -0.2px; padding: 9px 16px; border-radius: 18px; white-space: nowrap; }

  /* Bottom chrome */
  .filtername { position: absolute; left: 50%; top: 690px; transform: translateX(-50%);
    background: rgba(28,28,30,0.78); color: #fff; font-size: 14.5px; font-weight: 600;
    padding: 5px 14px; border-radius: 14px; }
  .row { position: absolute; left: 0; right: 0; top: 740px;
    display: flex; justify-content: center; gap: 42px; }
  .item { display: flex; flex-direction: column; align-items: center; gap: 7px; }
  .btn { width: 50px; height: 50px; border-radius: 50%; background: rgba(58,58,60,0.78);
    display: flex; align-items: center; justify-content: center; }
  .lbl { color: #fff; font-size: 12.5px; font-weight: 600; letter-spacing: -0.1px; }
  .shutter { position: absolute; left: 50%; top: 840px; transform: translateX(-50%);
    width: 76px; height: 76px; border-radius: 50%; background: #fff;
    box-shadow: 0 0 0 4px rgba(0,0,0,0.35), 0 0 0 6px rgba(255,255,255,0.9); }
</style></head><body>
  <div class="scene">
    <div class="surface"></div>
    <img class="sheet" src="${sheet}" alt="" style="display:block" />

    <div class="close">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18"/></svg>
    </div>
    <div class="prompt">Position the document in view.</div>

    <div class="filtername">Color</div>
    <div class="row">
      <div class="item">
        <div class="btn">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z"/></svg>
        </div><div class="lbl">Flash</div>
      </div>
      <div class="item">
        <div class="btn">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5">
            <circle cx="9" cy="10" r="5.2"/><circle cx="15" cy="10" r="5.2"/><circle cx="12" cy="15" r="5.2"/></svg>
        </div><div class="lbl">Filters</div>
      </div>
      <div class="item">
        <div class="btn">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round">
            <path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3"/><circle cx="12" cy="12" r="3.4"/></svg>
        </div><div class="lbl">Shutter</div>
      </div>
    </div>
    <div class="shutter"></div>
  </div>
</body></html>`;

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
});
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({ path: OUT });
await browser.close();

const { size } = fs.statSync(OUT);
console.log(`wrote ${OUT}  ${(size / 1024).toFixed(0)} KB`);
