/* Rendered-language audit.

   THE TEST: render each page in Hausa AND in English and diff the visible text.
   A string that comes back IDENTICAL in both was never translated. This beats a
   "does it look English" regex, which cannot tell Hausa from English (both are
   Latin script) and flagged real Hausa as a gap.

   It also opens the menu panel and clicks every info dot, so modal and popup
   copy is audited, not just what sits on the page at rest.

   Findings split by the fix they need:
     NOT-APPLIED <key> -- a translation EXISTS and did not reach the screen.
     UNKEYED           -- no key at all; needs keying, then translating.

   ONE CONTEXT PER LANGUAGE: addInitScript cannot be unregistered and runs on
   every navigation, so a single context kept re-forcing its own language --
   the English sweep came back Hausa and every translated string looked like a
   gap. Its own control: text known to be translated must come back in Hausa,
   so a run reporting "no gaps" because nothing rendered fails loudly instead. */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const pw = createRequire('/home/elrio/hawkeye/tests/ui/')('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const en = JSON.parse(readFileSync(APP + '/i18n/en.json', 'utf8'));
const ha = JSON.parse(readFileSync(APP + '/i18n/ha.json', 'utf8'));
const KEY = (readFileSync(APP + '/i18n.js', 'utf8').match(/KEY\s*=\s*['"]([^'"]+)['"]/) || [])[1];

const enVal = new Map();
for (const [k, v] of Object.entries(en)) if (typeof v === 'string') enVal.set(v.trim(), k);
const haVals = new Set(Object.values(ha).filter((v) => typeof v === 'string').map((s) => s.trim()));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const TOKEN = b64({ alg: 'none' }) + '.' + b64({ sub: '1', exp: 9999999999 }) + '.x';
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', css: 'text/css', svg: 'image/svg+xml',
};
const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'index.html', 'observe.html', 'collation.html', 'incident.html', 'map-unit.html',
  'ledger.html', 'docket.html', 'integrity.html', 'political.html', 'races.html',
  'profile.html', 'practice.html', 'alerts.html', 'report.html', 'incident-reports.html',
];

/* Proper nouns, party codes and form numbers read the same in every language. */
const KEEP = /^(INEC|IReV|BVAS|EC8|Hawkeye|Rekor|Leaflet|OpenStreetMap|Telegram|WhatsApp|Nigeria|Osun|FCT|APC|PDP|LP|NNPP|ADC|SDP|AAC|ADP|APGA|ZLP|Accord|IniXien)\b/i;

const browser = await pw.chromium.launch();

const openLang = async (lang) => {
  const ctx = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 6.455, longitude: 3.394 },
  });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.route('https://hk.test/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.startsWith('/api/')) return r.fulfill({ contentType: TYPES.json, body: '{}' });
    const f = APP + (p === '/' ? '/index.html' : p);
    if (!existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ contentType: TYPES[p.split('.').pop()] || 'application/octet-stream', body: readFileSync(f) });
  });
  await pg.addInitScript((a) => {
    try {
      localStorage.setItem(a.k, a.lang);
      localStorage.setItem('hawkeye_token', a.t);
      localStorage.setItem('hawkeye_lang_prompted', '1');
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* private mode */ }
    /* NOT simulating the app shell here. Pre-setting window.HAWKEYE.native
       clashes with native.js, which builds that object itself -- the page came
       up blank and the control caught it. The shell-only chrome is therefore
       out of this audit's scope; everything it does cover is shared code. */
  }, { k: KEY, t: TOKEN, lang });
  return pg;
};

const grab = (pg) => pg.evaluate(() => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = (n.textContent || '').trim();
    if (!t || t.length < 4) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript')) continue;
    /* An <option> has no box of its own, so the rect test below discarded every
       dropdown -- which is where a lot of the reported English lives (the
       incident-type list, "-- select state --"). Options count as visible when
       their <select> is. */
    const box = el.tagName === 'OPTION' ? el.closest('select') : el;
    if (!box) continue;
    const r = box.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    out.push(t);
  }
  /* Copy that lives in ATTRIBUTES still renders on screen but is invisible to a
     text walker: placeholders and tooltips.

     data-info / data-info-title are deliberately NOT swept. They are the info
     dialog's PAYLOAD, not rendered text: they hold English in every language by
     design and are translated through their key when the dialog opens. Reading
     them made the audit report every info modal as untranslated immediately
     after it had been translated -- measuring the source, not the screen. The
     dialog's own text is captured by the walker above once it is open. */
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = (el.getAttribute(a) || '').trim();
      if (v.length >= 4) out.push(v);
    }
  }
  return out;
});

const sweep = async (pg, url) => {
  await pg.goto('https://hk.test/' + url, { waitUntil: 'load' });
  await pg.waitForTimeout(1500);
  const chunks = [...(await grab(pg))];
  for (const sel of ['.menu-btn', '#menu-btn']) {
    const el = await pg.$(sel);
    if (el) { await el.click().catch(() => {}); await pg.waitForTimeout(400); break; }
  }
  chunks.push(...(await grab(pg)));
  const dots = await pg.$$('.info-i');
  for (let i = 0; i < dots.length; i++) {
    await dots[i].click().catch(() => {});
    await pg.waitForTimeout(220);
    chunks.push(...(await grab(pg)));
    await pg.keyboard.press('Escape').catch(() => {});
    await pg.waitForTimeout(100);
  }
  return new Set(chunks);
};

const findings = new Map();
const add = (kind, pg, s) => {
  const k = kind + '\t' + s.slice(0, 160);
  if (!findings.has(k)) findings.set(k, new Set());
  findings.get(k).add(pg);
};
let controlSeen = false;

const haPage = await openLang('ha');
const enPage = await openLang('en');
for (const url of PAGES) {
  try {
    const haText = await sweep(haPage, url);
    const enText = await sweep(enPage, url);
    for (const t of haText) { if (haVals.has(t)) { controlSeen = true; break; } }
    for (const t of haText) {
      if (!enText.has(t)) continue;
      if (KEEP.test(t)) continue;
      if (!/[A-Za-z]{3,}/.test(t)) continue;
      if (/^[0-9][0-9,.\s%:/-]*$/.test(t)) continue;
      add(enVal.has(t) ? 'NOT-APPLIED ' + enVal.get(t) : 'UNKEYED', url, t);
    }
  } catch (e) {
    add('ERROR', url, String(e).slice(0, 120));
  }
}
await browser.close();

if (!controlSeen) {
  console.log('CONTROL FAILED: no Hausa rendered anywhere -- this audit proves nothing');
  process.exit(2);
}
console.log('control ok: Hausa text rendered\n');
const rows = [...findings.entries()].sort();
for (const [k, pgs] of rows) console.log(k + '  [' + [...pgs].slice(0, 3).join(',') + ']');
console.log('\ntotal findings: ' + rows.length);
