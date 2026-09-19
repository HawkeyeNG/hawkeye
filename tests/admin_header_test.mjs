import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/admin_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.startsWith('/api/')) return json({ ok: true, observers: [], incidents: [], labels: [], stats: {}, rows: [], items: [] });
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
/**
 * A TOKEN authgate.js WILL ACCEPT — it base64-decodes the JWT payload and
 * checks `exp` rather than calling the server, and admin.html is not on its
 * public list. Without this the page redirects to observe.html and every
 * assertion below is made against the sign-in screen, which is how this first
 * failed against markup that was perfectly correct.
 */
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';
const SCHEME = process.argv[2] === 'dark' ? 'dark' : 'light';
console.log(`(colour scheme: ${SCHEME})`);
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: SCHEME });
await ctx.addInitScript((t) => {
  try { localStorage.setItem('hawkeye_token', t); } catch (e) { /* about:blank */ }
}, jwt);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

// ---- LOCKED: the console has nothing to navigate, so no tabs ------------
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
check('CONTROL the auth gate let us onto the console', p.url(), (u) => /admin\.html/.test(u));
check('locked: the tab strip is hidden', await p.evaluate(() => document.getElementById('panelbar').hidden), true);
check('locked: nothing renders it anyway', await p.evaluate(() => {
  const el = document.getElementById('panelbar');
  return getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0;
}), true);
check('the crest is the hawk, not an emoji', await p.evaluate(() => {
  const c = document.querySelector('.crest');
  return c && c.tagName === 'IMG' && /logo\.svg/.test(c.getAttribute('src'));
}), true);
check('its own manifest is linked', await p.evaluate(() =>
  document.querySelector('link[rel=manifest]')?.getAttribute('href')), (h) => /admin\.webmanifest/.test(h || ''));
check('install is hidden until the browser offers it', await p.evaluate(() =>
  document.getElementById('btn-install').hidden), true);
await p.screenshot({ path: `${OUT}/locked-${SCHEME}.png` });

