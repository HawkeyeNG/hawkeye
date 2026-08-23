/**
 * The map must never draw a HOLE.
 *
 * cropShapes narrows an LGA map to the sub-units a contest is actually held in.
 * Its failure mode is silent and serious: the register and lga_geo.json disagree
 * on ~50 LGA spellings, and a crop that keeps only the names it can resolve
 * removes 43 real LGAs across 26 states — Osun loses Ayedade ("Ayedaade" in the
 * register), Lagos loses Shomolu ("Somolu"), Kano loses Dambatta and Nassarawa.
 * A missing shape reads as "no LGA there", which is a lie, and nothing on screen
 * would say so.
 *
 * Every existing fixture builds its `subunits` out of lga_geo.json — GEO
 * spellings — so no test in the suite could ever see this. This one runs the
 * REAL exported function against the REAL register and the REAL geo file.
 *
 * Transpiled with sucrase and evaluated with the React imports stubbed, so it
 * exercises the shipped source rather than a copy of it. A copy is what let the
 * legend and the map disagree in the first place.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/native/`);
const { transform } = require_('sucrase');

const SRC = `${ROOT}/native/src/components/results-map.tsx`;
const code = transform(fs.readFileSync(SRC, 'utf8'), {
  transforms: ['typescript', 'jsx', 'imports'],
  filePath: SRC,
}).code;

// Nothing React is CALLED at import time except memo(), so a stub suffices.
const stub = new Proxy(
  { memo: (f) => f, useEffect() {}, useMemo: (f) => f(), useState: () => [null, () => {}], default: {} },
  { get: (t, k) => (k in t ? t[k] : () => null) },
);
const fakeRequire = () => stub;
const module_ = { exports: {} };
new Function('require', 'module', 'exports', 'process', code)(
  fakeRequire, module_, module_.exports, { env: {} },
);
const { cropShapes, regionKey } = module_.exports;
if (typeof cropShapes !== 'function') {
  console.log('FAIL  cropShapes did not load — this run proves nothing');
  process.exit(1);
}

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const raw = JSON.parse(fs.readFileSync(`${ROOT}/app/lga_geo.json`, 'utf8'));
const geo = {
  viewBox: raw.viewBox,
  geoLevel: 'lga',
  shapes: raw.lgas.map((l) => {
    const [st, lga] = l.key.split('|');
    return { name: titleCase(lga || ''), key: l.key, state: st, path: l.path };
  }),
};

const db = new DatabaseSync(`${ROOT}/backend/storage/hawkeye.db`, { readOnly: true });
const byState = new Map();
for (const r of db.prepare(
  "SELECT DISTINCT state, lga FROM polling_units WHERE lga IS NOT NULL AND lga != '' ORDER BY state, lga",
).all()) {
  if (!byState.has(r.state)) byState.set(r.state, []);
  byState.get(r.state).push(r.lga);
}

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

console.log('=== a whole-state board keeps every LGA, however the register spells it ===');
let holed = [];
for (const [state, lgas] of byState) {
  const pool = geo.shapes.filter((s) => s.state === regionKey('state', state));
  const drawn = cropShapes(geo, 'lga', state, lgas) ?? [];
  if (drawn.length !== pool.length) holed.push(`${state}: ${pool.length} → ${drawn.length}`);
}
check('no state loses a shape to a spelling it cannot resolve', holed, []);
// The control: without it the check above passes just as well on an empty map.
check('and the states were actually drawn', byState.size, 37);
check('every LGA in the country has a path', geo.shapes.length, 774);

console.log('\n=== a board confined to named LGAs crops to exactly those ===');
const named = (state, subs) => (cropShapes(geo, 'lga', state, subs) ?? []).map((s) => s.name);
check('the Gombe by-election draws its 3 member LGAs',
  named('Gombe', ['Funakaye', 'Gombe', 'Kwami']).sort(), ['Funakaye', 'Gombe', 'Kwami']);
check('the Delta by-election draws Udu alone', named('Delta', ['Udu']), ['Udu']);
// The register says "Dawaki Kudu", the geo file says "Dawakin Kudu". If this
// stops resolving, the Kano board silently reverts to all 44 LGAs.
check('the Kano by-election resolves the register spelling to the geo one',
  named('Kano', ['Dawaki Kudu']), ['Dawakin Kudu']);
check('and that is one shape, not the state', named('Kano', ['Dawaki Kudu']).length, 1);

console.log('\n=== declining to crop is preferred to cropping wrongly ===');
check('an unresolvable name draws the whole state rather than a hole',
  named('Kano', ['Dawaki Kudu', 'Not A Real LGA']).length,
  geo.shapes.filter((s) => s.state === 'kano').length);
check('no subunits at all draws the whole state', named('Kano', null).length, 44);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
