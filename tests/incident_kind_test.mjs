/**
 * AN INCIDENT'S TYPE MUST BE CHOSEN, NOT INHERITED FROM THE MARKUP.
 *
 * app/incidents.html filled an empty <select id="kind"> from
 * /api/incidents/kinds. Option 0 of a <select> is selected whether or not
 * anyone chose it, and option 0 of that list is 'violence' — so every report
 * filed by someone who never opened the dropdown was classified as violence by
 * the page. A dropdown that already reads "Violence" is not a question the
 * reader notices being asked, and the only thing standing behind it was the
 * server's `invalid_kind`, which cannot fire for a value the page always sends.
 *
 * The native screen already got this right: `useState<string | null>(null)` and
 * `reportReady = !!kind && …` (native/src/app/report/incident.tsx). This file
 * asserts the web/Lite page now agrees.
 *
 * IT RENDERS THE PAGE. Reading the source would let a placeholder that exists
 * in the HTML but is overwritten by the kinds fetch pass — which is precisely
 * the bug's shape, since the fetch is what did the overwriting.
 *
 * CONTROLS. Two of the assertions below are re-run against a page deliberately
 * put back into the old state: once with the submit guard deleted from the
 * source, once with the placeholder option removed from the live DOM. Both
 * MUST report "control fired". A control that quietly passes means the check
 * above it cannot fail and is not a check.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** Every POST /api/incidents the page actually made, in order. */
const posted = [];

/**
 * The source mutations the controls load. Each one puts incidents.html back
 * into the pre-fix state in exactly one respect, and each ASSERTS IT APPLIED —
 * a regex that silently matched nothing would hand the control a fixed page and
 * make it pass for the wrong reason.
 */
const MUTATIONS = {
  // Delete the client-side kind gate, leaving only the server's invalid_kind.
  noguard: (html) => {
    const re = /\n[^\n]*if \(!kind\) \{ \$\('status'\)\.textContent = KIND_REQUIRED;[^\n]*\n/;
    if (!re.test(html)) throw new Error('control mutation "noguard" matched nothing — the anchor moved');
    return html.replace(re, '\n');
  },
};

const server = http.createServer((req, res) => {
  const [u, q] = req.url.split('?');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (u === '/api/incidents' && req.method === 'POST') {
    let raw = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      // Crude multipart field read — enough to see WHICH kind was sent.
      const m = /name="kind"\r?\n\r?\n([^\r\n]*)/.exec(raw);
      posted.push({ kind: m ? m[1] : null });
      json(201, { ok: true, id: posted.length });
    });
    return;
  }
  if (u === '/api/incidents/kinds') {
    // Real order, so 'violence' is still the first real option — the control
    // has to be able to reproduce the original bug.
    return json(200, ['violence', 'ballot_snatching', 'vote_buying', 'intimidation',
      'bvas_failure', 'late_materials', 'obstruction', 'other']);
  }
  if (u === '/api/incidents') return json(200, { incidents: [] });
  if (u === '/api/observers/my-unit') return json(200, { unit: null });
  if (u.startsWith('/api/')) return json(200, {});

  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  const mut = new URLSearchParams(q || '').get('mutate');
  if (mut && path.extname(f) === '.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(MUTATIONS[mut](fs.readFileSync(f, 'utf8')));
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};
/** The inverse: this MUST NOT hold, or the check that shares its logic is inert. */
const control = (label, got, want) => {
  const held = typeof want === 'function' ? want(got) : got === want;
  if (held) fail++;
  console.log(`${held ? 'FAIL' : 'PASS'}  CONTROL ${label}${held ? `\n        the assertion still held — it cannot fail\n        got  ${JSON.stringify(got)}` : ` (fired: ${JSON.stringify(got)})`}`);
};

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});

/** authgate.js reads a JWT `exp`, so a plausible-looking token is required to
 *  reach the form at all. */
const TOKEN = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }))
  .toString('base64').replace(/=+$/, '')}.y`;

const errors = [];
async function open(query = '') {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript((tok) => {
    localStorage.setItem('hawkeye_token', tok);
    // Fail the fix immediately and deterministically: headless Chromium has no
    // location provider, and a real 10s timeout would only make the test slow.
    // This also exercises the {coords, err} shape getPos() now returns.
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_ok, err) => err && err({ code: 1, message: 'denied (test)' }),
        watchPosition: () => 0,
        clearWatch: () => {},
      },
    });
  }, TOKEN);
  await p.goto(`${base}/incidents.html${query}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#form-card:not([hidden])');
  // The kinds fetch is what used to clobber the placeholder, so nothing is
  // asserted until it has landed.
  await p.waitForFunction(() => document.getElementById('kind').options.length > 1);
  return p;
}

/** Everything the assertions read, taken from the rendered page in one hop. */
const readKind = (p) => p.evaluate(() => {
  const s = document.getElementById('kind');
  const first = s.options[0];
  return {
    value: s.value,
    selectedLabel: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null,
    firstLabel: first ? first.text : null,
    firstValue: first ? first.value : null,
    optionCount: s.options.length,
  };
});

