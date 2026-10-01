/**
 * EVERY COPY OF INEC'S PARTY REGISTER SAYS THE SAME THING.
 *
 * On 2026-10-01 the Situation Room's party picker had no NDP and offered Boot
 * Party twice. The register (backend/src/data/parties.json, served as
 * /api/parties) still held the 20 parties of 2025, while INEC had registered
 * NDC (Feb 2026, by court order) and NDP (Mar 2026, by court order) — NDP had
 * already polled votes in a declared 19 Sep 2026 by-election result.
 *
 * Asserted:
 *   - the register has each code once, alphabetical by code;
 *   - app.js FALLBACK_PARTIES (the bundled floor for an offline counts step)
 *     equals it entry for entry;
 *   - every party a declared result names is registered;
 *   - the emblem manifest's own codes are registered, and its spelled-out
 *     aliases point at a registered party's emblem;
 *   - race.js, which claims a colour for every ballot code, has one for each.
 * Controls: a copy with one party dropped, and one with a name changed, fail.
 *
 *   node tests/party_register_test.mjs
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const register = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/parties.json`, 'utf8'));
const appJs = fs.readFileSync(`${ROOT}/app/app.js`, 'utf8');
const raceJs = fs.readFileSync(`${ROOT}/app/race.js`, 'utf8');
const emblems = JSON.parse(fs.readFileSync(`${ROOT}/app/logos/manifest.json`, 'utf8'));
const contests = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const codes = register.map((p) => p.code);
check('the register has each code once', new Set(codes).size, codes.length);
check('the register is alphabetical by code', codes, [...codes].sort());
check('every entry has a code and a name', register.every((p) => p.code && p.name), true);

/* app.js FALLBACK_PARTIES, read as text: the array of ['CODE', 'Name'] pairs. */
const block = (appJs.match(/const FALLBACK_PARTIES = \[([\s\S]*?)\]\.map\(/) || [])[1] || '';
const fallback = [...block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => ({ code: m[1], name: m[2] }));
const same = (a, b) => JSON.stringify(a.map((p) => [p.code, p.name])) === JSON.stringify(b.map((p) => [p.code, p.name]));
check('CONTROL: FALLBACK_PARTIES was found and parsed', fallback.length > 0, true);
check('app.js FALLBACK_PARTIES equals the register', same(fallback, register), true);
check('CONTROL: a copy missing one party is caught', same(fallback.slice(1), register), false);
check('CONTROL: a copy with one name changed is caught',
  same(fallback.map((p, i) => (i === 0 ? { ...p, name: p.name + 'x' } : p)), register), false);

/* Every party a contest names — on its ballot or in its declared result, or in
   a recorded declaration — must be one the register knows. */
const named = new Set();
const walk = (o) => {
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'party' && typeof v === 'string' && v) named.add(v);
    else walk(v);
  }
};
walk(contests);
walk(JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/declarations.json`, 'utf8')));
check('CONTROL: contests name parties, NDP among them', named.has('NDP') && named.has('APC'), true);
check('every party a contest or declaration names is registered', [...named].filter((p) => !codes.includes(p)), []);

/* The emblem manifest: a key named like its file is a code; others are aliases. */
const base = (v) => String(v).replace(/^.*\//, '').replace(/\.[a-z]+$/i, '');
const own = Object.keys(emblems).filter((k) => base(emblems[k]) === k);
const aliases = Object.keys(emblems).filter((k) => base(emblems[k]) !== k);
check('every emblem code is a registered party', own.filter((k) => !codes.includes(k)), []);
check('every emblem alias points at a registered party\'s emblem', aliases.filter((k) => !codes.includes(base(emblems[k]))), []);

/* race.js says it has a colour for "every code that can appear on a ballot". */
const pc = (raceJs.match(/const PC = \{([\s\S]*?)\};/) || [])[1] || '';
const coloured = new Set([...pc.matchAll(/([A-Za-z]+):\s*'#/g)].map((m) => m[1]));
check('CONTROL: race.js colours were found', coloured.size > 0, true);
check('race.js has a colour for every registered party', codes.filter((c) => !coloured.has(c)), []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
