/**
 * A MISSING MAP MUST NOT STOP THE COUNT.
 *
 * results.html's loadGeo had no catch and no status check, and refresh() awaits
 * ensureGeo() before it populates the follow picker, draws the map, or updates
 * the "N units reporting · updated …" line. So ONE failed geo fetch rejected
 * refresh() and skipped all three — while renderBoard(), which runs BEFORE the
 * await, still painted the tally. The result was a half-drawn board that reads
 * as a stalled count rather than a missing file. Worse, the rejected promise was
 * memoised in GEOCACHE, so a single transient blip never retried for the life of
 * the page.
 *
 * On election day that is the worst shape a failure can take: the numbers are
 * the product, and the numbers were what stopped.
 *
 * This runs the SHIPPED loadGeo — lifted out of results.html, not retyped —
 * against a stubbed fetch, and checks the four behaviours that matter.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const SRC = fs.readFileSync(`${ROOT}/app/results.html`, 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- lift the real loadGeo out of the page -------------------------------
// Anchored on `const GEOCACHE` through the end of the loadGeo assignment, so
// this test breaks loudly if the function is renamed or restructured rather
// than silently testing a stale copy.
// Indentation-agnostic on purpose: an earlier version of this anchor pinned the
// closing brace to 8 spaces and broke on a reformat, which is a test failing for
// a reason that has nothing to do with the behaviour it guards.
const m = SRC.match(/const GEOCACHE = \{\};[\s\S]*?const loadGeo =[\s\S]*?\}\)\);/);
if (!m) {
  console.log('FAIL  could not find loadGeo in results.html — it was renamed or reshaped');
  process.exit(1);
}
const source = m[0];
check('lifted the real loadGeo from results.html', source.includes('delete GEOCACHE[f]'), true);

let fetchCalls = 0;
let nextResponse = null;
const makeLoadGeo = () => {
  const fetch = (f) => {
    fetchCalls++;
    if (nextResponse === 'throw') return Promise.reject(new Error('network down'));
    return Promise.resolve(nextResponse);
  };
  // `window` is stubbed WITHOUT fetchData, which is the website's own path:
  // native.js only defines it inside the Capacitor shell. The Lite path (live
  // fetch with the bundle stripped) is the same promise either way, so the
  // behaviours below hold for both.
  // eslint-disable-next-line no-new-func
  return new Function('fetch', 'window', `${source}; return { loadGeo, GEOCACHE };`)(fetch, {});
};

const OK = (body) => ({ ok: true, status: 200, json: async () => body });
const NOT_FOUND = { ok: false, status: 404, json: async () => { throw new Error('not json'); } };

console.log('\n=== a good response still works ===');
{
  const { loadGeo } = makeLoadGeo();
  nextResponse = OK({ viewBox: '0 0 8 8', states: [{ name: 'Osun' }] });
  const g = await loadGeo('states_geo.json');
  check('returns the parsed geometry', g?.states?.[0]?.name, 'Osun');
}

console.log('\n=== a 404 resolves to null instead of rejecting ===');
{
  const { loadGeo, GEOCACHE } = makeLoadGeo();
  nextResponse = NOT_FOUND;
  let threw = false;
  let g;
  try { g = await loadGeo('lga_geo.json'); } catch { threw = true; }
  check('does not reject', threw, false);
  check('resolves to null', g, null);
  check('and the failure is NOT cached', Object.keys(GEOCACHE), []);
}

console.log('\n=== a network error resolves to null too ===');
{
  const { loadGeo, GEOCACHE } = makeLoadGeo();
  nextResponse = 'throw';
  let threw = false;
  let g;
  try { g = await loadGeo('district_geo.json'); } catch { threw = true; }
  check('does not reject', threw, false);
  check('resolves to null', g, null);
  check('and is not cached', Object.keys(GEOCACHE), []);
}

console.log('\n=== THE REGRESSION: a blip must not poison the page ===');
{
  const { loadGeo } = makeLoadGeo();
  nextResponse = NOT_FOUND;
  check('first attempt fails', await loadGeo('lga_geo.json'), null);
  nextResponse = OK({ lgas: [{ key: 'osun|ife' }] });
  const second = await loadGeo('lga_geo.json');
  check('the very next attempt succeeds', second?.lgas?.[0]?.key, 'osun|ife');
}

console.log('\n=== a SUCCESS is still cached — one fetch, not one per refresh ===');
{
  const { loadGeo } = makeLoadGeo();
  fetchCalls = 0;
  nextResponse = OK({ states: [] });
  await loadGeo('states_geo.json');
  await loadGeo('states_geo.json');
  await loadGeo('states_geo.json');
  check('three calls, one fetch', fetchCalls, 1);
}

console.log('\n=== and the drawing side refuses to run without geometry ===');
// renderMap is 400 lines of DOM work and not liftable, so its guard is asserted
// on the shipped source. It is the half of the fix that stops a null layer
// throwing where the catch above stops a rejection propagating.
check('renderMap bails when a needed layer is missing',
  /if \(!STATES\?\.states \|\| \(need && !need\(\)\)\)/.test(SRC), true);
check('the guard covers lga, senatorial AND federal, not just states',
  /const LAYER = \{ lga: \(\) => LGAS, senatorial: \(\) => DGEO, federal: \(\) => CGEO \}/.test(SRC), true);
check('it says so on screen rather than rendering nothing', /Map unavailable/.test(SRC), true);
check('the follow picker tolerates a null layer',
  /\(DGEO\?\.regions \?\? \[\]\)/.test(SRC) && /\(STATES\?\.states \?\? \[\]\)/.test(SRC), true);

console.log('\n=== control: the harness can fail ===');
{
  // If the stub always returned data, every assertion above would be vacuous.
  const { loadGeo } = makeLoadGeo();
  nextResponse = NOT_FOUND;
  check('a 404 really does produce null here', await loadGeo('x_geo.json'), null);
  nextResponse = OK({ marker: 1 });
  check('and a 200 really does produce data', (await loadGeo('y_geo.json'))?.marker, 1);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
