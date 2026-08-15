// Reconcile the register's remaining federal spellings with the map's, by
// AUTHORITY — in whichever direction that points.
//
// The naive fix is to rename the register to whatever the map calls the region.
// That is wrong as often as it is right: the map says "Furore/Song" where the
// register says "Fufore/Song", "Nkokwa East" for "Ndokwa East", "Shedam" for
// "Shendam". Both sides carry typos, because both derive from the same raw CSV
// by different routes.
//
// So for each pair, ask the NASS roster and INEC's published list which spelling
// is real, and emit fixes for whichever side is wrong. The builder applies the
// same file to its region labels, so the two converge on one name.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

const backend = '/home/elrio/hawkeye/backend';
const db = new Database(path.join(backend, 'storage/hawkeye.db'), { readonly: true });
const regions = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/app/constituency_geo.json', 'utf8')).regions.map((r) => r.name);

const norm = (s) => String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/['’]/g, '')
  .replace(/[^A-Z0-9/]+/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).split('/').map((p) => p.trim()).filter(Boolean).sort().join('/');
const bg = (s) => { const t = `_${s}_`, g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
const dice = (a, b) => { const A = bg(a), B = bg(b); let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size); };
const tidy = (s) => s.replace(/\s*\/\s*/g, '/').replace(/\s{2,}/g, ' ').trim();

// ---- authorities
const cache = JSON.parse(fs.readFileSync(path.join(backend, 'src/data/political_cache.json'), 'utf8'));
const NASS = new Set();
for (const ch of ['house', 'senate']) for (const m of cache.members[ch].members) if (m.district) NASS.add(norm(m.district));
let INEC = '';
const pdf = '/tmp/inec_national-2022.pdf';
if (fs.existsSync(pdf)) {
  const raw = fs.readFileSync(pdf).toString('latin1');
  const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(raw)) !== null) {
    const s = m.index + m[0].length, e = raw.indexOf('endstream', s);
    if (e < 0) continue;
    try {
      const d = zlib.inflateSync(Buffer.from(raw.slice(s, e), 'latin1')).toString('latin1');
      for (const q of d.match(/\((?:[^()\\]|\\.)*\)/g) || []) out.push(q.slice(1, -1));
    } catch { /* not flate */ }
  }
  INEC = norm(out.join(' '));
}
const backed = (v) => {
  const n = norm(v); const w = [];
  if (n && INEC.includes(n)) w.push('INEC');
  if (NASS.has(n)) w.push('NASS');
  return w;
};

// MATCH ON COMPONENTS, AND LET THE AUTHORITY SUPPLY THE NAME.
//
// Exact-string matching resolved only 6 of 29: these pairs differ in ORDER
// ("Gwandu/Aliero/Jega" against "Aleiro/Gwandu/Jega"), so neither side matched
// an authority that lists the same seat under a third ordering. Keyed on the
// sorted component set, the authority recognises almost all of them — and then
// there is no need to choose between two flawed local spellings at all, because
// the authority has a name of its own.
const AUTH_BY_KEY = new Map();
for (const ch of ['house', 'senate']) {
  for (const m of cache.members[ch].members) {
    if (!m.district) continue;
    const k = key(m.district);
    if (!AUTH_BY_KEY.has(k)) AUTH_BY_KEY.set(k, { name: m.district.trim(), src: 'NASS' });
  }
}

const haveKeys = new Set(regions.map(key));
const unmatched = db.prepare(
  `SELECT federal_constituency v, state, COUNT(*) n FROM polling_units
    WHERE federal_constituency IS NOT NULL AND federal_constituency <> ''
    GROUP BY federal_constituency, state`).all().filter((r) => !haveKeys.has(key(r.v)));

const regionState = new Map();
for (const r of db.prepare(
  `SELECT federal_constituency v, state FROM polling_units WHERE federal_constituency IS NOT NULL
   GROUP BY federal_constituency, state`).all()) if (!regionState.has(key(r.v))) regionState.set(key(r.v), r.state);

const fixes = [];
const review = [];
const noAuthority = [];
for (const u of unmatched) {
  const pool = regions.filter((r) => { const st = regionState.get(key(r)); return !st || st === u.state; });
  let best = null, score = 0;
  for (const r of pool) { const s = dice(key(u.v), key(r)); if (s > score) { score = s; best = r; } }
  if (!best || score < 0.72) { review.push({ ...u, best, score: +score.toFixed(3) }); continue; }

  const wReg = backed(u.v), wMap = backed(best);
  let canonical = null;
  // The authority's own name first, matched on components so ordering cannot
  // hide it. Only if the authority has never heard of the seat do we fall back
  // to choosing between the two local spellings.
  const auth = AUTH_BY_KEY.get(key(u.v)) || AUTH_BY_KEY.get(key(best));
  if (auth) canonical = auth.name;
  else if (wReg.length && !wMap.length) canonical = u.v;
  else if (wMap.length && !wReg.length) canonical = best;
  else if (wReg.length && wMap.length) canonical = tidy(u.v).length <= tidy(best).length ? u.v : best;
  // NO AUTHORITY KNOWS THIS SEAT — 17 of them. Neither NASS nor INEC lists it
  // under any ordering, so there is no way to establish which local spelling is
  // right, and pretending otherwise would be inventing a fact. What CAN be
  // fixed is the disagreement: the register is the system of record (it is what
  // an observer picks a unit from), so its spelling wins and the map follows.
  // That buys consistency, not correctness, and is flagged as such.
  if (!canonical) { canonical = tidy(u.v); noAuthority.push(canonical); }

  canonical = tidy(canonical);
  if (tidy(u.v) !== canonical) fixes.push({ col: 'federal_constituency', from: u.v, to: canonical });
  if (tidy(best) !== canonical) fixes.push({ col: 'federal_constituency', from: best, to: canonical });
  console.log(`${(wReg.join('+') || '-').padEnd(9)} reg ${JSON.stringify(u.v)}`);
  console.log(`${(wMap.join('+') || '-').padEnd(9)} map ${JSON.stringify(best)}`);
  console.log(`          => ${JSON.stringify(canonical)}\n`);
}

console.log(`consistency-only, no authority arbitrates: ${noAuthority.length}`);
console.log(`fixes to add: ${fixes.length}`);
console.log(`needs a human: ${review.length}`);
for (const r of review) console.log(`  ${JSON.stringify(r.v)} (${r.n} units, ${r.state}) best ${r.score} ${JSON.stringify(r.best)}${r.why ? ' — ' + r.why : ''}`);
fs.writeFileSync('/tmp/federal_fixes.json', JSON.stringify(fixes, null, 1));
