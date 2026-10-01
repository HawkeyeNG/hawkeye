/**
 * THE APP NEVER OPENS OUR OWN WEB PAGES FOR GROUPS, CAPTAINS OR PHOTOS.
 *
 * Owner rule: native gets native screens. The bug this pins: the app opened the
 * website's my-groups page (the Continue after joining, and every group alert)
 * in an in-app browser tab. That tab does not share the app's session, so it
 * landed on the website's SIGN-IN form — and signing in there took the phone's
 * session slot (backend services/sessions.js) and signed the APP out. The
 * captain-message alert did the same with captain.html, and the ledger, case
 * and incident screens opened evidence photos as raw files in the browser.
 *
 * Three layers, each with a control that proves it can fail:
 *   1. ROUTING — every url the backend actually writes into a group or captain
 *      alert (read from backend/src, not typed here) resolves to a native route
 *      through lib/web-routes.ts; and push.ts / +native-intent.tsx consult it.
 *   2. CALL SITES — no browser-opening call anywhere in native/src is handed a
 *      groups / captain / invite / room page or an evidence photo. The one
 *      allowed exception is a VIDEO — on a binary without expo-video, or when a
 *      clip will not play in components/video-viewer.tsx — and it must sit
 *      behind a `type === 'video'` guard.
 *   3. OTA SAFETY — the native modules added are expo-video (the player, new
 *      after 1.0.9) and react-native-passkeys (1.0.12; guarded, see
 *      tests/native_passkeys_test.mjs); the incident screen asks
 *      canPlayVideoInApp() before using the player, so older binaries keep
 *      opening videos as before.
 *
 *   node tests/native_no_web_pages_test.mjs
 */
import { execSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/home/elrio/hawkeye';
const N = `${ROOT}/native/src/`;
const read = (f) => fs.readFileSync(f, 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ------------------------------------------------------------- load the table
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-webroutes-'));
const src = read(`${N}lib/web-routes.ts`);
check('lib/web-routes.ts has no imports (loadable as plain JS)', /^import /m.test(src), false);
const file = path.join(tmp, 'web-routes.mjs');
fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }));
const W = await import(pathToFileURL(file).href);

