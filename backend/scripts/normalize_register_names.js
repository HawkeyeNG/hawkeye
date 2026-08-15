// Merge duplicate spellings of the same seat in polling_units.
//
//   node scripts/normalize_register_names.js            # report only
//   node scripts/normalize_register_names.js --apply    # write
//
// The register carries several spellings of one seat — 116 senatorial values for
// 109 districts, 393 federal for 360. Harmless while a single-state governorship
// was the only contest; the moment SEN/REP went live the leaderboard drew 116
// regions and reported 393 subunits.
//
// CANONICAL IS DECIDED BY AUTHORITY, NEVER BY FREQUENCY. Ranking variants by
// polling-unit count picks 'Deltal North' (1,011 units) over 'Delta North'
// (752) and writes the typo in as correct. Two external sources settle it —
// INEC's published final list and the NASS roster in political_cache.json — and
// a variant either appears in one or it does not.
//
// Frequency only breaks ties BETWEEN authority-backed variants, and only after
// formatting hygiene, because both sources contain their own artifacts: INEC's
// text yields 'Ido/Osi, Moba/Ilejeme' and 'Machina/Nguru/Yusufari/ Karasuwa'.
// Preferring the tidier string cannot change which seat is meant — the variants
// are already known to be the same seat — it only decides how it is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import zlib from 'node:zlib';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const PDF = process.argv.find((a) => a.endsWith('.pdf')) || '/tmp/inec_national-2022.pdf';

const norm = (s) => String(s || '').toUpperCase()
  .replace(/&/g, ' AND ').replace(/'/g, '')
  .replace(/\b(FEDERAL\s+)?CONSTITUENCY\b|\bSENATORIAL(\s+DISTRICT)?\b|\bDISTRICT\b/g, ' ')
  .replace(/[^A-Z0-9/]+/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(/[^A-Z0-9]+/).filter(Boolean);
const bigrams = (s) => { const t = `_${s}_`, g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
const dice = (a, b) => { const A = bigrams(a), B = bigrams(b); let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size); };

// How badly is this string written? Purely presentational.
const hygiene = (s) => {
  let p = 0;
  if (/\s\/|\/\s/.test(s)) p += 2;          // stray space around a separator
  if (/,/.test(s)) p += 2;                   // comma inside a slash list
  if (/\s{2,}/.test(s)) p += 1;
  if (/[a-z][A-Z]/.test(s)) p += 1;          // MalumFashi
  if (/^[A-Z\s/-]+$/.test(s) && s.length > 6) p += 1; // SHOUTING
  return p;
};

// ---- authorities
let INEC = '';
if (fs.existsSync(PDF)) {
  const raw = fs.readFileSync(PDF);
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw.toString('latin1'))) !== null) {
    const start = m.index + m[0].length;
    const end = raw.toString('latin1').indexOf('endstream', start);
    if (end < 0) continue;
    try {
      const d = zlib.inflateSync(raw.subarray(start, end)).toString('latin1');
      for (const s of d.match(/\((?:[^()\\]|\\.)*\)/g) || []) out.push(s.slice(1, -1));
    } catch { /* not a flate stream */ }
  }
  INEC = norm(out.join(' '));
}
const cache = JSON.parse(fs.readFileSync(path.join(backend, 'src/data/political_cache.json'), 'utf8'));
const NASS = new Set();
for (const ch of ['house', 'senate']) for (const mm of cache.members[ch].members) if (mm.district) NASS.add(norm(mm.district));
const backedBy = (v) => {
  const n = norm(v); const w = [];
  if (n && INEC.includes(n)) w.push('INEC');
  if (NASS.has(n)) w.push('NASS');
  return w;
};

const db = new Database(path.join(backend, 'storage', 'hawkeye.db'));
const mapping = [];
const unresolved = [];

