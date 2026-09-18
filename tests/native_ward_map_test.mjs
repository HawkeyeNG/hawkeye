/**
 * NATIVE'S WARD CUT RESOLVES EVERY BY-ELECTION LGA TO ITS WARD-FILE KEY.
 *
 * race-map.tsx now draws a state seat in wards, the way the site does. The
 * rendering it reuses (Svg + Path) is already proven by the LGA cut, and tsc
 * covers the shape of it, so the one genuinely new failure is the LOOKUP: the
 * register's LGA name has to find the ward file's key, and those two disagree.
 * Kano is the live example - the register says "Dawaki Kudu", the ward file
 * says "DAWAKIN KUDU" - and a miss here is silent, falling back to the flat LGA
 * blob the app drew before.
 *
 * Uses the REAL matchRegion out of components/results-map.tsx, loaded the way
 * the parity test loads political.ts. A reimplementation here would be a test
 * of this file.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/native/`);
const { transform } = require_('sucrase');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const SRC = `${ROOT}/native/src/components/results-map.tsx`;
const code = transform(fs.readFileSync(SRC, 'utf8'), {
  transforms: ['typescript', 'jsx', 'imports'],
  filePath: SRC,
}).code;
const module_ = { exports: {} };
new Function('require', 'module', 'exports', 'process', code)(
  () => new Proxy({}, { get: () => () => null }), module_, module_.exports, { env: {} },
);
const { matchRegion } = module_.exports;
check('the real matchRegion loaded', typeof matchRegion, 'function');

const contests = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

console.log('\n=== every SHA by-election LGA finds its ward-file key ===');
for (const c of contests.filter((x) => x.tier === 'SHA' && x.constituencies)) {
  const state = c.states[0];
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/app/maps/wards/${slug(state)}.json`, 'utf8'));
  const pool = Object.keys(raw.lgas).map((k) => ({ key: k }));
  for (const lga of c.constituencies) {
    const hit = matchRegion('lga', lga, pool, (x) => x.key);
    check(`${c.code}: "${lga}" -> a ward-file key`, hit && hit.key, (k) => typeof k === 'string' && k.length > 0);
    if (hit) {
      const n = raw.lgas[hit.key].wards.length;
      // A cut of one ward is not a cut; race-map requires > 1 before using it.
      check(`${c.code}: "${hit.key}" has more than one ward`, n, (x) => x > 1);
      console.log(`        ${lga} -> ${hit.key} (${n} wards)`);
    }
  }
}

console.log('\n=== the seat-ward filter keeps only the seat (Bauchi) ===');
for (const code of ['SHA_BYE_BAUCHI_SAKWA_2026', 'SHA_BYE_BAUCHI_DISINA_2026']) {
  const c = contests.find((x) => x.code === code);
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/app/maps/wards/bauchi.json`, 'utf8'));
  const hit = matchRegion('lga', c.constituencies[0], Object.keys(raw.lgas).map((k) => ({ key: k })), (x) => x.key);
  const titleCase = (s) => s.replace(/\b[a-z]/g, (x) => x.toUpperCase());
  const want = c.wards.map((x) => ({ key: x }));
  const kept = raw.lgas[hit.key].wards
    .map((w) => titleCase(String(w.n).toLowerCase()))
    .filter((n) => matchRegion('lga', n, want, (x) => x.key));
  check(`${code} keeps 4 of the LGA's wards`, kept.length, 4);
  check(`${code} keeps only wards the seat holds`, kept, (k) =>
    k.every((n) => matchRegion('lga', n, want, (x) => x.key)));
  console.log(`        kept: ${kept.join(', ')}`);
}

// CONTROL: an LGA that is not in the file must NOT resolve, or the matcher is
// simply saying yes to everything.
console.log('\n=== control ===');
const delta = JSON.parse(fs.readFileSync(`${ROOT}/app/maps/wards/delta.json`, 'utf8'));
const pool = Object.keys(delta.lgas).map((k) => ({ key: k }));
check('a Kano LGA does not resolve inside Delta', matchRegion('lga', 'Dawaki Kudu', pool, (x) => x.key), (h) => !h);
check('nonsense does not resolve', matchRegion('lga', 'Zzzzqq', pool, (x) => x.key), (h) => !h);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
