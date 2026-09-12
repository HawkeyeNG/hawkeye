/* ITEM 9: IS THERE A WARD BOUNDARY FILE THAT MATCHES INEC'S WARDS?
 *
 * Two steps, and the second is the one that decides anything:
 *
 *   discover  -- ask the open catalogues (geoBoundaries, HDX/CKAN) what Nigeria
 *                ward-level boundary files exist. A fixed set of catalogue APIs,
 *                not a crawl.
 *   test      -- count each candidate's wards PER LGA and diff against the INEC
 *                register we already ship. A file that disagrees on how many
 *                wards an LGA has is not INEC's ward layer, whatever it is
 *                called, and no amount of name-matching will save it.
 *
 * The register is the ground truth here on purpose: 176,846 polling units carry
 * their own (state, lga, ward) from INEC, so the counts come from the same
 * source the app reports against.
 *
 *   node scripts/wards/find_ward_boundaries.mjs discover
 *   node scripts/wards/find_ward_boundaries.mjs test <file.geojson> [...]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const OUT = '/home/elrio/hawkeye/tmp/wards';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/* ---------- ground truth ------------------------------------------------- */

const norm = (s) => String(s || '')
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\bLGA\b|\bLOCAL GOVERNMENT( AREA)?\b/g, ' ')
  .trim();

function truth() {
  const p = OUT + '/register_truth.json';
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const require_ = createRequire('/home/elrio/hawkeye/backend/');
  const DB = require_('better-sqlite3');
  const db = new DB('/home/elrio/hawkeye/backend/storage/hawkeye.db', { readonly: true });
  const rows = db.prepare(
    'select state, lga, ward, count(*) units from polling_units group by state, lga, ward'
  ).all();
  const perLga = {};
  const states = new Set();
  for (const r of rows) {
    if (!r.state || !r.lga || !r.ward) continue;
    const k = norm(r.state) + '|' + norm(r.lga);
    perLga[k] = (perLga[k] || 0) + 1;
    states.add(norm(r.state));
  }
  const t = {
    states: states.size,
    lgas: Object.keys(perLga).length,
    wards: Object.values(perLga).reduce((a, b) => a + b, 0),
    perLga,
  };
  writeFileSync(p, JSON.stringify(t));
  return t;
}

/* ---------- discovery ---------------------------------------------------- */

const GEOBOUNDARIES = (lvl) => `https://www.geoboundaries.org/api/current/gbOpen/NGA/${lvl}/`;
const CKAN = (q) => 'https://data.humdata.org/api/3/action/package_search?rows=25&q='
  + encodeURIComponent(q);

async function json(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
  if (!r.ok) throw new Error(url.slice(0, 60) + ' -> HTTP ' + r.status);
  return r.json();
}

async function discover() {
  const found = [];

  for (const lvl of ['ADM2', 'ADM3', 'ADM4']) {
    try {
      const b = await json(GEOBOUNDARIES(lvl));
      const d = Array.isArray(b) ? b[0] : b;
      if (d && d.gjDownloadURL) {
        found.push({ source: 'geoBoundaries ' + lvl, name: d.boundaryName || lvl, url: d.gjDownloadURL });
      }
    } catch (e) { console.log('  geoBoundaries ' + lvl + ': ' + e.message); }
  }

  /* HDX carries the OCHA common operational datasets AND the GRID3 layers, which
     are the two that anyone citing "Nigeria ward boundaries" is usually citing. */
  const seen = new Set();
  for (const q of ['nigeria ward boundaries', 'nigeria administrative boundaries', 'grid3 nigeria']) {
    try {
      const b = await json(CKAN(q));
      for (const ds of (b.result && b.result.results) || []) {
        for (const res of ds.resources || []) {
          const fmt = String(res.format || '').toLowerCase();
          if (!/geojson|shp|zipped shapefile|gdb|json/.test(fmt)) continue;
          if (!/ward|adm3|admin|boundar/i.test(res.name + ' ' + ds.title)) continue;
          const url = res.url;
          if (!url || seen.has(url)) continue;
          seen.add(url);
          found.push({ source: 'HDX: ' + ds.title.slice(0, 58), name: res.name.slice(0, 58), url });
        }
      }
    } catch (e) { console.log('  HDX "' + q + '": ' + e.message); }
  }

  writeFileSync(OUT + '/candidates.json', JSON.stringify(found, null, 1));
  console.log('\n' + found.length + ' candidate file(s):');
  found.forEach((f, i) => console.log(' ' + String(i + 1).padStart(2) + '. [' + f.source + '] ' + f.name
    + '\n     ' + f.url.slice(0, 118)));
  const t = truth();
  console.log('\nregister says: ' + t.wards + ' wards, ' + t.lgas + ' LGAs, ' + t.states + ' states');
}

