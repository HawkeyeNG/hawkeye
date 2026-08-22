/**
 * Regression test for app/native.js's fetchData().
 *
 *   node backend/scripts/test_fetchdata.mjs
 *
 * fetchData decides whether a data file comes from the LIVE site or from the
 * copy sitting next to the page. Getting that wrong is invisible in testing and
 * expensive in the field: pick the local copy in Hawkeye Lite and every
 * candidate correction needs a Play release; pick the live one during local
 * development and an edited political_data.json appears to do nothing.
 *
 * Runs the real helper text out of native.js against a stubbed location/fetch,
 * so it cannot drift from what ships.
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../app/native.js', import.meta.url), 'utf8');
const helper = src.slice(src.indexOf('window.HAWKEYE_LIVE_ORIGIN'));
if (!helper) { console.error('could not find fetchData in app/native.js'); process.exit(1); }

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
};

function run(hostname, fetchImpl, proto = 'https:') {
  const asked = [];
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'location', 'fetch', helper)(
    win,
    { hostname, protocol: proto },
    (u) => { asked.push(u); return fetchImpl(u); },
  );
  return { fetchData: win.fetchData, asked };
}

const live = { ok: true, tag: 'live' };
const bundled = { ok: true, tag: 'bundled' };

console.log('on the live site (web PWA)');
{
  const { fetchData, asked } = run('hawkeye.com.ng', () => Promise.resolve(live));
  await fetchData('political_data.json');
  eq('fetches relative, unchanged behaviour', asked, ['political_data.json']);
}
{
  const { fetchData, asked } = run('www.hawkeye.com.ng', () => Promise.resolve(live));
  await fetchData('political_data.json');
  eq('www subdomain also treated as live', asked, ['political_data.json']);
}

console.log('\noff-origin (Hawkeye Lite, https://localhost)');
{
  const { fetchData, asked } = run('localhost', () => Promise.resolve(live));
  const r = await fetchData('political_data.json');
  eq('goes to the live file', asked, ['https://hawkeye.com.ng/political_data.json']);
  eq('returns the live response', r.tag, 'live');
}
{
  const { fetchData, asked } = run('localhost', (u) =>
    (u.startsWith('https://') ? Promise.reject(new Error('offline')) : Promise.resolve(bundled)));
  const r = await fetchData('political_data.json');
  eq('offline falls back to the bundle', asked, ['https://hawkeye.com.ng/political_data.json', 'political_data.json']);
  eq('returns the bundled copy', r.tag, 'bundled');
}
{
  // A 5xx must fall back too — otherwise an INEC-day outage blanks the page.
  const { fetchData, asked } = run('localhost', (u) =>
    (u.startsWith('https://') ? Promise.resolve({ ok: false, status: 502 }) : Promise.resolve(bundled)));
  const r = await fetchData('political_data.json');
  eq('non-ok status falls back too', r.tag, 'bundled');
  eq('both were attempted', asked.length, 2);
}
{
  const { fetchData, asked } = run('localhost', () => Promise.resolve(live));
  await fetchData('logos/manifest.json');
  eq('nested paths join correctly', asked, ['https://hawkeye.com.ng/logos/manifest.json']);
}
{
  // A hostname that merely CONTAINS the domain must not be trusted as live.
  const { fetchData, asked } = run('hawkeye.com.ng.evil.test', () => Promise.resolve(live));
  await fetchData('political_data.json');
  eq('lookalike host is NOT treated as live', asked, ['https://hawkeye.com.ng/political_data.json']);
}

console.log('\nlocal development');
{
  const { fetchData, asked } = run('localhost', () => Promise.resolve(live), 'http:');
  await fetchData('political_data.json');
  eq('http dev server reads the LOCAL file', asked, ['political_data.json']);
}
{
  const { fetchData, asked } = run('127.0.0.1', () => Promise.resolve(live), 'http:');
  await fetchData('political_data.json');
  eq('127.0.0.1 dev likewise', asked, ['political_data.json']);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
