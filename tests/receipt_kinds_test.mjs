/**
 * THE RECEIPT CARD FOR COLLATIONS AND INCIDENTS — the same card a unit result
 * gets (app/receipt.js, native/src/lib/receipt.ts + components/receipt-card.tsx),
 * labelled COLLATION or INCIDENT, and claiming only what is true of each.
 *
 *  1. THE RULE, on both clients (the shipped files, not copies): a collation
 *     carries its collation-chain hash but NO verify link (ledger.html lists the
 *     unit chain only); an incident is never on a ledger — "sent for review"
 *     with a reference, "saved on your phone" without — and shows ONLY its type,
 *     state and time: nothing a caller passes about the description, media,
 *     unit or position reaches the card. A unit result is unchanged.
 *  2. WEB RENDER: the canvas draws all four new states; the incident card has
 *     no figures box (shorter); show() reveals, saves with the photos under the
 *     Profile switch, and says which happened.
 *  3. THE PAGE: incidents.html, filed online and offline, opens the done modal
 *     with the card in the right state, drawn from the type alone.
 *     collation.html shows the card at both hand-offs (source).
 *  4. NATIVE RENDER: ReceiptCard (react-native-svg, rendered to markup with
 *     stand-in SVG elements) and the shared ReceiptCopy block; the collation
 *     and incident screens use them, and the incident screen passes no detail.
 * Each refusal sits beside a CONTROL that shows the check can fail.
 *
 *   node tests/receipt_kinds_test.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const N = `${ROOT}/native`;
const nreq = createRequire(`${N}/package.json`);
const { chromium } = createRequire(`${ROOT}/tests/ui/`)('playwright-core');
const ts = nreq('typescript');

let fail = 0;
const check = (label, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `\n        ${extra}`}`); };

/* ---------------------------------------------------------------- 1. rule */
const sandbox = { window: {}, document: { createElement: () => ({ getContext: () => ({}) }) } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${APP}/receipt.js`, 'utf8'), sandbox);
const web = sandbox.window.HAWKEYE_RECEIPT;
const tsMod = (file) => {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', code)(() => ({}), m, m.exports);
  return m.exports;
};
const rn = tsMod(`${N}/src/lib/receipt.ts`);
const T = (_k, en) => en;
const AT = Date.UTC(2026, 0, 16, 15, 5);
const HASH = 'c0ffee'.repeat(10) + 'abcd';

/** Everything a caller might be tempted to pass about an incident. None of it may reach the card. */
const SECRET = {
  description: 'SECRET-DESCRIPTION-agents-at-gate', puName: 'SECRET-UNIT-NAME', puCode: '99-99-99-999',
  ward: 'SECRET-WARD', lga: 'SECRET-LGA', lat: 6.123456, lng: 3.654321, media: [{ file: 'incidents/SECRET.jpg' }],
  votes: [{ party: 'SECRETPARTY', count: 777 }], contest: 'SECRET-CONTEST', entryHash: 'f'.repeat(64),
};
const CASES = {
  collationRecorded: { kind: 'collation', area: 'Udu III', form: 'EC8B', lga: 'Udu', state: 'Delta', contest: 'Governorship', votes: [{ party: 'PDP', count: 1200 }, { party: 'APC', count: 980 }, { party: 'LP', count: 0 }], entryHash: HASH, at: AT },
  collationQueued: { kind: 'collation', area: 'Delta', form: 'EC8D', contest: 'Governorship', votes: [{ party: 'PDP', count: 12 }], entryHash: '', at: AT },
  incidentSent: { kind: 'incident', incident: 'Vote-buying', reference: 41, at: AT, ...SECRET },
  incidentQueued: { kind: 'incident', incident: 'Vote-buying', reference: null, at: AT, ...SECRET },
  incidentWithState: { kind: 'incident', incident: 'Violence', state: 'Kano', reference: 'sent', at: AT },
  resultRecorded: { puName: 'Ogbe-Udu Primary School', puCode: '10-18-03-001', ward: 'Udu III', lga: 'Udu', state: 'Delta', contest: 'SHA By-Election (Udu)', votes: [{ party: 'PDP', count: 120 }], entryHash: HASH, at: AT },
};

console.log('=== 1. the rule, web and native ===');
for (const [name, d] of Object.entries(CASES)) {
  const a = web.lines(d, T);
  const b = rn.receiptLines(d, T);
  check(`${name}: both clients build the same card`, JSON.stringify(a) === JSON.stringify(b),
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).join(', '));
}
for (const [who, L] of [['web', web], ['native', { lines: rn.receiptLines }]]) {
  const C = L.lines(CASES.collationRecorded, T);
  check(`${who}: collation is labelled Collation`, C.label === 'Collation' && C.kind === 'collation');
  check(`${who}: collation headline is the area, the form under it, then the levels above`,
    C.unit === 'Udu III' && C.code === 'EC8B' && C.where === 'Udu · Delta' && C.contest === 'Governorship', JSON.stringify([C.unit, C.code, C.where, C.contest]));
  check(`${who}: collation keeps its figures, highest first, zeros dropped`,
    C.figures === true && JSON.stringify(C.votes.map((v) => v.party)) === '["PDP","APC"]' && C.total === 2180);
  check(`${who}: collation carries its collation-chain hash`, C.hash === HASH && C.hashLabel === 'COLLATION LEDGER ENTRY');
  check(`${who}: …and NO verify link (ledger.html lists the unit chain only)`, C.verify === '');
  check(`${who}: CONTROL a unit result with the same hash DOES get one`, L.lines(CASES.resultRecorded, T).verify === `hawkeye.com.ng/ledger.html#${HASH}`);
  const Q = L.lines(CASES.collationQueued, T);
  check(`${who}: a queued collation is saved on the phone, no hash, no link`, Q.pending && Q.hash === '' && Q.verify === '' && Q.title === 'Saved on your phone');

  const I = L.lines(CASES.incidentSent, T);
  check(`${who}: incident is labelled Incident, "Your copy of this report"`, I.label === 'Incident' && I.title === 'Your copy of this report');
  check(`${who}: incident is sent for review — never a ledger`, !I.pending && I.hash === '' && I.verify === '' && /Sent for review/.test(I.status) && !/ledger/i.test(I.status));
  check(`${who}: incident type is the headline; no race line, no figures`, I.unit === 'Vote-buying' && I.contest === '' && I.figures === false && I.votes.length === 0 && I.total === 0);
  const flat = JSON.stringify(I);
  const leaks = ['SECRET', '99-99-99-999', '6.123456', '3.654321', '777', 'f'.repeat(16)].filter((s) => flat.includes(s));
  check(`${who}: NOTHING else of the report reaches an incident card (description, unit, position, media, votes, hash)`, leaks.length === 0, JSON.stringify(leaks));
  const R = JSON.stringify(L.lines({ ...CASES.resultRecorded, puName: 'SECRET-UNIT-NAME' }, T));
  check(`${who}: CONTROL the leak check fires on a result card that names its unit`, R.includes('SECRET'));
  check(`${who}: incident foot is about review, not about declaring results`, /reviewed/.test(I.foot) && !/declare/.test(I.foot));
  const P = L.lines(CASES.incidentQueued, T);
  check(`${who}: a queued incident is saved on the phone and says it is not sent yet`, P.pending && P.title === 'Saved on your phone' && /Not sent yet/.test(P.status));
  const S = L.lines(CASES.incidentWithState, T);
  check(`${who}: the state (the one place the public feed names) may sit under the type`, S.unit === 'Violence' && S.where === 'Kano');
  const U = L.lines(CASES.resultRecorded, T);
  check(`${who}: a unit result is the card it always was (no label, figures, ledger link)`, U.label === '' && U.kind === 'result' && U.figures && U.hashLabel === 'LEDGER ENTRY' && U.title === 'Your copy of this result');
}

