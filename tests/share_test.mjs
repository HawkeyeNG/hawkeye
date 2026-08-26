/**
 * SHARE HAWKEYE — the control, the page it points at, and the words both
 * clients send.
 *
 * The first half runs the real app/share.js in a real browser against the real
 * files (the same local-server harness tests/lite_type_scale_test.mjs uses),
 * because the interesting failures here are runtime ones: a control that never
 * gets mounted, a sheet that builds with no targets, a link that resolves to a
 * directory listing.
 *
 * The second half is source-level and it is the one that will actually catch
 * something later: the website and the app each hold their own copy of the
 * share text, and two clients sending different descriptions of the same
 * product into the same group chat is the kind of drift that reads as
 * impersonation.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

/**
 * The static server mirrors the ONE routing rule the real server adds for this
 * feature: /download is a page, and app/download/ is a real directory full of
 * APKs sitting right next to it. Getting that backwards is the single most
 * likely way this ships broken, so the harness reproduces the collision rather
 * than serving a tidier tree than production has.
 */
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
  const f = u === '/download' ? path.join(APP, 'download.html')
    : path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

console.log('=== /download is the page a shared link opens ===');
{
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  await p.goto(`${base}/download`);
  await p.waitForTimeout(300);
  check('it renders', await p.title(), 'Hawkeye — Get the app');
  // A shared link is read by somebody who has never heard of Hawkeye, so the
  // preview card in WhatsApp is the first thing most new users see of it.
  check('it has an OG title for the preview card',
    await p.getAttribute('meta[property="og:title"]', 'content'), 'Get Hawkeye');
  check('and an OG image', await p.getAttribute('meta[property="og:image"]', 'content'),
    (v) => !!v && v.startsWith('https://'));
  const play = await p.$eval('.dl-badges a[href*="play.google.com"]', (a) => ({ hidden: a.hidden, w: a.querySelector('img').naturalWidth }));
  check('the Play badge is shown', play.hidden, false);
  check('and its artwork actually loaded (not the text fallback)', play.w, (w) => w > 100);
  // THE CONTROL for the line above: the App Store badge must be HIDDEN, because
  // the listing is not live. A test that only checks what is visible would pass
  // just as happily if every badge were shown.
  check('the App Store badge stays dark until the listing is live',
    await p.$eval('#ios-cta', (a) => a.hidden), true);
  check('no sideways scroll on a phone',
    await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await p.close();
}

console.log('\n=== the APKs are still where the install dialog points ===');
{
  // /download is now a route. app/download/ is a directory of APKs underneath
  // it, and the install dialog links straight into it.
  const apk = /href="(download\/[^"]+\.apk)"/.exec(fs.readFileSync(`${APP}/index.html`, 'utf8'));
  check('index.html links a versioned APK', !!apk);
  check('and that file exists', fs.existsSync(path.join(APP, apk[1])));
  check('download.html does not shadow it', apk[1] !== 'download.html');
}

console.log('\n=== the fallback sheet: what a desktop gets ===');
{
  // Headless Chromium has no navigator.share and no Capacitor, so this is the
  // third route by default — which is exactly the desktop case.
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(`${base}/download`);
  await p.waitForTimeout(300);
  check('there is no OS sheet here to steal the click', await p.evaluate(() => !!navigator.share), false);
  /**
   * SCOPED TO THE PAGE'S OWN BUTTON. There are two share controls on this page:
   * this one, and the "Share Hawkeye" entry menu.js injects into the header
   * panel of every page — which is inside a hidden <nav>, so an unscoped click
   * waits thirty seconds for something that is never visible.
   *
   * Both being here is the point, not the problem: it proves menu.js's
   * mount-by-hand path fires on a page that had already loaded share.js and
   * already swept for [data-share] before the menu entry existed.
   */
  check('both controls are mounted', await p.$$eval('[data-share]', (els) => els.map((e) => e.dataset.shareMounted).join()), '1,1');
  await p.click('.dl-share [data-share]');
  const sheet = await p.evaluate(() => {
    const s = document.querySelector('.share-sheet');
    if (!s) return null;
    return {
      open: s.open,
      targets: [...s.querySelectorAll('.share-targets a')].map((a) => a.textContent),
      hrefs: [...s.querySelectorAll('.share-targets a')].map((a) => a.href),
      link: s.querySelector('.share-link code')?.textContent,
    };
  });
  check('the sheet opened', sheet?.open, true);
  check('with the four that have web share intents',
    sheet.targets.join(', '), 'WhatsApp, Telegram, X, Facebook');
  // Instagram has no share intent at all and iMessage has no web URL. They are
  // reachable through the OS sheet on a phone; on a desktop the honest answer is
  // Copy link, not a button that goes somewhere wrong.
  check('and none that do not', /instagram|imessage/i.test(sheet.targets.join()), false);
  check('every target carries the download link',
    sheet.hrefs.every((h) => decodeURIComponent(h).includes('hawkeye.com.ng/download')));
  // clipboard.writeText needs a secure context and can be refused outright, so
  // a Copy button that silently does nothing would be the whole feature failing.
  check('the link is printed too, not only copyable', sheet.link, 'https://hawkeye.com.ng/download');
  await p.close();
}