// ============================================================== 1. routing
console.log('\n=== 1. every group / captain alert url lands on a native screen ===');
/* The LIVE urls: every `url: 'https://hawkeye.com.ng/…'` the backend writes,
   filtered to the pages this rule covers. Read from source so a new alert with
   a new page cannot slip past a list typed into this test. */
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(m?js|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
};
const COVERED = /(my-groups|captain(-guide)?|situation-room|join)\.html|\/room\/|\/join\//;
const backendUrls = [...new Set(walk(`${ROOT}/backend/src`)
  .flatMap((f) => [...read(f).matchAll(/url:\s*[`'"](https:\/\/hawkeye\.com\.ng\/[^`'"]*)[`'"]/g)].map((m) => m[1])))]
  .filter((u) => COVERED.test(u));
check('CONTROL found the backend\'s group and captain alert urls', backendUrls.length >= 3, true);
console.log(`        ${backendUrls.join('  ')}`);
const routesAll = (fn) => backendUrls.every((u) => { const r = fn(u); return typeof r === 'string' && r.startsWith('/'); });
check('every one resolves to a native route', backendUrls.map((u) => [u, W.webPageRoute(u)]), (rows) => rows.every(([, r]) => typeof r === 'string' && r.startsWith('/')));
check('CONTROL the same check fails for a table that routes nothing', routesAll(() => null), false);

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const TABLE = [
  ['my-groups.html', 'https://hawkeye.com.ng/my-groups.html', '/my-groups'],
  ['captain.html', 'https://hawkeye.com.ng/captain.html', '/captain'],
  ['the captain guide opens inside the captain screen', 'https://hawkeye.com.ng/captain-guide.html', '/captain?guide=1'],
  ['the made-manager alert (situation-room.html)', 'https://hawkeye.com.ng/situation-room.html', '/my-groups'],
  ['a room address', 'https://hawkeye.com.ng/room/abc-campaign', '/my-groups'],
  ['join.html?t= (the website sign-in round trip)', `https://hawkeye.com.ng/join.html?t=${TOKEN}`, `/join/${TOKEN}`],
  ['join.html with no token', 'https://hawkeye.com.ng/join.html', '/my-groups'],
  ['/join/<token> keeps its case', `https://hawkeye.com.ng/join/${TOKEN}`, `/join/${TOKEN}`],
  ['a bare path', '/my-groups.html', '/my-groups'],
  ['the app\'s own scheme', 'hawkeye://my-groups.html', '/my-groups'],
  ['www.', 'https://www.hawkeye.com.ng/captain.html', '/captain'],
  ['ANOTHER SITE is never rewritten', 'https://evil.example/my-groups.html', null],
  ['a page this rule does not cover goes through untouched', 'https://hawkeye.com.ng/results.html', null],
  ['an /open link goes through untouched (open.tsx owns it)', '/open?to=report&pu=1', null],
  ['a malformed /join/ token goes through untouched', 'https://hawkeye.com.ng/join/x', null],
  ['coverage.html (public, but it has a native screen)', 'https://hawkeye.com.ng/coverage.html', '/coverage'],
  ['coverage.html?state= carries the state', 'https://hawkeye.com.ng/coverage.html?state=Lagos', '/coverage?state=Lagos'],
  ['...decoded once and re-encoded, spaces and all', 'https://hawkeye.com.ng/coverage.html?state=Akwa+Ibom', '/coverage?state=Akwa%20Ibom'],
  ['...and nothing but the state', 'https://hawkeye.com.ng/coverage.html?lga=Ikeja&ward=X', '/coverage'],
  ['ready.html (the election-day readiness check; the eve reminder links it)', 'https://hawkeye.com.ng/ready.html', '/ready'],
  ['...and /ready, as a bare path', '/ready', '/ready'],
];
for (const [label, url, want] of TABLE) check(label, W.webPageRoute(url), want);

console.log('\n=== inviteToken (the pasted-link box on My Groups) ===');
for (const [label, text, want] of [
  ['the whole link', `https://hawkeye.com.ng/join/${TOKEN}`, TOKEN],
  ['the join.html form', `https://hawkeye.com.ng/join.html?t=${TOKEN}`, TOKEN],
  ['pasted without https://', `hawkeye.com.ng/join/${TOKEN}`, TOKEN],
  ['the bare token, with spaces round it', `  ${TOKEN} `, TOKEN],
  ['someone else\'s site', `https://evil.example/join/${TOKEN}`, null],
  ['prose', 'join my campaign please', null],
  ['empty', '', null],
]) check(label, W.inviteToken(text), want);

console.log('\n=== the callers consult the table ===');
const push = read(`${N}lib/push.ts`);
const nr = push.slice(push.indexOf('function nativeRoute'), push.indexOf('export function openNotificationTarget'));
check('push.ts nativeRoute asks webPageRoute', /webPageRoute\(/.test(nr), true);
check('...BEFORE the table and the browser fallback', nr.indexOf('webPageRoute(') >= 0 && nr.indexOf('webPageRoute(') < nr.indexOf('Object.hasOwn(ROUTES'), true);
const intent = read(`${N}app/+native-intent.tsx`);
check('+native-intent returns the table\'s route', /const to = webPageRoute\(path\);\s*if \(to\) return to;/.test(intent), true);
const open = read(`${N}app/open.tsx`);
check('open.tsx knows groups and captain', /groups: '\/my-groups'/.test(open) && /captain: '\/captain'/.test(open), true);
const join = read(`${N}app/join/[token].tsx`);
check('the Continue after joining goes to the native screen', /router\.replace\('\/my-groups'/.test(join), true);
check('...and the join screen no longer opens a browser at all', /openBrowserAsync|WebBrowser/.test(join), false);
check('the screens are registered', ['my-groups', 'captain', 'coverage'].every((n) => new RegExp(`name="${n}"`).test(read(`${N}app/_layout.tsx`))), true);
/* Observer coverage: the public floor is the LGA. The screen reads the public
   endpoint only — never the owner's, and never a ward or an lga filter. */
/* Code only: the screen's own comment names the admin endpoint to say it is
   never called, and a comment is not a request. */
const uncomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const cov = uncomment(read(`${N}app/coverage.tsx`));
const belowFloor = (s) => /admin\/coverage|[?&](lga|ward)=/.test(s);
check('the coverage screen reads the public endpoint', /\/api\/coverage/.test(cov), true);
check('...and never the admin one, nor below the LGA', belowFloor(cov), false);
check('CONTROL the floor check flags an admin or ward read', [belowFloor('`${BASE}/api/admin/coverage`'), belowFloor("'/api/coverage?state=X&ward=Y'")], [true, true]);
check('CONTROL ...but not a comment that names one', belowFloor(uncomment('/* not /api/admin/coverage */\n// nor ?ward=\nfetch(`${BASE}/api/coverage`);')), false);

// ========================================================= 2. call sites
console.log('\n=== 2. no browser-opening call is handed one of these pages or a photo ===');
/** Every browser-opening call in a source, with its argument text. */
const OPENERS = /\b(?:WebBrowser\.)?(openBrowserAsync|openAuthSessionAsync|openURL)\s*\(/g;
function calls(text) {
  const out = [];
  for (const m of text.matchAll(OPENERS)) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    while (i < text.length && depth) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; i++; }
    out.push({ at: m.index, arg: text.slice(start, i - 1), line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}
const FORBIDDEN = /my-groups|captain|join\.html|\/join\/|situation-room|\/room\/|\/uploads\/|uploads|sheetUrl|image_sha256|mediaUrl\(/;
/** A violation, unless it is the one video exception. */
function violations(text, rel = '') {
  return calls(text).filter((c) => FORBIDDEN.test(c.arg)).filter((c) => {
    if (rel !== 'app/incidents.tsx') return true;
    // THE VIDEO EXCEPTION: the call must be the body of `const openVideoInBrowser`
    // — the fallback for binaries without expo-video, and the viewer's own
    // "Open in browser" when a clip will not play.
    const lineText = text.split('\n')[c.line - 1];
    return !/^const openVideoInBrowser = \(file: string\) => WebBrowser\.openBrowserAsync\(mediaUrl\(file\)\);$/.test(lineText.trim());
  }).map((c) => `${rel}:${c.line} ${c.arg.trim().slice(0, 70)}`);
}
const files = walk(N);
const all = files.flatMap((f) => calls(read(f)));
check('CONTROL the scan reaches the app source', files.length > 60 && all.length >= 8, true);
check('no violations anywhere in native/src', files.flatMap((f) => violations(read(f), f.replace(N, ''))), []);

/* CONTROLS: the scanner must flag each shape the old code had, and must not
   flag an unrelated browser call (or it would just be flagging everything). */
for (const [label, sample, want] of [
  ['CONTROL flags the old join Continue', 'await openBrowserAsync(`${BASE}/my-groups.html`, { presentationStyle: X })', 1],
  ['CONTROL flags the old ledger photo', 'WebBrowser.openBrowserAsync(`${BASE}/uploads/${item.image_sha256}.jpg`)', 1],
  ['CONTROL flags the old case photo', 'onPress={() => WebBrowser.openBrowserAsync(`${BASE}${s.sheetUrl}`)}', 1],
  ['CONTROL flags a captain page by Linking', "Linking.openURL(BASE + '/captain.html')", 1],
  ['CONTROL flags a photo opened from the incident feed', 'onPress={() => WebBrowser.openBrowserAsync(mediaUrl(m.file))}', 1],
  ['CONTROL does not flag an unrelated link', 'WebBrowser.openBrowserAsync(rekor)', 0],
]) check(label, violations(sample).length, want);

const inc = read(`${N}app/incidents.tsx`);
check('a video is the only media that still leaves the app, behind its guard',
  /m\.type === 'video' \? openVideo\(m\.file\) : setPhoto\(mediaUrl\(m\.file\)\)/.test(inc), true);
check('CONTROL the exception does not excuse an unguarded photo',
  violations("const openPhoto = (file: string) => WebBrowser.openBrowserAsync(mediaUrl(file));", 'app/incidents.tsx').length, 1);
check('CONTROL the exception is exact: the old always-browser openVideo is flagged',
  violations("const openVideo = (file: string) => WebBrowser.openBrowserAsync(mediaUrl(file));", 'app/incidents.tsx').length, 1);
for (const f of ['app/ledger.tsx', 'app/case.tsx', 'app/incidents.tsx']) {
  check(`${f} shows photos in the native viewer`, /<ImageViewer\b/.test(read(`${N}${f}`)), true);
}

/* The More screen opens any non-`native:` row in the browser. Observer
   Coverage was the last such row; with its native screen, there are none. */
const more = read(`${N}app/(tabs)/more.tsx`);
const rowsOf = (src) => [...src.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
const webRowsOf = (src) => rowsOf(src).filter((h) => !/^(native|action):/.test(h));
const webRows = webRowsOf(more);
check('CONTROL the row scan reaches the menu', rowsOf(more).length >= 20, true);
check('CONTROL a planted web row is caught', webRowsOf("{ label: 'X', href: 'coverage.html' }"), ['coverage.html']);
check('no More row opens a web page at all', webRows, []);
check('no More row opens a groups / captain page on the web', webRows.filter((h) => FORBIDDEN.test(h)), []);
check('More carries My Groups and Apply as Captain, natively',
  /href: 'native:\/my-groups'/.test(more) && /labelKey: 'nav\.apply-as-captain', href: 'native:\/captain'/.test(more), true);
check('More carries Observer Coverage, natively',
  /labelKey: 'coverage\.observer-coverage', href: 'native:\/coverage'/.test(more), true);

// ========================================================== 3. OTA safety
console.log('\n=== 3. over the air: expo-video is the one new native module, and it is guarded ===');
const deps = (json) => Object.keys(JSON.parse(json).dependencies || {}).sort();
let head = null;
try { head = execSync('git -c safe.directory=* show HEAD:native/package.json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no git */ }
check('CONTROL HEAD\'s package.json was readable', !!head, true);
const now = deps(read(`${ROOT}/native/package.json`));
if (head) {
  // expo-video arrives with the player, react-native-passkeys with native
  // passkeys (1.0.12; its import guard is proved by tests/native_passkeys_test.mjs);
  // anything else new is a store-build item this test has not been told about.
  const was = deps(head);
  const diff = [...now.filter((d) => !was.includes(d)), ...was.filter((d) => !now.includes(d))];
  const KNOWN = ['expo-video', 'react-native-passkeys'];
  check('native dependencies differ from HEAD by the known store-build modules at most', diff.filter((d) => !KNOWN.includes(d)), []);
  check('CONTROL an unknown new dependency would be caught', ['expo-video', 'some-new-native-lib'].filter((d) => !KNOWN.includes(d)), ['some-new-native-lib']);
}
check('expo-video is the player; expo-av is not installed', [now.includes('expo-video'), now.includes('expo-av')], [true, false]);
/* A 1.0.9-or-older binary has no expo-video and still runs this JS: the screen
   must ask before it opens the in-app player. The import guard itself is proved
   by tests/video_viewer_guard_test.mjs. */
check('incidents opens the in-app player only when the binary can play, the browser otherwise',
  /const openVideo = \(file: string\) => \(canPlayVideoInApp\(\) \? setVideo\(file\) : openVideoInBrowser\(file\)\);/.test(inc), true);
check('...and renders the viewer', /<VideoViewer\b/.test(inc), true);
const viewer = read(`${N}components/image-viewer.tsx`);
const viewerImports = [...viewer.matchAll(/from '([^'@.][^']*|@[^/']+\/[^/']+)'/g)].map((m) => m[1]).filter((m) => !m.startsWith('@/'));
check('the viewer uses only packages already in the binary',
  viewerImports.filter((m) => !['react', 'react-native'].includes(m) && !now.includes(m)), []);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? `${fail} FAILED` : 'all passed'}`);
process.exit(fail ? 1 : 0);