/* ---------------------------------------------------------- 2. web render */
console.log('\n=== 2. web render ===');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const posted = [];
let dropNext = false;
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u === '/api/incidents' && req.method === 'POST') {
    // OFFLINE: every POST dies while this is set. Not just the next one —
    // Chromium transparently retries a request whose reused socket was reset.
    if (dropNext) { req.socket.destroy(); return; }
    let raw = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { posted.push(raw); json(201, { ok: true, id: 41, status: 'pending' }); });
    return;
  }
  if (u === '/api/incidents/kinds') return json(200, ['violence', 'ballot_snatching', 'vote_buying', 'intimidation', 'bvas_failure', 'late_materials', 'obstruction', 'other']);
  if (u === '/api/incidents') return json(200, { incidents: [] });
  if (u === '/api/observers/my-unit') return json(200, { unit: null });
  if (u.startsWith('/api/')) return json(200, {});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];
{
  const p = await b.newPage();
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/receipt.js`);
  await p.setContent(`<div id="w" hidden><img id="i"><p id="n"></p></div><script src="${base}/receipt.js"></script>`);
  await p.waitForFunction(() => !!window.HAWKEYE_RECEIPT);
  const out = await p.evaluate((C) => {
    const R = window.HAWKEYE_RECEIPT;
    const shot = (d) => {
      const c = R.render(d, null);
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < px.length; i += 4 * 97) if (px[i] > 60 || px[i + 1] > 90 || px[i + 2] > 60) ink++;
      return { w: c.width, h: c.height, ink, png: c.toDataURL('image/png').startsWith('data:image/png') };
    };
    return Object.fromEntries(Object.entries(C).map(([k, d]) => [k, shot(d)]));
  }, CASES);
  for (const k of ['collationRecorded', 'collationQueued', 'incidentSent', 'incidentQueued']) {
    check(`${k}: a 1080-wide PNG with something drawn on it`, out[k].w === 1080 && out[k].png && out[k].ink > 20, JSON.stringify(out[k]));
  }
  check('the incident card is shorter than a result card — no figures box', out.incidentSent.h < out.resultRecorded.h - 100, `${out.incidentSent.h} vs ${out.resultRecorded.h}`);
  check('a recorded and a queued collation draw differently', out.collationRecorded.ink !== out.collationQueued.ink);
  check('sent and queued incidents draw differently', out.incidentSent.ink !== out.incidentQueued.ink);
  check('CONTROL the same card drawn twice is identical (so "differently" means something)',
    await p.evaluate((d) => { const R = window.HAWKEYE_RECEIPT; return R.render(d, null).toDataURL() === R.render(d, null).toDataURL(); }, CASES.incidentSent));

  // show(): reveal, save with the photos under the switch, say which.
  const shown = await p.evaluate(async (d) => {
    const saves = [];
    window.HAWKEYE_SAVE_MEDIA = (items, tag) => saves.push({ n: items.length, tag, type: items[0] && items[0].blob && items[0].blob.type });
    const els = { wrap: document.getElementById('w'), img: document.getElementById('i'), note: document.getElementById('n'), tag: 'incident-receipt' };
    localStorage.removeItem('hawkeye_save_media');
    const on = await window.HAWKEYE_RECEIPT.show(d, els);
    const rOn = { blob: !!on, hidden: els.wrap.hidden, src: els.img.src.slice(0, 5), alt: els.img.alt, note: els.note.textContent, saves: saves.slice() };
    localStorage.setItem('hawkeye_save_media', '0');
    els.wrap.hidden = true; saves.length = 0;
    await window.HAWKEYE_RECEIPT.show(d, els);
    const rOff = { hidden: els.wrap.hidden, note: els.note.textContent, saves: saves.slice() };
    localStorage.removeItem('hawkeye_save_media');
    return { rOn, rOff };
  }, CASES.incidentSent);
  check('show() reveals the card as an image', shown.rOn.blob && shown.rOn.hidden === false && shown.rOn.src === 'blob:' && shown.rOn.alt === 'Your copy of this report', JSON.stringify(shown.rOn));
  check('…saves it with the photos, tagged, as a PNG', shown.rOn.saves.length === 1 && shown.rOn.saves[0].tag === 'incident-receipt' && shown.rOn.saves[0].type === 'image/png', JSON.stringify(shown.rOn.saves));
  check('…and says so', /Saved to your phone/.test(shown.rOn.note));
  check('copies switched off: nothing written, card still shown, and it says why',
    shown.rOff.saves.length === 0 && shown.rOff.hidden === false && /turned off/.test(shown.rOff.note), JSON.stringify(shown.rOff));
  await p.close();
}

/* ------------------------------------------------------------- 3. the page */
console.log('\n=== 3. incidents.html files a report and hands over the card ===');
{
  const TOKEN = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64').replace(/=+$/, '')}.y`;
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript((tok) => {
    localStorage.setItem('hawkeye_token', tok);
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_o, e) => e && e({ code: 1 }), watchPosition: () => 0, clearWatch: () => {} } });
  }, TOKEN);
  await p.goto(`${base}/incidents.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#form-card:not([hidden])');
  await p.waitForFunction(() => document.getElementById('kind').options.length > 1 && !!window.HAWKEYE_RECEIPT);
  // Record what the page hands the card.
  await p.evaluate(() => {
    const R = window.HAWKEYE_RECEIPT; const orig = R.show; window.__cards = [];
    R.show = (d, e, t) => { window.__cards.push(JSON.parse(JSON.stringify(d))); return orig(d, e, t); };
  });
  const DESC = 'SECRET-DESCRIPTION-agents-at-gate';
  await p.selectOption('#kind', 'vote_buying');
  await p.fill('#desc', DESC);
  await p.click('#btn-submit');
  await p.waitForSelector('#done-modal:not([hidden])', { timeout: 8000 });
  await p.waitForSelector('#receipt-wrap:not([hidden])', { timeout: 8000 });
  const sent = await p.evaluate(() => ({
    title: document.getElementById('done-title').textContent,
    src: document.getElementById('receipt-img').src.slice(0, 5),
    alt: document.getElementById('receipt-img').alt,
    card: window.__cards[window.__cards.length - 1],
    buttonsVisible: (() => { const r = document.getElementById('btn-exit').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })(),
  }));
  check('sent: the done modal says Sent for Review', /Sent for Review/.test(sent.title), sent.title);
  check('…and shows the card as an image', sent.src === 'blob:' && sent.alt === 'Your copy of this report', JSON.stringify(sent));
  check('…drawn as an incident, from the TYPE and the server reference only',
    sent.card && sent.card.kind === 'incident' && sent.card.incident === 'Vote-buying' && sent.card.reference === 41
    && JSON.stringify(Object.keys(sent.card).sort()) === JSON.stringify(['at', 'incident', 'kind', 'reference']), JSON.stringify(sent.card));
  check('…the description never reaches it', !JSON.stringify(sent.card).includes(DESC));
  check('the modal\'s buttons stay on screen with the card in it (390×844)', sent.buttonsVisible);
  check('CONTROL the report itself did carry the description to the server', posted.some((raw) => raw.includes(DESC)));

  await p.click('#btn-another');
  await p.waitForSelector('#done-modal', { state: 'hidden' });
  dropNext = true;
  await p.selectOption('#kind', 'intimidation');
  await p.fill('#desc', 'second');
  await p.click('#btn-submit');
  await p.waitForSelector('#done-modal:not([hidden])', { timeout: 15000 });
  await p.waitForFunction(() => window.__cards.length >= 2, null, { timeout: 8000 });
  dropNext = false;
  const queued = await p.evaluate(() => ({
    title: document.getElementById('done-title').textContent,
    titleKey: document.getElementById('done-title').getAttribute('data-i18n'),
    wrapHidden: document.getElementById('receipt-wrap').hidden,
    card: window.__cards[window.__cards.length - 1],
  }));
  check('offline: the same modal, titled "Saved on your phone" (and its key, so a language change keeps it)',
    queued.title === 'Saved on your phone' && queued.titleKey === 'receipt.title-pending', JSON.stringify(queued));
  check('…with the card in its waiting state (no reference)', queued.card && queued.card.kind === 'incident' && queued.card.reference === null && !queued.wrapHidden, JSON.stringify(queued.card));
  await p.close();

  const col = fs.readFileSync(`${APP}/collation.html`, 'utf8');
  check('collation.html loads receipt.js', /<script src="receipt\.js\?v=\d+" defer><\/script>/.test(col));
  check('collation.html draws a COLLATION card at both hand-offs (queued and 201)',
    /kind: 'collation'/.test(col) && /showCopy\(''\);/.test(col) && /showCopy\(b\.entryHash\);/.test(col));
  check('CONTROL the hand-off check fails on the page without them', !/showCopy\(b\.entryHash\);/.test(col.replace(/showCopy\(b\.entryHash\);/g, '')));
  const pins = [...fs.readFileSync(`${APP}/sw.js`, 'utf8').matchAll(/'\/receipt\.js\?v=(\d+)'/g)].map((m) => m[1]);
  const pages = ['observe.html', 'practice.html', 'collation.html', 'incidents.html'].map((f) => (fs.readFileSync(`${APP}/${f}`, 'utf8').match(/receipt\.js\?v=(\d+)/) || [])[1]);
  check('every page and the service worker load the same receipt.js version', pins.length === 1 && pages.every((v) => v === pins[0]), JSON.stringify({ pins, pages }));
}

/* ------------------------------------------------------- 4. native render */
console.log('\n=== 4. native render ===');
{
  const React = nreq('react');
  const { renderToStaticMarkup } = nreq('react-dom/server');
  const host = (tag) => (props) => React.createElement(tag, Object.fromEntries(Object.entries(props).filter(([k]) => k !== 'ref')), props.children);
  const svg = { __esModule: true, default: React.forwardRef((props, _ref) => React.createElement('svg', { viewBox: props.viewBox }, props.children)) };
  for (const n of ['Defs', 'G', 'Image', 'LinearGradient', 'Rect', 'Stop', 'Text']) svg[n] = host(`svg-${n.toLowerCase()}`);
  const cache = {};
  const load = (file, fakes) => {
    if (cache[file]) return cache[file];
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const m = { exports: {} };
    const req = (id) => {
      if (id in fakes) return fakes[id];
      if (id === 'react' || id.startsWith('react/') || id === 'react-dom') return nreq(id);
      throw new Error(`unexpected import ${id} in ${path.basename(file)}`);
    };
    new Function('require', 'module', 'exports', code)(req, m, m.exports);
    cache[file] = m.exports;
    return m.exports;
  };
  const i18n = { t: (k) => k };   // returns the key: the card must fall back to English
  const receipt = load(`${N}/src/lib/receipt.ts`, {});
  const card = load(`${N}/src/components/receipt-card.tsx`, {
    'react-native-svg': svg, '@/lib/i18n': i18n, '@/lib/receipt-crest': { RECEIPT_CREST: 'data:image/png;base64,AA' }, '@/lib/receipt': receipt,
  });
  const texts = (el) => [...renderToStaticMarkup(el).matchAll(/<svg-text[^>]*>([^<]*)<\/svg-text>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'"));
  const markup = (d) => renderToStaticMarkup(React.createElement(card.ReceiptCard, { data: d }));
  const tx = Object.fromEntries(Object.entries(CASES).map(([k, d]) => [k, texts(React.createElement(card.ReceiptCard, { data: d }))]));
  check('collation card: COLLATION top right, the area, the form, the collation-chain entry',
    tx.collationRecorded.includes('COLLATION') && tx.collationRecorded.includes('Udu III') && tx.collationRecorded.includes('EC8B') && tx.collationRecorded.includes('COLLATION LEDGER ENTRY'), JSON.stringify(tx.collationRecorded));
  check('…the totals and their sum', tx.collationRecorded.includes('PDP') && tx.collationRecorded.includes('2180'));
  check('…and no "Verify at" line', !tx.collationRecorded.some((t) => /Verify at/.test(t)));
  check('CONTROL a unit result card does draw "Verify at"', tx.resultRecorded.some((t) => /Verify at/.test(t)) && !tx.resultRecorded.includes('COLLATION') && !tx.resultRecorded.includes('INCIDENT'));
  check('incident card: INCIDENT, the type, "your copy of this report", sent for review',
    tx.incidentSent.includes('INCIDENT') && tx.incidentSent.includes('Vote-buying') && tx.incidentSent.includes('YOUR COPY OF THIS REPORT')
    && tx.incidentSent.some((t) => /Sent for review/.test(t)), JSON.stringify(tx.incidentSent));
  const incM = markup(CASES.incidentSent);
  check('…no figures box, no total, no ledger line', !incM.includes('rgba(255,255,255,0.05)') && !tx.incidentSent.includes('Total on this sheet') && !tx.incidentSent.some((t) => /LEDGER/.test(t)));
  check('CONTROL the result card does draw its figures box', markup(CASES.resultRecorded).includes('rgba(255,255,255,0.05)'));
  check('…and nothing of the report beyond its type reaches the drawing', !/SECRET|99-99-99|6\.123456|777/.test(incM));
  check('queued incident: saved on your phone, not sent yet', tx.incidentQueued.includes('SAVED ON YOUR PHONE') && tx.incidentQueued.some((t) => /Not sent yet/.test(t)));
  check('the card falls back to English, never prints a key', !Object.values(tx).flat().some((t) => /^receipt\./.test(t)));

  // The shared block, as the result, collation and incident screens use it.
  const copy = load(`${N}/src/components/receipt-copy.tsx`, {
    'react-native': { Text: host('rn-text'), View: host('rn-view') },
    '@/components/receipt-card': card, '@/lib/i18n': i18n, '@/lib/receipt-file': { saveReceiptPng: async () => true },
  });
  const blockM = renderToStaticMarkup(React.createElement(copy.ReceiptCopy, { data: CASES.collationRecorded }));
  check('ReceiptCopy renders the "Your Copy" heading and the card', blockM.includes('observe.your-copy') && blockM.includes('COLLATION LEDGER ENTRY'));
  const src = (f) => fs.readFileSync(`${N}/src/${f}`, 'utf8');
  check('result.tsx uses the shared block', /<ReceiptCopy\b/.test(src('app/report/result.tsx')) && !/<ReceiptCard\b/.test(src('app/report/result.tsx')));
  check('collation.tsx hands over a collation card', /<ReceiptCopy[\s\S]{0,200}kind: 'collation'/.test(src('app/report/collation.tsx')));
  const inc = src('app/report/incident.tsx');
  const block = (inc.match(/<ReceiptCopy[\s\S]*?\/>/) || [''])[0];
  check('incident.tsx hands over an incident card', /kind: 'incident'/.test(block));
  check('…built from the type, the reference and the time ONLY', /incident:/.test(block) && /reference:/.test(block) && /at:/.test(block)
    && !/description|media|unit|lat|lng|pu_code|puCode/.test(block), block);
  check('CONTROL that check would see a description passed in', /description/.test(block.replace('kind:', 'description: x, kind:')));
}

check('no page errors', errs.length === 0, JSON.stringify(errs));
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
