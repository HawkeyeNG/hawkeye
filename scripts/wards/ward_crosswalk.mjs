/* THE BLOCKER IS NAMES, NOT BOUNDARIES.
 *
 * compare_ward_sources.mjs found that in 549 LGAs the polygon file already has
 * exactly as many wards as the INEC register does and they still do not line
 * up, because the two spell them differently. That is a crosswalk problem, and
 * a crosswalk is text -- no geometry is downloaded anywhere in here.
 *
 * Three passes, cheapest first, each one gated:
 *
 *   LGA   -- the register and the polygon file disagree about LGA names too
 *            (IHALA/IHIALA, OSHIMILINORTH/OSHIMILI NORTH). Matched WITHIN a
 *            state, so a rescue can never cross a state line.
 *   canon -- transforms that cannot change which ward is meant: roman numerals
 *            to digits, standalone N/S/E/W/C to the written direction, a
 *            leading or trailing "WARD" token dropped, leading zeros dropped.
 *            "A"/"B" suffixes are NOT touched: GWALE A and GWALE B are two
 *            wards, and collapsing them would merge them.
 *   pair  -- exact, then token-set equality, then nearest edit distance,
 *            accepted only when it is close AND the runner-up is clearly
 *            worse. A wrong pairing is worse than a gap: it draws one ward's
 *            reports inside another ward's boundary.
 *
 * Matching is always WITHIN one LGA. Ward names repeat nationally -- a global
 * match would put a Kano ward in Lagos.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = '/home/elrio/hawkeye/tmp/wards';
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

const ROMAN = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9', X: '10' };
const DIR = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST', C: 'CENTRAL' };

/** Spelling-only canonicalisation. Must never merge two distinct wards. */
function canon(s) {
  const t = norm(s).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    let w = t[i];
    // A lone "WARD" carries no identity: "WARD 3" and "3" are the same ward.
    if (w === 'WARD') continue;
    if (ROMAN[w] && t.length > 1) w = ROMAN[w];
    else if (DIR[w] && t.length > 1) w = DIR[w];
    else if (/^0\d+$/.test(w)) w = String(Number(w));
    out.push(w);
  }
  return (out.join(' ') || norm(s)).trim();
}
const tokens = (s) => canon(s).split(' ').filter(Boolean).sort().join(' ');

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Nearest candidate, but only when it is close AND unambiguous. */
function nearest(name, pool, tol) {
  if (!pool.length) return null;
  const scored = pool.map((c) => [c, lev(name, c)]).sort((a, b) => a[1] - b[1]);
  const [best, d] = scored[0];
  const next = scored[1] ? scored[1][1] : Infinity;
  const limit = tol(name);
  return d <= limit && next > d ? best : null;
}

/* ---------------------------------------------------------------- inputs -- */

const reg = JSON.parse(readFileSync(OUT + '/register_wards.json', 'utf8'));
const gj = JSON.parse(readFileSync('/home/elrio/hawkeye/app/nga_wards.geojson', 'utf8'));

const poly = {};          // "STATE|LGA" -> Map(canonical ward -> original ward)
for (const f of gj.features || []) {
  const p = f.properties || {};
  const k = norm(p.s) + '|' + norm(p.l);
  (poly[k] = poly[k] || new Map()).set(canon(p.w), norm(p.w));
}

/* ------------------------------------------------------------- pass 1: LGA */

const byState = {};
for (const k of Object.keys(poly)) {
  const [s, l] = k.split('|');
  (byState[s] = byState[s] || []).push(l);
}
const lgaAlias = {};      // register "STATE|LGA" -> polygon "STATE|LGA"
let rescued = 0;
for (const k of Object.keys(reg)) {
  if (poly[k]) continue;
  const [s, l] = k.split('|');
  const hit = nearest(l, byState[s] || [], (n) => Math.max(3, Math.floor(n.length * 0.35)));
  if (hit) { lgaAlias[k] = s + '|' + hit; rescued++; }
}

/* ------------------------------------------------------- passes 2 and 3 --- */

const map = {};
let paired = 0, exact = 0, tok = 0, join = 0, inside = 0, fuzzy = 0, unpaired = 0;
let lgasFull = 0, lgasPartial = 0, lgasNone = 0;

