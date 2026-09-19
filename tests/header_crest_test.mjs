/**
 * ONE CREST, AND IT HAS TO READ ON THE BAR IT SITS ON.
 *
 * The site used to paint three different logos: the transparent hawk inside the
 * native shell, the green BADGE (icon-192.png) on the website, and a third
 * hand-written <img> in the situation room and the group pages. The admin
 * console had the transparent mark, which is how the difference was noticed.
 *
 * Existence is not the requirement — the badge existed too. The requirement is
 * that the mark is the transparent hawk AND that it is still distinguishable
 * from the header behind it, which is the reason the divergence was introduced
 * in the first place. So this measures the RENDERED crest against the RENDERED
 * bar, and carries a control that the measurement can fail.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/crest_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"rows":[],"items":[]}'); }
  const f = path.join(APP, decodeURIComponent(u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

/**
 * SIGNED IN, OR THERE IS NO HEADER TO MEASURE. `.auth-screen .gov-header`
 * hides the bar outright, and the room bounces a signed-out visitor to
 * observe.html — so the first run of this test measured a 0x0 crest on the
 * sign-in screen and called it a bug in artwork that was perfectly fine.
 * authgate.js only base64-decodes the payload and checks `exp`.
 */
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';
await ctx.addInitScript(([t]) => {
  for (const k of ['hawkeye_token', 'hawkeye_jwt', 'token', 'hk_token']) localStorage.setItem(k, t);
  localStorage.setItem('hawkeye_user', JSON.stringify({ id: 1, name: 'Test', phone: '08000000000' }));
}, [jwt]);
const p = await ctx.newPage();

/**
 * Mean colour of the crest's own opaque pixels, and the colour of the bar it is
 * drawn on, both read from the live page. The crest is same-origin so the
 * canvas is not tainted; a tainted one would throw rather than quietly
 * returning a flat value, which is why the read is not wrapped.
 */
const READ = () => {
  const img = document.querySelector('header .crest img');
  if (!img) return { err: 'no crest img' };
  const box = img.getBoundingClientRect();
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let r = 0, gr = 0, bl = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    r += d[i]; gr += d[i + 1]; bl += d[i + 2]; n++;
  }
  // The bar: sample the header's own paint, not a token, so a gradient or an
  // overriding rule is measured rather than assumed.
  const h = img.closest('header');
  let bg = getComputedStyle(h).backgroundColor;
  if (bg === 'rgba(0, 0, 0, 0)') bg = getComputedStyle(h).backgroundImage;
  return {
    src: img.getAttribute('src'),
    drawn: box.width > 8 && box.height > 8,
    opaque: n,
    mark: n ? [Math.round(r / n), Math.round(gr / n), Math.round(bl / n)] : null,
    bar: bg,
  };
};

const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const dist = (a, c) => Math.round(Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]));

const PAGES = ['index.html', 'observe.html', 'situation-room.html', 'race.html'];
for (const page of PAGES) {
  await p.goto(`${base}/${page}`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(500);
  const r = await p.evaluate(READ);
  // CONTROL for the page itself: a redirect to the sign-in screen would leave
  // every assertion below measuring a header that is not the one under test.
  check(`${page}: CONTROL we are on the page, header shown`,
    { at: new URL(p.url()).pathname.slice(1), hdr: r.drawn }, { at: page, hdr: true });
  check(`${page}: the header crest is the transparent hawk`, r.src, (v) => !!v && /logo\.svg/.test(v));
  check(`${page}: and it actually painted`, r.drawn && r.opaque > 400, true);
  const d = r.mark ? dist(r.mark, rgb(r.bar)) : -1;
  check(`${page}: it reads against the bar (distance ${d})`, d, (v) => v > 45);
  await p.locator('header').first().screenshot({ path: `${OUT}/${page}.png` }).catch(() => {});
}

// CONTROL: the distance measure must be able to fail. Paint the crest in the
// bar's own colour and the same assertion has to reject it — otherwise every
// PASS above is the measurement agreeing with itself.
await p.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const ctl = await p.evaluate(() => {
  const img = document.querySelector('header .crest img');
  const bar = getComputedStyle(img.closest('header')).backgroundColor;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = bar === 'rgba(0, 0, 0, 0)' ? '#00482b' : bar;
  g.fillRect(0, 0, 8, 8);
  img.src = c.toDataURL();
  return new Promise((r) => setTimeout(r, 300));
}).then(() => p.evaluate(READ));
const dctl = dist(ctl.mark, rgb(ctl.bar));
check(`CONTROL a crest in the bar's own colour is rejected (distance ${dctl})`, dctl, (v) => v <= 45);

// ------------------------------------------- every page, not the four rendered
// EIGHT PAGES NEVER LOAD menu.js (admin, review, post, preview, meta, tiktok,
// join, my-groups), so for them the markup IS the final render and no script
// was ever going to swap anything in. Testing only the pages that repaint
// themselves is how five of them kept the emoji.
const pages = fs.readdirSync(APP).filter((f) => f.endsWith('.html'));
const withCrest = pages.filter((f) => /class="crest"/.test(fs.readFileSync(path.join(APP, f), 'utf8')));
check('CONTROL the sweep found the crest markup', withCrest.length > 30, true);
const emoji = withCrest.filter((f) => /<span class="crest"[^>]*>\s*\u{1F985}/u.test(fs.readFileSync(path.join(APP, f), 'utf8')));
check('no page ships the emoji crest', emoji, []);
// The console puts the class ON the <img> rather than on a wrapping <span>,
// so match the artwork near the crest rather than one exact spelling of it.
const wrong = withCrest.filter((f) => {
  const t = fs.readFileSync(path.join(APP, f), 'utf8');
  return [...t.matchAll(/class="crest"/g)]
    .some((m) => !/logo\.svg/.test(t.slice(Math.max(0, m.index - 80), m.index + 200)));
});
check('every page ships the transparent hawk', wrong, []);

// ------------------------------------------------- the two console identities
const man = (f) => JSON.parse(fs.readFileSync(path.join(APP, f), 'utf8'));
const admin = man('admin.webmanifest');
const room = man('room.webmanifest');

// THIS IS WHY ONLY ONE WOULD INSTALL. Both declared scope "/", so each app's
// scope contained the other's start_url and Chrome treated the second page as
// already living inside an installed app.
const covers = (m, url) => url.startsWith(m.scope);
check('admin scope does not swallow the room', covers(admin, room.start_url), false);
check('room scope does not swallow the admin console', covers(room, admin.start_url), false);
check('each app is still inside its OWN scope',
  covers(admin, admin.start_url) && covers(room, room.start_url), true);
check('and their ids differ', admin.id !== room.id, true);

// Distinct identity is not only the id: two identical pictures in a taskbar are
// two apps the reader cannot tell apart.
const srcs = (m) => m.icons.map((i) => i.src.split('?')[0]).sort();
check('the two consoles ship different icons',
  srcs(admin).some((s) => srcs(room).includes(s)), false);
check('neither reuses the observer app icons',
  [...srcs(admin), ...srcs(room)].some((s) => /^icon-\d/.test(s)), false);
for (const [name, m] of [['admin', admin], ['room', room]]) {
  const have = m.icons.map((i) => `${i.sizes} ${i.purpose}`).sort();
  check(`${name}: 192 and 512, any and maskable`, have,
    ['192x192 any', '192x192 maskable', '512x512 any', '512x512 maskable']);
  check(`${name}: every icon file exists`,
    m.icons.every((i) => fs.existsSync(path.join(APP, i.src.split('?')[0]))), true);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — one crest, two separable apps');
process.exit(fail ? 1 : 0);
