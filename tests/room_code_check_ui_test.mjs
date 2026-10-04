/**
 * THE CODE CHECKER IN THE SITUATION ROOM, read off the rendered page.
 *
 * The server's rules are backend/tests/org_code_check_test.mjs. This asks what
 * the party's coordinator actually gets, against a stub server:
 *
 *   1. with org_code_check the Codes tab lists the room's own batches FIRST and
 *      keeps this checker under "Check other codes"; without it a manager gets
 *      the tab MUTED, saying why, and a plain member gets no tab at all;
 *   2. pasted text with codes in any case and spacing, duplicates and a
 *      look-alike: only distinct VALID codes are sent, squashed; the look-alike
 *      is shown "not valid" and never sent;
 *   3. a messy CSV (byte-order mark, ';' separator, quoted cells holding the
 *      separator, a doubled quote and a line break, a row with no code, a code
 *      in lower case with spaces, a hostile cell and a hostile file name):
 *      the right codes go, the counts are right, nothing hostile runs, and both
 *      downloads keep the party's own rows, separator and quoting;
 *   4. 429 and 403 read as sentences; 5,001 codes go as 5,000 + 1;
 *   5. the tab in Hausa — no English left on it — with an English CONTROL.
 *
 *   node tests/room_code_check_ui_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const GROUP = {
  id: 7, name: 'ADC Lagos', kind: 'campaign', contest: 'PRES', scope: '', party: 'ADC', slug: 'adc-lagos',
  scope_kind: '', members: 3, assigned: 0, pending: 0, reported: 0, zones: [], me_id: 1, admits: true,
  me: { role: 'owner', scope_kind: '', scope_value: '' },
  managers: [{ observer_id: 1, role: 'owner', scope_kind: '', scope_value: '' }],
};
let FLAG = true;
let ROLE = null;               // null = GROUP.me (the owner); 'member' = a plain member of the roster
let MODE = 'ok';               // 'ok' | 'rate' | 'forbid'
const STATUS = {
  ORGABCDEFGHJKMN: { status: 'unused' },
  ORG23456789ABCD: { status: 'used', usedOn: '2026-09-28' },
  ORG3456789ABCDE: { status: 'unused' },
  ORG456789ABCDEF: { status: 'revoked' },
};
const calls = [];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url === '/api/groups') return json({ managing: [{ id: 7, name: GROUP.name, kind: 'campaign', contest: 'PRES', scope: '', slug: GROUP.slug }], member: [] });
    if (url === '/api/groups/7') return json({ ...GROUP, org_code_check: FLAG, ...(ROLE ? { me: { role: ROLE, scope_kind: '', scope_value: '' } } : {}) });
    // The room's own batches (Hawkeye-generated): listed FIRST on the Codes tab.
    if (url === '/api/groups/7/org-codes/batches') {
      return json({ version: 'v1', batches: [{ id: 3, label: 'Lagos agents', createdAt: Date.parse('2026-09-30T09:00:00Z'), size: 2, unused: 1, used: 1, withdrawn: 0,
        codes: [{ code: 'ORG-ABCD-EFGH-JKMN', status: 'unused' }, { code: 'ORG-2345-6789-ABCD', status: 'used', usedOn: '2026-09-28' }] }] });
    }
    if (url === '/api/groups/7/org-codes/check') {
      const body = JSON.parse(data || '{}');
      calls.push(body.codes);
      if (MODE === 'rate') return json({ error: 'too_many_requests', retryAfterMin: 12 }, 429);
      if (MODE === 'forbid') return json({ error: 'not_code_checker' }, 403);
      return json({
        ok: true,
        results: body.codes.map((c) => {
          const f = 'ORG-' + c.slice(3, 7) + '-' + c.slice(7, 11) + '-' + c.slice(11);
          return { code: f, ...(STATUS[c] || { status: 'not_yours' }) };
        }),
      });
    }
    if (url.startsWith('/api/')) return json({});
    const f = path.join(APP, decodeURIComponent(url));
    if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];
async function open(lang = 'en', tab = 'codes') {
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 1400 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e) + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ').trim()));
  p.on('dialog', (d) => d.dismiss());
  await p.addInitScript((l) => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_lang', l);
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
  }, lang);
  await p.goto(`${base}/situation-room.html?tab=${tab}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.sr-tabs', { timeout: 10000 }).catch(() => {});
  return { ctx, p };
}
const text = (p, sel) => p.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
// The CHECKER's own counts: the batches above it carry heads of their own.
const heads = (p) => p.evaluate(() => [...document.querySelectorAll('#cc-checker .sr-head')].map((h) => h.querySelector('span').textContent + '=' + h.querySelector('b').textContent));
async function download(p, sel) {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click(sel)]);
  return dl ? { name: dl.suggestedFilename(), body: fs.readFileSync(await dl.path(), 'utf8') } : null;
}

try {
  /* A MANAGER ALWAYS GETS THE TAB (2026-10-04): with org_code_check it lists
     the room's own batches first and keeps the paste/upload checker under
     "Check other codes"; without it the tab is there, muted, saying why —
     no checker that would only be refused. A plain member gets no tab. */
  console.log('=== 1. the tab: muted with the reason when the server says no; batches first when it says yes ===');
  FLAG = false;
  let { ctx, p } = await open('en', 'codes');
  check('no org_code_check, the owner: a MUTED Codes tab that opens on why, and no checker',
    await p.evaluate(() => [!!document.querySelector('[data-tab="codes"][data-muted]'), (document.querySelector('.sr-tabs [aria-selected="true"]') || {}).dataset?.tab || null,
      (document.getElementById('cc-why-not') || {}).textContent || '', !!document.getElementById('cc-text')]),
    (v) => v[0] === true && v[1] === 'codes' && /Organisation codes are not set up for ADC yet\./.test(v[2]) && v[3] === false);
  await ctx.close();
  ROLE = 'member';
  ({ ctx, p } = await open('en', 'codes'));
  check('CONTROL a plain member: no Codes tab at all, and ?tab=codes lands on Overview',
    await p.evaluate(() => [!!document.querySelector('[data-tab="codes"]'), (document.querySelector('.sr-tabs [aria-selected="true"]') || {}).dataset?.tab || null]),
    [false, 'overview']);
  await ctx.close();
  ROLE = null;
  FLAG = true;
  ({ ctx, p } = await open('en', 'codes'));
  await p.waitForSelector('[data-batch="3"]', { timeout: 8000 }).catch(() => {});
  check('with it: the Codes tab opens on the room\'s own batches FIRST, the checker below under "Check other codes" (closed)',
    await p.evaluate(() => {
      const bt = document.getElementById('cc-batches');
      const other = document.getElementById('cc-other');
      return [!!document.querySelector('[data-tab="codes"][aria-selected="true"]'), !document.querySelector('[data-tab="codes"]').hasAttribute('data-muted'),
        !!bt && !!other && !!(bt.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING),
        (document.querySelector('[data-batch="3"] summary b') || {}).textContent || '', other && other.querySelector('summary').textContent.trim(), other && other.open,
        !!document.querySelector('#cc-other #cc-text')];
    }), [true, true, true, 'Lagos agents', 'Check other codes', false, true]);
  // The checker is one tap away.
  await p.click('#cc-other summary');

  console.log('\n=== 2. pasted, messy ===');
  await p.fill('#cc-text', 'org-abcd efgh jkmn\nand again: ORG ABCD-EFGH-JKMN\nfoo ORG-2345-6789-ABCD, ORG-OOOO-1111-IIII\nORGANISATION CODES');
  await p.click('#cc-check');
  await p.waitForSelector('#cc-table', { timeout: 8000 }).catch(() => {});
  check('only the distinct VALID codes are sent, squashed, in first-seen order', calls[0], ['ORGABCDEFGHJKMN', 'ORG23456789ABCD']);
  check('counted per distinct code; the look-alike shown as not valid, never sent', await heads(p),
    ['Unused=1', 'Used=1', 'Withdrawn=0', 'Not one of yours=0', 'Not a valid code=1']);
  check('each row says what came back, a used code with its day', await p.evaluate(() => [...document.querySelectorAll('#cc-table tbody tr')].map((tr) => tr.cells[2].textContent.trim())),
    (rows) => rows.length === 4 && rows[0] === '●Unused' && rows[1] === '●Unused' && /^●Used .*\b28\b.*2026$/.test(rows[2]) && rows[3] === '●Not a valid code');

  console.log('\n=== 3. an uploaded CSV, messier ===');
  const csv = '﻿Name;Phone;Code;Note\r\n'
    + '"Okafor; Ada";0803 000 0001;ORG-2345-6789-ABCD;"said ""yes""\r\nsecond line"\r\n'
    + 'Bello;0803 000 0002; org 3456 789a bcde ;\r\n'
    + '<img src=x onerror="window.__xss=1">;0803;ORG-4567-89AB-CDEF;\r\n'
    + 'Nobody;0803 000 0004;;no code here\r\n'
    + 'Musa;0803;ORG-5678-9ABC-DEFG;\r\n'
    + '\r\n';
  calls.length = 0;
  await p.setInputFiles('#cc-file', { name: 'agents <b>x</b>.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await p.waitForFunction(() => /agents/.test((document.getElementById('sr-body') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('the four codes in the file are sent — header and code-less row skipped', calls[0], ['ORG23456789ABCD', 'ORG3456789ABCDE', 'ORG456789ABCDEF', 'ORG56789ABCDEFG']);
  check('counts', await heads(p), ['Unused=1', 'Used=1', 'Withdrawn=1', 'Not one of yours=1']);
  check('five data rows, the empty line dropped, the code-less row kept', await p.evaluate(() => [...document.querySelectorAll('#cc-table tbody tr')].map((tr) => tr.cells[2].textContent.replace('●', '').trim().replace(/^Used .*$/, 'Used'))),
    ['Used', 'Unused', 'Withdrawn', 'No code in this row', 'Not one of yours']);
  check('the hostile file name is printed, not parsed; the hostile cell never ran',
    await p.evaluate(() => [/Results for agents <b>x<\/b>\.csv/.test(document.getElementById('sr-body').textContent), !!document.querySelector('#sr-body p b'), window.__xss || null]),
    [true, false, null]);
  const all = await download(p, '#cc-dl-all');
  check('results download: named for the room', all && all.name, 'hawkeye-code-check-adc-lagos.csv');
  check('…BOM, the file\'s own ";" separator, its header plus Status, its quoting kept', all && all.body,
    (s) => s.startsWith('﻿Name;Phone;Code;Note;Status\r\n')
      && s.includes('"Okafor; Ada";0803 000 0001;ORG-2345-6789-ABCD;"said ""yes""\r\nsecond line";Used 2026-09-28\r\n')
      && s.includes('Bello;0803 000 0002; org 3456 789a bcde ;;Unused\r\n')
      && s.includes('"<img src=x onerror=""window.__xss=1"">";0803;ORG-4567-89AB-CDEF;;Withdrawn\r\n')
      && s.includes('Nobody;0803 000 0004;;no code here;No code in this row\r\n')
      && s.includes('Musa;0803;ORG-5678-9ABC-DEFG;;Not one of yours\r\n'));
  const unused = await download(p, '#cc-dl-unused');
  check('unused-only download: the header and the one unused row, nothing else', unused && [unused.name, unused.body],
    ['hawkeye-unused-codes-adc-lagos.csv', '﻿Name;Phone;Code;Note\r\nBello;0803 000 0002; org 3456 789a bcde ;\r\n']);

  console.log('\n=== 4. refusals, and a big paste ===');
  MODE = 'rate';
  await p.fill('#cc-text', 'ORG-ABCD-EFGH-JKMN');
  await p.click('#cc-check');
  await p.waitForSelector('#cc-msg', { timeout: 8000 }).catch(() => {});
  check('429 reads as a sentence with the wait', await text(p, '#cc-msg'), 'Too many checks in the last hour. Try again in 12 minutes.');
  check('…and the code is marked not checked, not guessed', await p.evaluate(() => document.querySelector('#cc-table tbody tr').cells[2].textContent.trim()), '●Not checked');
  MODE = 'forbid';
  await p.click('#cc-check');
  await p.waitForFunction(() => /owner/.test((document.getElementById('cc-msg') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('403 says who may', await text(p, '#cc-msg'), 'Only this room’s owner, or a coordinator named for your party, can check codes.');
  MODE = 'ok';
  const A = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const code = (i) => { let s = ''; let k = i; for (let j = 0; j < 12; j++) { s += A[k % 30]; k = Math.floor(k / 30); } return 'ORG-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8); };
  calls.length = 0;
  /* Set, not typed: Playwright's fill() inserts ~95 kB as one editing command,
     which headless Chromium takes longer than the timeout over. A paste is one
     input event either way, and that is what the page listens for. */
  await p.$eval('#cc-text', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); },
    Array.from({ length: 5001 }, (_, i) => code(i + 99)).join('\n'));
  await p.click('#cc-check');
  await p.waitForFunction(() => /5,001/.test((document.getElementById('sr-body') || {}).textContent || '') && !document.getElementById('cc-status'), null, { timeout: 15000 }).catch(() => {});
  check('5,001 codes go as two calls, 5,000 and 1', calls.map((c) => c.length), [5000, 1]);
  check('the table draws 500 rows and says the download has the rest',
    [await p.evaluate(() => document.querySelectorAll('#cc-table tbody tr').length), /Showing the first 500 of 5,001 rows\. The download has them all\./.test(await text(p, '#sr-body'))], [500, true]);
  await ctx.close();

  console.log('\n=== 5. in Hausa ===');
  ({ ctx, p } = await open('ha', 'codes'));
  await p.waitForFunction(() => /Lambobi/.test((document.querySelector('[data-tab="codes"]') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  await p.waitForSelector('#cc-other summary', { timeout: 8000 }).catch(() => {});
  await p.click('#cc-other summary');
  await p.fill('#cc-text', 'ORG-ABCD-EFGH-JKMN ORG-OOOO-1111-IIII');
  await p.click('#cc-check');
  await p.waitForSelector('#cc-table', { timeout: 8000 }).catch(() => {});
  const ha = await text(p, '#sr-body');
  // The tab as it is now: the batches' title, the checker under "Check other codes".
  const EN = ['Your organisation codes', 'Check other codes', 'Type or paste', 'Upload CSV', 'Download codes CSV', 'Download unused', 'Unused', 'Withdrawn', 'Not one of yours', 'Not a valid code', 'Results for', 'Status'];
  check('the tab and everything on it in Hausa: no English left', [await text(p, '[data-tab="codes"]'), EN.filter((w) => ha.includes(w))], ['Lambobi', []]);
  await ctx.close();
  ({ ctx, p } = await open('en', 'codes'));
  await p.waitForSelector('#cc-other summary', { timeout: 8000 }).catch(() => {});
  await p.click('#cc-other summary');
  await p.fill('#cc-text', 'ORG-ABCD-EFGH-JKMN ORG-OOOO-1111-IIII');
  await p.click('#cc-check');
  await p.waitForSelector('#cc-table', { timeout: 8000 }).catch(() => {});
  const en = await text(p, '#sr-body');
  check('CONTROL: the same check in English finds every one of those words', EN.filter((w) => !en.includes(w)), []);
  await ctx.close();

  check('no page errors anywhere', errs, []);
} finally {
  await b.close();
  server.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