for (const col of ['senatorial', 'federal_constituency']) {
  const rows = db.prepare(
    `SELECT ${col} AS v, state, COUNT(*) AS n FROM polling_units
      WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY ${col}, state`).all();
  const byVal = new Map();
  for (const r of rows) {
    const e = byVal.get(r.v) || { units: 0, state: r.state };
    e.units += r.n; byVal.set(r.v, e);
  }
  // GROUPING COMES FROM THE MAPS. build_reps_from_wards.js already collapses
  // every register spelling to one region per seat — that is the whole job of
  // the ward dissolve — and it does it better than re-deriving here: its
  // senatorial pass yields 109 groups where a state+direction key yielded 110.
  // Re-implementing that clustering was duplicated work with a worse answer.
  //
  // Fall back to the local key only if the map file is absent, so the script
  // still runs before the maps have been built.
  const level = col === 'senatorial' ? 'senatorial' : 'federal';
  const mapFile = path.join(backend, 'src', 'data', `name_groups.${level}.json`);
  const groups = new Map();
  if (fs.existsSync(mapFile)) {
    const { map } = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const groupOf = (v) => map[v] || v;          // a value not listed is its own group
    for (const [v, e] of byVal) {
      const key = `MAP|${groupOf(v)}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push({ v, ...e });
    }
    // The group's own name may not be a register value at all; include it as a
    // spelling candidate so the authority can choose it.
    for (const [key, vs] of groups) {
      const name = key.slice(4);
      if (!vs.some((x) => x.v === name)) vs.push({ v: name, units: 0, state: vs[0].state });
    }
  } else {
    for (const [v, e] of byVal) {
      const st = new Set(tokens(e.state));
      let key;
      if (col === 'senatorial') {
        const dirs = tokens(v).filter((t) => !st.has(t) && ![...st].some((s) => dice(t.toLowerCase(), s.toLowerCase()) >= 0.72));
        key = `${(e.state || '?').slice(0, 3).toUpperCase()}|${dirs.sort().join('')}`;
      } else {
        key = tokens(v).sort().join('/');
      }
      (groups.get(key) ?? groups.set(key, []).get(key)).push({ v, ...e });
    }
  }
  for (const [, vs] of groups) {
    if (vs.length < 2) continue;
    const backed = vs.map((x) => ({ ...x, w: backedBy(x.v) })).filter((x) => x.w.length);
    if (!backed.length) { unresolved.push({ col, vs }); continue; }
    backed.sort((a, b) => hygiene(a.v) - hygiene(b.v) || b.units - a.units);
    const keep = backed[0];
    // TIDY THE WINNER'S FORMATTING, keeping its token order. Hygiene only
    // decides between variants that BOTH match an authority; where the orders
    // differ, only one matches and it wins on that alone — stray spaces and
    // all. That is how 'Machina/Nguru/Yusufari/ Karasuwa' beat the clean
    // spelling. Order comes from the authority; whitespace does not.
    const keepName = keep.v.replace(/\s*\/\s*/g, '/').replace(/\s{2,}/g, ' ').trim();
    for (const other of vs) if (other.v !== keepName) {
      mapping.push({ col, from: other.v, to: keepName, units: other.units, why: keep.w.join('+') });
    }
  }
}

// Say which authorities actually loaded. INEC's list is optional (pass the PDF
// path); NASS ships in the repo. A silent zero-authority run would "resolve"
// nothing and look like a clean register.
console.log(`authorities: NASS ${NASS.size} districts, INEC ${INEC ? `${INEC.length} chars` : 'NOT LOADED — pass the list PDF to use it'}`);
if (!NASS.size && !INEC) { console.error('no authority available — refusing to guess'); process.exit(1); }

console.log(`duplicate spellings to merge: ${mapping.length}`);
for (const m of mapping) console.log(`  ${m.col.padEnd(21)} ${JSON.stringify(m.from)} -> ${JSON.stringify(m.to)}  (${m.units} units, keep backed by ${m.why})`);
if (unresolved.length) {
  console.log(`\nNO AUTHORITY for either variant — left alone (${unresolved.length}):`);
  for (const u of unresolved) console.log(`  ${u.col}: ${u.vs.map((x) => JSON.stringify(x.v)).join(' | ')}`);
}

const count = (col) => db.prepare(`SELECT COUNT(DISTINCT ${col}) AS n FROM polling_units WHERE ${col} IS NOT NULL AND ${col} <> ''`).get().n;
console.log(`\nbefore: senatorial ${count('senatorial')} (109 real), federal ${count('federal_constituency')} (360 real)`);

// Emit the REVIEWED mapping so production applies a checked list rather than
// re-deriving it. The server has neither the INEC PDF nor a reason to run fuzzy
// matching against live data — inference belongs here, application belongs there.
const outFile = path.join(backend, 'src', 'data', 'register_name_fixes.json');
fs.writeFileSync(outFile, `${JSON.stringify({
  _note: 'Duplicate spellings of one seat, merged. Canonical chosen by authority '
    + '(NASS roster / INEC published list), never by polling-unit count — frequency '
    + "picks 'Deltal North' (1,011 units) over 'Delta North' (752). Whitespace is "
    + "tidied on the winner; token ORDER always comes from the authority.",
  generated: new Date().toISOString().slice(0, 10),
  fixes: mapping.map(({ col, from, to }) => ({ col, from, to })),
}, null, 1)}\n`);
console.log(`\nreviewed mapping -> ${path.relative(backend, outFile)} (${mapping.length} entries)`);

if (!APPLY) { console.log('report only — pass --apply to write'); process.exit(0); }

const tx = db.transaction(() => {
  for (const m of mapping) {
    db.prepare(`UPDATE polling_units SET ${m.col} = ? WHERE ${m.col} = ?`).run(m.to, m.from);
  }
});
tx();
console.log(`after:  senatorial ${count('senatorial')}, federal ${count('federal_constituency')}`);