/* ---------- the test ------------------------------------------------------ */

/* Which property holds the ward name, and which the LGA. Different publishers
   spell these differently; the file itself says which fields it has. */
const WARD_F = /^(ward|wardname|ward_name|adm3_en|adm3_name|adm3name|admin3name|shapename|name)$/i;
const LGA_F = /^(lga|lganame|lga_name|adm2_en|adm2_name|adm2name|admin2name|shapegroup)$/i;
const STATE_F = /^(state|statename|state_name|adm1_en|adm1_name|adm1name|admin1name)$/i;

function pick(props, re, skip) {
  for (const k of Object.keys(props)) if (re.test(k) && k !== skip) return k;
  return null;
}

function test(file) {
  const t = truth();
  let gj;
  try { gj = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.log('SKIP ' + file + ': ' + e.message.slice(0, 60)); return; }
  const feats = gj.features || [];
  if (!feats.length) { console.log('SKIP ' + file + ': no features'); return; }

  const props = feats[0].properties || {};
  const wf = pick(props, WARD_F);
  const lf = pick(props, LGA_F, wf);
  const sf = pick(props, STATE_F);
  console.log('\n== ' + file.split('/').pop());
  console.log('   features: ' + feats.length + '   fields: ' + Object.keys(props).join(', ').slice(0, 90));
  console.log('   read as ward=' + wf + ' lga=' + lf + ' state=' + sf);
  if (!wf || !lf) { console.log('   VERDICT: unusable — no ward/LGA fields to count by'); return; }

  const per = {};
  for (const f of feats) {
    const p = f.properties || {};
    const k = (sf ? norm(p[sf]) : '') + '|' + norm(p[lf]);
    per[k] = (per[k] || 0) + 1;
  }
  // Without a state field the key is "|LGA"; compare on the LGA half only.
  const mine = {};
  for (const [k, v] of Object.entries(t.perLga)) {
    const kk = sf ? k : '|' + k.split('|')[1];
    mine[kk] = (mine[kk] || 0) + v;
  }
  const keys = new Set([...Object.keys(per), ...Object.keys(mine)]);
  let exact = 0, off = 0, onlyFile = 0, onlyReg = 0, diffSum = 0;
  const worst = [];
  for (const k of keys) {
    const a = mine[k], b = per[k];
    if (a == null) { onlyFile++; continue; }
    if (b == null) { onlyReg++; continue; }
    if (a === b) { exact++; continue; }
    off++; diffSum += Math.abs(a - b);
    worst.push([k, a, b]);
  }
  worst.sort((x, y) => Math.abs(y[1] - y[2]) - Math.abs(x[1] - x[2]));
  const matched = exact + off;
  console.log('   wards: file ' + feats.length + ' vs register ' + t.wards
    + '   (' + (feats.length - t.wards >= 0 ? '+' : '') + (feats.length - t.wards) + ')');
  console.log('   LGAs matched by name: ' + matched + '/' + t.lgas
    + '   file-only: ' + onlyFile + '   register-only: ' + onlyReg);
  console.log('   per-LGA ward counts: ' + exact + ' exact, ' + off + ' differ (total drift ' + diffSum + ')');
  worst.slice(0, 5).forEach(([k, a, b]) => console.log('     ' + k.replace('|', ' / ') + ': register ' + a + ', file ' + b));
  const pct = matched ? Math.round((exact / matched) * 100) : 0;
  console.log('   VERDICT: ' + (pct >= 95
    ? 'USABLE — ' + pct + '% of matched LGAs agree'
    : pct >= 60
      ? 'PARTIAL — ' + pct + '% agree; would need per-LGA repair'
      : 'NOT INEC WARDS — only ' + pct + '% of matched LGAs agree'));
}

/* ------------------------------------------------------------------------- */
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'discover') await discover();
else if (cmd === 'test') { truth(); args.forEach(test); }
else console.log('usage: find_ward_boundaries.mjs discover | test <file.geojson> ...');