// ---- UNLOCKED ----------------------------------------------------------
await p.evaluate(() => {
  sessionStorage.setItem('hawkeye_admin', 'test');
  localStorage.setItem('hawkeye_admin', 'test');
});
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
const shown = await p.evaluate(() => !document.getElementById('panelbar').hidden);
check('unlocked: the tab strip appears', shown, true);
if (shown) {
  check('all ten buttons are there, Install between Register and Lock', await p.evaluate(() =>
    [...document.querySelectorAll('#panelbar .tab')].map((t) => t.textContent.trim())),
    (v) => v.length === 10 && v[0] === 'Reach'
        && v[7] === 'Register' && v[8] === 'Install' && /Lock/.test(v[9]));
  // Install is a .tab with NO data-p, and the strip's click handler matches any
  // .tab. Without a guard, `key` is undefined, `p.dataset.p !== key` holds for
  // every panel, and one click blanks the console.
  check('clicking Install does not blank the console', await p.evaluate(async () => {
    document.getElementById('btn-install').hidden = false;
    document.getElementById('btn-install').click();
    await new Promise((r) => setTimeout(r, 120));
    const open = [...document.querySelectorAll('.panel')].filter((x) => !x.hidden);
    const lit = document.querySelector('#panelbar .tab.on');
    return { open: open.length, lit: lit && lit.dataset.p };
  }), (v) => v.open === 1 && v.lit === 'reach');
  /* ONE LINE, AND INSTALL IS A PILL LIKE THE REST.
     styles.css styles every <button> as a full-width primary action
     (display:block; width:100%; margin:16px 0 0). `.tab` outranks it on shape
     but sets no display, width or margin — so Install, the only BUTTON in a
     strip of nine spans, stretched the whole row and pushed itself onto a line
     of its own. Everything here passed while it did: it was in the header, it
     was legible, it was clickable, and the header still respected its cap.
     Nothing measured the SHAPE of the row. */
  const rowOf = () => p.evaluate(() => {
    const tabs = [...document.querySelectorAll('#panelbar .tab')];
    const tops = tabs.map((t) => t.getBoundingClientRect().top);
    const w = tabs.map((t) => t.getBoundingClientRect().width);
    const install = document.getElementById('btn-install').getBoundingClientRect().width;
    return {
      spread: Math.round(Math.max(...tops) - Math.min(...tops)),
      install: Math.round(install),
      widest: Math.round(Math.max(...w.filter((x, i) => tabs[i].id !== 'btn-install'))),
      header: Math.round(document.querySelector('header').getBoundingClientRect().height),
    };
  });
  const row = await rowOf();
  // A wrapped strip puts a whole pill height between the two rows; the 2px
  // here is the emoji in "Lock" sitting a hair taller than its neighbours.
  check(`every tab is on one line (spread ${row.spread}px)`, row.spread, (v) => v < 12);
  check(`Install is a pill, not a bar (${row.install}px vs ${row.widest}px widest)`,
    row.install, (v) => v <= row.widest * 1.6);
  check(`the header is one row tall (${row.header}px)`, row.header, (v) => v < 90);

  // CONTROL: restore the full-width button and the three assertions above must
  // reject it. Without this they are three numbers agreeing with the layout
  // that happens to exist.
  await p.evaluate(() => {
    const b = document.getElementById('btn-install');
    b.style.width = '100%';
    b.style.display = 'block';
  });
  await p.waitForTimeout(120);
  const broken = await rowOf();
  check(`CONTROL a full-width Install breaks the row (spread ${broken.spread}px)`,
    broken.spread >= 12 || broken.install > broken.widest * 1.6, true);
  await p.evaluate(() => {
    const b = document.getElementById('btn-install');
    b.style.width = '';
    b.style.display = '';
  });

  check('they sit inside the header', await p.evaluate(() =>
    !!document.querySelector('header #panelbar')), true);
  // The header must not scroll away from a long panel: that was the point.
  check('and above the main content', await p.evaluate(() => {
    const bar = document.getElementById('panelbar').getBoundingClientRect();
    const main = document.querySelector('main').getBoundingClientRect();
    return bar.bottom <= main.top + 1;
  }), true);
  /**
   * EVERY LABEL IS READABLE. The first version of this header put white pills
   * on the dark green bar and set no text colour, so the tabs inherited the
   * header's #fff and eight of the nine labels were white on white — laid out
   * perfectly, and invisible. A layout assertion cannot see that.
   */
  /**
   * THE HEADER RESPECTS ITS OWN MAX-WIDTH.
   *
   * .wrap is 1120px site-wide and main.wrap is 840 — the header IS meant to be
   * wider than the content, on every page. What broke was different: a flex
   * item does not shrink below its min-content, so nine tabs plus the brand
   * blew past the 1120 cap and the header ran to the window edge. On a wide
   * monitor that put the brand hard left while the content stayed centred,
   * which reads as a broken page without a single element being missing.
   *
   * Asserted at a WIDE viewport as well, because at 1280 the row happens to
   * land on its cap and the overflow does not show.
   */
  check('the header respects its 1120px cap', await p.evaluate(() => {
    const row = document.querySelector('.brand-row').getBoundingClientRect();
    const bar = document.getElementById('panelbar').getBoundingClientRect();
    return { rowW: Math.round(row.width), barR: Math.round(bar.right), rowR: Math.round(row.right) };
  }), (v) => v.rowW <= 1121 && v.barR <= v.rowR + 2);

  {
    const wide = await ctx.newPage();
    await wide.setViewportSize({ width: 1900, height: 840 });
    await wide.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
    await wide.waitForTimeout(500);
    check('and still caps on a wide monitor', await wide.evaluate(() => {
      const row = document.querySelector('.brand-row').getBoundingClientRect();
      const bar = document.getElementById('panelbar').getBoundingClientRect();
      return { rowW: Math.round(row.width), barR: Math.round(bar.right), rowR: Math.round(row.right) };
    }), (v) => v.rowW <= 1121 && v.barR <= v.rowR + 2);
    await wide.close();
  }

  check('every tab label contrasts with its own pill', await p.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = (c.match(/\d+/g) || [0, 0, 0]).map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    };
    return [...document.querySelectorAll('#panelbar .tab')].every((t) => {
      const st = getComputedStyle(t);
      return Math.abs(lum(st.color) - lum(st.backgroundColor)) > 0.35;
    });
  }), true);

  // Switching still works after the move — the handler binds by id.
  await p.click('#panelbar .tab[data-p="push"]');
  await p.waitForTimeout(250);
  check('clicking a tab still switches the panel', await p.evaluate(() => {
    const on = document.querySelector('#panelbar .tab.on')?.dataset.p;
    const vis = [...document.querySelectorAll('.panel')].filter((x) => !x.hidden).map((x) => x.dataset.p);
    return { on, vis };
  }), (r) => r.on === 'push' && r.vis.length === 1 && r.vis[0] === 'push');
  await p.screenshot({ path: `${OUT}/unlocked-${SCHEME}.png` });
}
check('no page errors', errs, []);

await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