// ---------------------------------------------------------------- the page --
const p = await open();
const initial = await readKind(p);

check('nothing is pre-selected — #kind starts empty', initial.value, '');
check('the selected option IS the first option (the placeholder)',
  initial.selectedLabel === initial.firstLabel, true);
check('the placeholder carries an empty value', initial.firstValue, '');
check('the placeholder instructs rather than names a kind',
  initial.firstLabel, (t) => /^(choose|select|pick)\b/i.test(t || '') && /incident/i.test(t || ''));
check('the real kinds are still there', initial.optionCount, (n) => n === 9);
console.log(`        placeholder reads: ${JSON.stringify(initial.firstLabel)}`);

// -- blocked while no kind is chosen -----------------------------------------
// A description is typed FIRST so the only unmet condition is the kind —
// otherwise the empty_report gate would be the one refusing, and this check
// would pass without the new guard existing at all.
await p.fill('#desc', 'Agents were turning voters away at the gate.');
await p.click('#btn-submit');
await p.waitForTimeout(400);

check('no request is made while the kind is unanswered', posted.length, 0);
const blocked = await p.evaluate(() => ({
  status: document.getElementById('status').textContent.trim(),
  invalid: document.getElementById('kind').getAttribute('aria-invalid'),
  modalHidden: document.getElementById('done-modal').hidden,
}));
check('the refusal is visible and names the missing choice',
  blocked.status, (t) => t.length > 0 && /incident type/i.test(t));
check('the select is marked invalid for assistive tech', blocked.invalid, 'true');
check('no receipt is shown', blocked.modalHidden, true);
console.log(`        refusal reads: ${JSON.stringify(blocked.status)}`);

// -- submittable once a kind is chosen ---------------------------------------
await p.selectOption('#kind', 'vote_buying');
check('choosing a kind clears the invalid mark',
  await p.getAttribute('#kind', 'aria-invalid'), null);
await p.click('#btn-submit');
await p.waitForSelector('#done-modal:not([hidden])', { timeout: 5000 });
check('the report is sent once a kind is chosen', posted.length, 1);
check('and it carries the kind that was chosen', posted[0] && posted[0].kind, 'vote_buying');

// -- the reset goes back to the placeholder, not to a real kind --------------
await p.click('#btn-another');
await p.waitForSelector('#done-modal', { state: 'hidden' });
const afterReset = await readKind(p);
check('"Report another" returns to the placeholder, not to violence',
  afterReset.value, '');
check('and the box visibly reads the instruction again',
  afterReset.selectedLabel, initial.firstLabel);

// A second report must be refused for the same reason as the first — the reset
// must not have left a stale "already answered" state behind.
await p.fill('#desc', 'Ballot box carried away from the unit.');
await p.click('#btn-submit');
await p.waitForTimeout(400);
check('the second report is gated exactly like the first', posted.length, 1);

check('no uncaught JavaScript on any of it', errors, (e) => e.length === 0);

// -- item (2) smoke: the location-failure line is one short sentence ---------
// Ticking "Attach Polling Unit" auto-fires the near-me lookup, and the stubbed
// geolocation above refuses it. This is the line the reader called too long.
await p.check('#attach-pu');
await p.waitForFunction(() => document.getElementById('pu-status').textContent.trim().length > 0);
const geo = (await p.textContent('#pu-status')).trim();
check('the location failure is one short sentence',
  geo, (t) => t.length > 0 && t.length <= 90 && (t.match(/[.!?]\s+\S/g) || []).length === 0);
check('and the old three-clause copy is gone',
  geo, (t) => !/allow location access and try again/i.test(t));
console.log(`        location line reads: ${JSON.stringify(geo)}`);
await p.close();

// ------------------------------------------------------------------ control --
// Same page, same steps, one line of source removed: the client-side kind gate.
// With it gone the empty kind reaches the network, so `posted.length === 0`
// must FAIL. If it still holds, the check above is measuring something else.
posted.length = 0;
const c = await open('?mutate=noguard');
await c.fill('#desc', 'Agents were turning voters away at the gate.');
await c.click('#btn-submit');
await c.waitForTimeout(600);
control('the blocked-submit check can fail (guard removed → request goes out)',
  posted.length, 0);
console.log(`        control sent kind: ${JSON.stringify(posted[0] ? posted[0].kind : null)}`);

// Same idea for the placeholder, done in the live DOM: strip the empty option
// the way the old innerHTML write did, and "#kind starts empty" must fail.
const before = await readKind(c);
await c.evaluate(() => {
  const s = document.getElementById('kind');
  for (const o of [...s.options]) if (o.value === '') o.remove();
  s.selectedIndex = 0;
});
const after = await readKind(c);
control('the empty-value check can fail (placeholder removed → violence selected)',
  after.value, '');
console.log(`        control had ${before.optionCount} options, now selects ${JSON.stringify(after.selectedLabel)}`);
await c.close();

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL PASS');
process.exit(fail ? 1 : 0);
