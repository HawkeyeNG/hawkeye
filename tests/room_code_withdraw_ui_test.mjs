/**
 * WITHDRAW SELECTED CODES, UNDO and RESTORE in the situation room's Codes tab,
 * read off the rendered page against a stub server — and the tab in a CSO room.
 *
 * The server's rules are backend/tests/org_code_withdraw_test.mjs. This asks
 * what the room's owner actually gets:
 *
 *   1. a tick beside UNUSED codes only, "Restore" only on a code a room
 *      withdrew, "Select all unused (n)", and a Withdraw button that counts;
 *   2. Withdraw asks in the BRANDED dialog (never the browser's), naming how
 *      many and that a withdrawn code can no longer sign anyone up; Cancel
 *      sends nothing; OK sends only the ticked codes, squashed;
 *   3. the row turns Withdrawn with a Restore button, and Undo puts it back;
 *   4. a code used in the meantime comes back Used and is reported, not hidden;
 *   5. a refused restore (the cap) and a refused withdraw (403) read as
 *      sentences — a CSO room's say "organisation", not "party";
 *   6. the whole flow in Hausa, with an English CONTROL.
 *
 *   node tests/room_code_withdraw_ui_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const PARTY = {
  id: 7, name: 'ADC Lagos', kind: 'campaign', contest: 'PRES', scope: '', party: 'ADC', slug: 'adc-lagos',
  scope_kind: '', members: 3, assigned: 0, pending: 0, reported: 0, zones: [], me_id: 1, admits: true,
  me: { role: 'owner', scope_kind: '', scope_value: '' },
  managers: [{ observer_id: 1, role: 'owner', scope_kind: '', scope_value: '' }],
};
const CSO = { ...PARTY, name: 'Lagos watch', kind: 'cso', party: null, org: 'Yiaga Africa', slug: 'lagos-watch' };
let GROUP = PARTY;

const U1 = 'ORGABCDEFGHJKMN';
const U2 = 'ORG3456789ABCDE';
const USED = 'ORG23456789ABCD';
const RR = 'ORG456789ABCDEF';   // withdrawn by a room: restorable
const RB = 'ORG56789ABCDEFG';   // its batch withdrawn: not restorable
const fmt = (c) => 'ORG-' + c.slice(3, 7) + '-' + c.slice(7, 11) + '-' + c.slice(11);
let RES = {};
let RACE = new Set();          // codes the stub says were used a moment ago
let MODE = 'ok';               // 'ok' | 'forbid' | 'cap'
const calls = { check: [], withdraw: [], restore: [] };
function reset() {
  RES = {
    [U1]: { status: 'unused' }, [U2]: { status: 'unused' },
    [USED]: { status: 'used', usedOn: '2026-09-28' },
    [RR]: { status: 'revoked', restorable: true }, [RB]: { status: 'revoked' },
  };
  RACE = new Set();
  MODE = 'ok';
  for (const k of Object.keys(calls)) calls[k].length = 0;
}
reset();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url === '/api/groups') return json({ managing: [{ id: 7, name: GROUP.name, kind: GROUP.kind, contest: 'PRES', scope: '', slug: GROUP.slug }], member: [] });
    if (url === '/api/groups/7') return json({ ...GROUP, org_code_check: true });
    const m = /^\/api\/groups\/7\/org-codes\/(check|withdraw|restore)$/.exec(url);
    if (m) {
      const kind = m[1];
      const body = JSON.parse(data || '{}');
      calls[kind].push(body.codes);
      if (kind !== 'check' && MODE === 'forbid') return json({ error: 'not_code_checker' }, 403);
      if (kind === 'restore' && MODE === 'cap') return json({ error: 'cap_exceeded' }, 409);
      const results = body.codes.map((c) => {
        let changed = false;
        if (kind === 'withdraw' && RES[c] && RES[c].status === 'unused') {
          if (RACE.has(c)) RES[c] = { status: 'used', usedOn: '2026-10-01' };
          else { RES[c] = { status: 'revoked', restorable: true }; changed = true; }
        }
        if (kind === 'restore' && RES[c] && RES[c].restorable) { RES[c] = { status: 'unused' }; changed = true; }
        return { code: fmt(c), ...(RES[c] || { status: 'not_yours' }), ...(changed ? { changed: true } : {}) };
      });
      return json({ ok: true, results, ...(kind === 'withdraw' ? { withdrawn: results.filter((x) => x.changed).length } : {}) });
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
const nativeDialogs = [];
async function open(lang = 'en') {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1400 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('dialog', (d) => { nativeDialogs.push(d.message()); d.dismiss(); });
  await p.addInitScript((l) => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_lang', l);
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
  }, lang);
  await p.goto(`${base}/situation-room.html?tab=codes`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#cc-text', { timeout: 10000 }).catch(() => {});
  return { ctx, p };
}
async function paste(p, codes) {
  await p.fill('#cc-text', codes.map(fmt).join('\n'));
  await p.click('#cc-check');
  await p.waitForSelector('#cc-table', { timeout: 8000 }).catch(() => {});
}
const picks = (p) => p.evaluate(() => [...document.querySelectorAll('#cc-table input.cc-pick')].map((e) => e.value));
const restores = (p) => p.evaluate(() => [...document.querySelectorAll('#cc-table [data-restore]')].map((e) => e.getAttribute('data-restore')));
const statusOf = (p, code) => p.evaluate((c) => {
  const tr = [...document.querySelectorAll('#cc-table tbody tr')].find((r) => r.cells[1].textContent.includes(c));
  return tr ? tr.cells[2].querySelector('.pill').textContent.replace('●', '').trim() : null;
}, code);
const text = (p, sel) => p.evaluate((s) => ((document.querySelector(s) || {}).textContent || '').trim(), sel);
const dialog = async (p) => {
  await p.waitForSelector('.hk-dlg', { timeout: 5000 }).catch(() => {});
  return p.evaluate(() => {
    const d = document.querySelector('.hk-dlg');
    return d ? { title: (d.querySelector('.hk-dlg-title') || {}).textContent || '', msg: (d.querySelector('.hk-dlg-msg') || {}).textContent || '',
      ok: d.querySelector('.hk-dlg-ok').textContent, danger: d.querySelector('.hk-dlg-ok').classList.contains('danger'),
      focus: document.activeElement === d.querySelector('.hk-dlg-cancel') } : null;
  });
};
const waitNote = (p, re) => p.waitForFunction((src) => new RegExp(src).test((document.getElementById('cc-note') || {}).textContent || ''), re.source, { timeout: 8000 }).catch(() => {});

try {
  console.log('=== 1. ticks, restore, select-all ===');
  let { ctx, p } = await open('en');
  await paste(p, [U1, USED, RR, RB, U2]);
  check('a tick beside the two UNUSED codes only', await picks(p), [fmt(U1), fmt(U2)]);
  check('"Restore" only on the code a room withdrew — not on a batch-withdrawn one', await restores(p), [fmt(RR)]);
  check('select-all counts the unused; Withdraw starts disabled at 0',
    [await text(p, '.sr-cc-all'), await text(p, '#cc-withdraw'), await p.$eval('#cc-withdraw', (e) => e.disabled)],
    ['Select all unused (2)', 'Withdraw selected (0)', true]);
  await p.check(`#cc-table input.cc-pick[value="${fmt(U1)}"]`);
  check('one ticked: the button counts it, select-all is partial',
    [await text(p, '#cc-withdraw'), await p.$eval('#cc-withdraw', (e) => e.disabled), await p.$eval('#cc-all', (e) => e.indeterminate)],
    ['Withdraw selected (1)', false, true]);

  console.log('\n=== 2. the branded dialog ===');
  await p.click('#cc-withdraw');
  let d = await dialog(p);
  check('our own dialog: title, how many, what it means, a danger OK, focus on Cancel', d, {
    title: 'Withdraw codes',
    msg: 'Withdraw 1 code? A withdrawn code can no longer be used to sign up. Accounts already created with your codes are not affected.',
    ok: 'Withdraw', danger: true, focus: true,
  });
  await p.click('.hk-dlg-cancel');
  await p.waitForTimeout(300);
  check('Cancel sends nothing, and the tick stays', [calls.withdraw.length, await p.$eval(`#cc-table input.cc-pick[value="${fmt(U1)}"]`, (e) => e.checked)], [0, true]);
  await p.click('#cc-withdraw');
  await dialog(p);
  await p.click('.hk-dlg-ok');
  await waitNote(p, /withdrawn/);
  check('OK sends ONLY the ticked code, squashed', calls.withdraw, [[U1]]);

  console.log('\n=== 3. withdrawn, then undone ===');
  check('the row reads Withdrawn, with Restore; its tick is gone',
    [await statusOf(p, fmt(U1)), (await restores(p)).includes(fmt(U1)), (await picks(p)).includes(fmt(U1))], ['Withdrawn', true, false]);
  check('the note says what happened, and offers Undo',
    [await p.evaluate(() => document.getElementById('cc-note').firstChild.textContent.trim()), await text(p, '#cc-undo')],
    ['1 code withdrawn. It can no longer be used to sign up.', 'Undo']);
  check('the counts moved', await p.evaluate(() => [...document.querySelectorAll('#sr-body .sr-head')].map((h) => h.querySelector('span').textContent + '=' + h.querySelector('b').textContent)),
    ['Unused=1', 'Used=1', 'Withdrawn=3', 'Not one of yours=0']);
  await p.click('#cc-undo');
  await waitNote(p, /restored/);
  check('Undo restores exactly that code', calls.restore, [[U1]]);
  check('…the row is Unused again, with its tick back',
    [await statusOf(p, fmt(U1)), (await picks(p)).includes(fmt(U1)), await text(p, '#cc-note')],
    ['Unused', true, '1 code restored. It can be used to sign up again.']);

  console.log('\n=== 4. select all, one used in the meantime ===');
  RACE.add(U2);
  calls.withdraw.length = 0;
  await p.check('#cc-all');
  check('select all ticks every unused code', [await text(p, '#cc-withdraw'), await p.evaluate(() => [...document.querySelectorAll('#cc-table input.cc-pick')].every((e) => e.checked))],
    ['Withdraw selected (2)', true]);
  await p.click('#cc-withdraw');
  d = await dialog(p);
  check('the dialog names how many', d && d.msg, 'Withdraw 2 codes? A withdrawn code can no longer be used to sign up. Accounts already created with your codes are not affected.');
  await p.click('.hk-dlg-ok');
  await waitNote(p, /withdrawn/);
  check('both sent', calls.withdraw, [[U1, U2]]);
  check('the one used meanwhile reads Used, and the note says so',
    [await statusOf(p, fmt(U2)), await p.evaluate(() => document.getElementById('cc-note').firstChild.textContent.trim())],
    (g) => /^Used /.test(g[0]) && g[1] === '1 code withdrawn. It can no longer be used to sign up. Not withdrawn: 1 — used or withdrawn in the meantime. See the status below.');
  check('nothing unused is left, so the select bar is gone', await p.evaluate(() => !!document.getElementById('cc-select')), false);

  console.log('\n=== 5. refusals read as sentences ===');
  MODE = 'cap';
  await p.click(`#cc-table [data-restore="${fmt(RR)}"]`);
  await p.waitForSelector('#cc-msg', { timeout: 8000 }).catch(() => {});
  check('a restore past the cap: a sentence, and the code stays Withdrawn',
    [await text(p, '#cc-msg'), await statusOf(p, fmt(RR))], ['These codes cannot be restored: that would take you past your code limit.', 'Withdrawn']);
  MODE = 'ok';
  await p.click(`#cc-table [data-restore="${fmt(RR)}"]`);
  await waitNote(p, /restored/);
  check('CONTROL: allowed, the row\'s Restore works', [calls.restore.at(-1), await statusOf(p, fmt(RR))], [[RR], 'Unused']);
  await ctx.close();

  reset();
  GROUP = CSO;
  ({ ctx, p } = await open('en'));
  await paste(p, [U1, USED]);
  check('a CSO room: the same tab, its privacy line says "organisation"',
    await text(p, '#sr-body'), (s) => s.includes('A code that is not your organisation’s, or does not exist') && !s.includes('your party’s'));
  MODE = 'forbid';
  await p.check(`#cc-table input.cc-pick[value="${fmt(U1)}"]`);
  await p.click('#cc-withdraw');
  await dialog(p);
  await p.click('.hk-dlg-ok');
  await p.waitForSelector('#cc-msg', { timeout: 8000 }).catch(() => {});
  check('a 403 in a CSO room names the organisation, and the code stays Unused',
    [await text(p, '#cc-msg'), await statusOf(p, fmt(U1))],
    ['Only this room’s owner, or a coordinator named for your organisation, can withdraw or restore codes.', 'Unused']);
  await ctx.close();
  GROUP = PARTY;

  console.log('\n=== 6. in Hausa ===');
  const EN = ['Select all unused', 'Withdraw selected', 'Tick unused codes', 'code withdrawn', 'Undo', 'Restore', 'Withdraw codes', 'can no longer be used'];
  const run = async (lang) => {
    reset();
    const o = await open(lang);
    await paste(o.p, [U1, RR, U2]);
    await o.p.check(`#cc-table input.cc-pick[value="${fmt(U1)}"]`);
    await o.p.click('#cc-withdraw');
    const dd = await dialog(o.p);
    await o.p.click('.hk-dlg-ok');
    await o.p.waitForSelector('#cc-undo', { timeout: 8000 }).catch(() => {});
    const all = (await text(o.p, '#sr-body')) + ' ' + (dd ? dd.title + ' ' + dd.msg + ' ' + dd.ok : '');
    await o.ctx.close();
    return { all, dd };
  };
  const ha = await run('ha');
  check('dialog, toolbar, hint, note, Undo and Restore in Hausa: no English left',
    [ha.dd && ha.dd.title, EN.filter((w) => ha.all.includes(w))], ['Janye lambobi', []]);
  const en = await run('en');
  check('CONTROL: the same flow in English finds every one of those words', EN.filter((w) => !en.all.includes(w)), []);

  check('the browser\'s own dialog never opened', nativeDialogs, []);
  check('no page errors anywhere', errs, []);
} finally {
  await b.close();
  server.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
