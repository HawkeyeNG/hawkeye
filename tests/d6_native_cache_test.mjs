/**
 * D6, NATIVE: the signed-in reads keep an answer 120 s, a push or the caller's
 * own write ends it, and the unread badge no longer re-reads on EVERY return to
 * the front.
 *
 * lib/signed-in-cache.ts is pure, so it is transpiled and RUN here against a
 * fake clock (requests counted, with controls). lib/push.ts pulls in Expo native
 * modules that cannot load in Node, so its wiring is checked in the source.
 *
 *   node tests/d6_native_cache_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ts = createRequire(path.join(ROOT, 'native', 'package.json'))('typescript');

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? `   [${JSON.stringify(got)}]` : ''}`);
  if (!ok) failed++;
};

const src = fs.readFileSync(path.join(ROOT, 'native/src/lib/signed-in-cache.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hk-d6n-')), 'cache.mjs');
fs.writeFileSync(file, js);
const C = await import(pathToFileURL(file).href);

let clock = 0;
const now = () => clock;
let loads = 0;
const load = async () => { loads++; return { rooms: [], n: loads }; };
const get = (tk = 'A', force = false) => C.fresh('/api/my/rooms', tk, load, { now, force });

console.log('=== one request per 120 s, measured over 10 minutes ===');
// Before D6 every mount asked: one call per report flow. Six flows, 100 s apart:
// t=0 asks, t=100 is inside 120 s, t=200 asks, t=300 inside, t=400 asks, t=500 inside.
for (let i = 0; i < 6; i++) { await get(); clock += 100_000; }
check('six mounts 100 s apart -> 3 requests (was 6)', loads === 3, loads);
loads = 0; clock += 1_000_000;
await get(); await get(); await get();
check('three report flows back to back at one unit -> ONE request (was 3)', loads === 1, loads);
const [a, b] = await Promise.all([get('A', true), get('A', true)]);
check('two callers at once share one request', loads === 2 && a === b, loads);

console.log('\n=== what ends the 120 s ===');
loads = 0; clock += 1_000_000;
await get(); clock += 10_000; await get();
check('control: 10 s later, nothing changed -> answered from memory', loads === 1, loads);
C.notePush(); await get();
check('a push -> asks again', loads === 2, loads);
C.bust('/api/my/rooms'); await get();
check('the caller\'s own write (bust) -> asks again', loads === 3, loads);
await get('B');
check('another account\'s token never gets the first one\'s answer', loads === 4, loads);
clock += 120_000; await get('B');
check('120 s -> asks again', loads === 5, loads);

console.log('\n=== what is never kept ===');
loads = 0; clock += 1_000_000;
await C.fresh('/x', 'A', async () => { loads++; throw new Error('offline'); }, { now }).catch(() => {});
await C.fresh('/x', 'A', async () => { loads++; return 1; }, { now });
check('a failure is not kept', loads === 2, loads);
loads = 0; clock += 1_000_000;
let release;
const slow = C.fresh('/y', 'A', () => new Promise((r) => { loads++; release = r; }), { now });
C.notePush();
release(1); await slow;
await C.fresh('/y', 'A', async () => { loads++; return 2; }, { now });
check('an answer in flight when a push landed is used once but not kept', loads === 2, loads);

console.log('\n=== the wiring (source) ===');
const push = fs.readFileSync(path.join(ROOT, 'native/src/lib/push.ts'), 'utf8');
const rooms = fs.readFileSync(path.join(ROOT, 'native/src/lib/check-in.ts'), 'utf8');
const follow = fs.readFileSync(path.join(ROOT, 'native/src/components/follow-race.tsx'), 'utf8');
check('coming back to the front no longer re-reads unconditionally (no AppState listener in push.ts)', !/AppState\.addEventListener/.test(push));
check('  ...the 120 s backstop asks only when stale, while in front', /useForegroundInterval\(backstop, FRESH_MS\)/.test(push) && /refreshUnread\(\{ ifStale: true \}\)/.test(push));
check('a received push drops the cache and re-reads at once', /addNotificationReceivedListener\(\(\) => \{\s*notePush\(\);\s*refreshUnread\(\);/.test(push));
check('a tapped push drops the cache', /notePush\(\);\s*openNotificationTarget/.test(push));
check('sign-out drops everything kept', /unreadAt = 0;\s*bustSignedIn\(\);/.test(push));
check('the default refresh still asks at once (a failed receipt must correct the badge)', /if \(opts\.ifStale &&/.test(push));
check('myRooms goes through the cache; checkIn drops it on success', /fresh\(ROOMS_KEY, getToken\(\)/.test(rooms) && /bust\(ROOMS_KEY\);\s*return \{ ok: true/.test(rooms));
check('the Follow control reads /me through the cache and drops it after its write', /fresh\('\/api\/observers\/me', getToken\(\)/.test(follow) && /bust\('\/api\/observers\/me'\);\s*setSubs/.test(follow));
check('the room dashboard is not touched by this (no cache in room code)', !/signed-in-cache/.test(
  fs.readdirSync(path.join(ROOT, 'native/src/app')).filter((f) => /room/i.test(f))
    .map((f) => { try { return fs.readFileSync(path.join(ROOT, 'native/src/app', f), 'utf8'); } catch { return ''; } }).join('\n')));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