console.log('\n=== the menu carries it on every page ===');
{
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  await p.goto(`${base}/ledger.html`);
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => {
    const a = document.querySelector('#menu-panel a[data-share]');
    const heads = [...document.querySelectorAll('#menu-panel .menu-group')].map((h) => h.textContent);
    return a ? { text: a.textContent, href: a.getAttribute('href'), mounted: a.dataset.shareMounted, heads } : { heads };
  });
  check('a page that never mentioned sharing has the entry', m.text, 'Share Hawkeye');
  check('under the section the app puts it in', m.heads, (h) => h.includes('Find Hawkeye'));
  // The href is not decoration: before share.js loads, or if it fails to, this
  // still has to go somewhere useful.
  check('it degrades to the download page', m.href, 'download.html');
  check('and the handler is attached', m.mounted, '1');
  await p.close();
}

await b.close();
server.close();

console.log('\n=== both clients say the same thing ===');
{
  const web = fs.readFileSync(`${APP}/share.js`, 'utf8');
  const app = fs.readFileSync(`${ROOT}/native/src/lib/share.ts`, 'utf8');
  // Pulled out of each file rather than compared to a literal here: a constant
  // written into this test is a third copy, and it would be the one that never
  // gets updated.
  /**
   * ONE normaliser, applied to BOTH — not two hand-rolled unescapes. The first
   * attempt stripped quotes on one side and backslashes on the other, and
   * reported two identical sentences as different. A comparison whose two halves
   * are prepared differently is testing the preparation.
   *
   * It joins the concatenated string pieces, then drops every quote and
   * backslash, so `INEC\'s` and `INEC's` land on the same text.
   */
  const norm = (s) => (s || '').replace(/\s*\+\s*/g, '').replace(/[\\'"]/g, '').replace(/\s+/g, ' ').trim();
  const webText = norm(/var TEXT = ([\s\S]*?);\n/.exec(web)?.[1]);
  const appText = norm(/export const SHARE_TEXT =([\s\S]*?);\n/.exec(app)?.[1]);
  check('the website has a share text', !!webText);
  check('so does the app', !!appText);
  check('and they are the same sentence', webText, appText);
  check('both send the same link',
    /'(https:\/\/hawkeye\.com\.ng\/download)'/.exec(web)?.[1],
    /'(https:\/\/hawkeye\.com\.ng\/download)'/.exec(app)?.[1]);
  // The tone rule, asserted rather than left to a comment: this arrives in
  // somebody's WhatsApp from a person they know, about an election.
  check('no advertising voice on either', /!|download now|best app/i.test(webText + appText), false);
}

console.log('\n=== the app opens the OS sheet, with no new dependency ===');
{
  const app = fs.readFileSync(`${ROOT}/native/src/lib/share.ts`, 'utf8');
  check("it uses react-native's own Share", /from 'react-native'/.test(app));

  /**
   * THE LINK GOES IN EXACTLY ONE PLACE PER PLATFORM, and this assertion used to
   * encode the opposite.
   *
   * It read `message: ${SHARE_TEXT} ${SHARE_LINK}` unconditionally, alongside a
   * comment claiming iOS de-duplicates message and url. iOS does not: RN's
   * RCTActionSheetManager.mm appends `message` and then `URL` to one activity
   * items array, and WhatsApp, Telegram, Messages and Mail all render both — so
   * every iOS share carried the address twice, which is the spam signature the
   * copy was written to avoid. The test passed the whole time, because it was
   * asserting the bug.
   *
   * Now it pins the real rule, both halves, so neither branch can be collapsed
   * back into the other.
   */
  const ios = /\{ message: SHARE_TEXT, url: SHARE_LINK, title: 'Hawkeye' \}/.test(app);
  const android = /\{ message: `\$\{SHARE_TEXT\} \$\{SHARE_LINK\}`, title: 'Hawkeye' \}/.test(app);
  check('it branches on platform at all', /Platform\.OS === 'ios'/.test(app));
  check('iOS sends the sentence clean and the link as its own item', ios);
  check('Android puts the link in the message, the only field its intent carries', android);
  // The control: neither form may carry BOTH a concatenated message and a url,
  // which is exactly what the old code did.
  check('nothing sends the link twice', /message: `\$\{SHARE_TEXT\} \$\{SHARE_LINK\}`, url:/.test(app), false);
  const pkg = JSON.parse(fs.readFileSync(`${ROOT}/mobile/package.json`, 'utf8'));
  // Lite is the one surface with no navigator.share — Android WebView does not
  // expose it — so it needs the plugin, and without this line `cap sync` would
  // ship an app whose share button silently does nothing.
  check('Lite has the Capacitor Share plugin', !!pkg.dependencies['@capacitor/share']);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