for (const [k, wardsRaw] of Object.entries(reg)) {
  const want = [...new Set(wardsRaw.map(norm))];
  const src = poly[k] || poly[lgaAlias[k]];
  if (!src) { unpaired += want.length; lgasNone++; continue; }

  const left = new Map(src);          // canonical -> original
  const pairs = {};
  const take = (w, canonKey, bump) => {
    pairs[w] = left.get(canonKey);
    left.delete(canonKey);
    bump();
  };

  for (const w of want) {
    const c = canon(w);
    if (left.has(c)) take(w, c, () => exact++);
  }
  for (const w of want) {
    if (pairs[w]) continue;
    const t = tokens(w);
    const hit = [...left.keys()].find((h) => tokens(h) === t);
    if (hit) take(w, hit, () => tok++);
  }
  /* SPACED VS RUN TOGETHER. The register writes ISSELEAZAGBA and EFFURUNOTOR
     where the polygon file writes ISSELE AZAGBA and EFFURUN OTOR. Identical
     once the spaces go, and nothing else can collide at that length. */
  for (const w of want) {
    if (pairs[w]) continue;
    const flat = canon(w).replace(/ /g, '');
    const hits = [...left.keys()].filter((h) => canon(h).replace(/ /g, '') === flat);
    if (hits.length === 1) take(w, hits[0], () => join++);
  }
  /* ONE NAME INSIDE THE OTHER. The polygon file prefixes a settlement and a
     number onto the ward name (OLOMU 3 EFFURUN OTOR for EFFURUN OTOR), and the
     register appends a second village (DIRBISHI GANDIRA for DIRBISHI). Either
     way one name's words are all present in the other.
     ACCEPTED ONLY WHEN EXACTLY ONE CANDIDATE QUALIFIES: with two, this would
     be a guess, and a guess here draws one ward's reports inside another's
     boundary. Single-word register names are excluded -- "AKWA" is inside far
     too much to mean anything on its own. */
  for (const w of want) {
    if (pairs[w] || !left.size) continue;
    const mine = new Set(canon(w).split(' ').filter(Boolean));
    if (mine.size < 2) continue;
    const hits = [...left.keys()].filter((h) => {
      const his = new Set(canon(h).split(' ').filter(Boolean));
      if (his.size < 2 && mine.size < 2) return false;
      const inHis = [...mine].every((x) => his.has(x));
      const inMine = [...his].every((x) => mine.has(x));
      return inHis || inMine;
    });
    if (hits.length === 1) take(w, hits[0], () => inside++);
  }
  for (const w of want) {
    if (pairs[w] || !left.size) continue;
    const hit = nearest(canon(w), [...left.keys()], (n) => Math.max(2, Math.floor(n.length * 0.25)));
    if (hit) take(w, hit, () => fuzzy++);
  }

  const got = Object.keys(pairs).length;
  paired += got;
  unpaired += want.length - got;
  if (got === want.length) lgasFull++; else if (got) lgasPartial++; else lgasNone++;
  map[k] = pairs;
}

/* ------------------------------------------------------------------ MANUAL
 * A FOURTH PASS THE OTHER THREE CANNOT DO: pairings settled from evidence that
 * is not spelling.
 *
 * The three passes above are right to refuse what they refuse - a wrong pairing
 * draws one ward's reports inside another ward's boundary, and that is worse
 * than a gap. But some wards share no letters at all with their polygon: the
 * register calls one Udu ward "UDU III" and the polygon file calls the same
 * place "OGBE UDU". No edit distance will ever bridge that, and no loosening of
 * a threshold should be allowed to try - doing so would buy these two pairings
 * at the price of wrong ones elsewhere.
 *
 * The answer is in the register itself, one level down: the polling units in a
 * ward name their settlement, and their coordinates fall inside the polygon.
 * That is evidence of a different KIND, so it lives in a file that records it,
 * with its control, rather than in a tuned constant.
 *
 * GUARDED FOUR WAYS, because a hand-written pairing is exactly the thing that
 * should not be trusted quietly:
 *   - it may not overwrite a pairing the automatic passes made;
 *   - the polygon must exist in that LGA;
 *   - the polygon must not already be spoken for;
 *   - it must carry its evidence.
 * Each is a hard failure, not a skip. A manual entry that has silently stopped
 * applying is worse than none, because the file still claims it.
 */
const MANUAL = JSON.parse(readFileSync(
  '/home/elrio/hawkeye/backend/src/data/ward_crosswalk_manual.json', 'utf8',
));
let manual = 0;
for (const [lgaKey, entries] of Object.entries(MANUAL)) {
  if (lgaKey.startsWith('_')) continue;
  const pairs = map[lgaKey];
  if (!pairs) throw new Error(`manual crosswalk: "${lgaKey}" is not an LGA in the register`);
  const src = poly[lgaKey] || poly[lgaAlias[lgaKey]];
  if (!src) throw new Error(`manual crosswalk: "${lgaKey}" has no polygons at all`);
  const originals = new Set([...src.values()].map(norm));
  for (const [regWard, def] of Object.entries(entries)) {
    const target = norm(def.polygon);
    if (pairs[regWard]) {
      throw new Error(`manual crosswalk: ${lgaKey} "${regWard}" was already paired automatically to "${pairs[regWard]}" - drop the manual entry`);
    }
    if (!originals.has(target)) {
      throw new Error(`manual crosswalk: ${lgaKey} has no polygon named "${target}"`);
    }
    if (Object.values(pairs).some((v) => norm(v) === target)) {
      throw new Error(`manual crosswalk: ${lgaKey} polygon "${target}" is already paired to another ward`);
    }
    if (!def.evidence) throw new Error(`manual crosswalk: ${lgaKey} "${regWard}" has no evidence`);
    pairs[regWard] = target;
    manual++;
    paired++;
    unpaired--;
  }
}
console.log('  paired by hand (manual) : ' + manual);

const total = Object.values(reg).reduce((a, w) => a + new Set(w.map(norm)).size, 0);
console.log('register wards: ' + total);
console.log('  LGAs rescued by name    : ' + rescued);
console.log('  paired to a polygon     : ' + paired + '  (' + Math.round((paired / total) * 100) + '%)');
console.log('    exact after canon     : ' + exact);
console.log('    same words, reordered : ' + tok);
console.log('    spaced vs run together: ' + join);
console.log('    one name inside other : ' + inside);
console.log('    near-miss, unambiguous: ' + fuzzy);
console.log('  unpaired                : ' + unpaired);
console.log('LGAs: ' + lgasFull + ' fully paired, ' + lgasPartial + ' partial, ' + lgasNone + ' none');

writeFileSync(OUT + '/ward_crosswalk.json', JSON.stringify({ lgaAlias, wards: map }));
console.log('wrote ' + OUT + '/ward_crosswalk.json');
