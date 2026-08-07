/**
 * Pull the polling-unit code off an OCR'd EC8A sheet.
 *
 * MIRROR: app/pu-code.js — keep the two equivalent, same convention as
 * canonicalPayload in signatures.js. A sheet must resolve to the same unit on
 * both platforms or the ladder means nothing. The full reasoning (why the fixed
 * NN-NN-NN-NNN shape makes this tractable, why the register is the arbiter, why
 * an ambiguous repair returns nothing) lives in that file's header; this is the
 * TypeScript half.
 */

const CONFUSED: Record<string, string> = {
  O: '0', D: '0', Q: '0', I: '1', L: '1', '|': '1', '!': '1', S: '5', B: '8', Z: '2', G: '6', T: '7',
};
const DIGITISH = '0-9OoDdQqIiLl|!SsBbZzGgTt';
const SEP = '[-–—./_\\s]{0,2}';
const RE = new RegExp(
  `(?<![${DIGITISH}])([${DIGITISH}]{2})${SEP}([${DIGITISH}]{2})${SEP}([${DIGITISH}]{2})${SEP}([${DIGITISH}]{3})(?![${DIGITISH}])`,
  'g',
);

const digits = (s: string) =>
  s.toUpperCase().split('').map((c) => (/[0-9]/.test(c) ? c : (CONFUSED[c] ?? ''))).join('');

/** Canonical NN-NN-NN-NNN, or null if this cannot be one. */
export function normalizeCode(raw: string): string | null {
  const g = String(raw || '').match(/[^\W_]+/g);
  if (!g) return null;
  const d = digits(g.join(''));
  if (d.length !== 9) return null;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}

/**
 * THE CODE IS NOT PRINTED AS ONE STRING. A real EC8A carries it as four
 * separately labelled boxes, on four different lines, with the unit's name in
 * between:
 *
 *   State ............ FCT       Code [3][7]
 *   Area Council ..... KWALI     Code [0][5]
 *   Registration Area  KILANKWA  Code [0][4]
 *   Polling Unit ..... SHEDA…    Code [0][2][7]
 *
 * The first version hunted a contiguous NN-NN-NN-NNN run, so on a real sheet it
 * matched nothing and the whole tier was inert. Found by reading an actual IReV
 * sheet (37-05-04-027), not the invented strings the tests used.
 */
const FIELDS: { key: string; n: number; re: RegExp }[] = [
  { key: 'state', n: 2, re: /\bSTATE\b/ },
  { key: 'lga', n: 2, re: /AREA\s*COUNCIL|LOCAL\s*GOVERNMENT|\bL\.?G\.?A\.?\b/ },
  { key: 'ward', n: 2, re: /REGISTRATION\s*AREA|\bWARD\b/ },
  { key: 'pu', n: 3, re: /POLLING\s*UNIT/ },
];

/**
 * Digits immediately after "Code" on one line. Stops at the first token that is
 * not a pure digit box, which keeps the S/N field out: OCR readily joins columns
 * into "...Code 3 7 S/N 0000111", and swallowing that yields a nine-digit run
 * that shape-validates as a plausible, completely wrong code.
 */
function codeDigitsAfter(line: string, want: number): string | null {
  const m = /\bC[O0]DE\b/i.exec(line);
  if (!m) return null;
  const rest = line.slice(m.index + m[0].length);
  let d = '';
  for (const tok of rest.split(/[\s.:_|]+/)) {
    if (!tok) continue;
    const t = digits(tok);
    if (!t || t.length !== tok.length) break;
    d += t;
    if (d.length >= want) break;
  }
  return d ? d.slice(0, want) : null;
}

/** Every shape-valid candidate in the recognised text, best first. */
export function extractCandidates(text: string): string[] {
  const out: string[] = [];
  const add = (c: string | null) => { if (c && !out.includes(c)) out.push(c); };

  const lines = String(text || '').split(/\r?\n/);
  const got: Record<string, string> = {};
  const loose: string[] = [];
  for (const ln of lines) {
    const U = ln.toUpperCase();
    const f = FIELDS.find((x) => x.re.test(U));
    const d = codeDigitsAfter(ln, f ? f.n : 3);
    if (d == null) continue;
    if (f && d.length === f.n) { if (!got[f.key]) got[f.key] = d; }
    else loose.push(d);
  }
  if (got.state && got.lga && got.ward && got.pu) {
    add(normalizeCode(got.state + got.lga + got.ward + got.pu));
  } else if (!Object.keys(got).length && loose.length >= 4) {
    // Labels unreadable but four Code boxes found — field order on the form is
    // fixed, so positional assembly is a fair second guess, and it is still
    // register-checked, so a bad guess simply resolves to nothing.
    add(normalizeCode(loose[0].slice(0, 2) + loose[1].slice(0, 2) + loose[2].slice(0, 2) + loose[3].slice(0, 3)));
  }

  // Contiguous NN-NN-NN-NNN, for wherever the code is written out in full.
  for (const m of String(text || '').matchAll(RE)) {
    add(normalizeCode(m[1] + m[2] + m[3] + m[4]));
  }
  return out;
}

/** Single-substitution repairs only — see the mirror's note on why not wider. */
export function repairs(code: string): string[] {
  const bare = code.replace(/-/g, '');
  const out: string[] = [];
  for (let i = 0; i < bare.length; i++) {
    for (const d of '0123456789') {
      if (d === bare[i]) continue;
      const b = bare.slice(0, i) + d + bare.slice(i + 1);
      out.push(`${b.slice(0, 2)}-${b.slice(2, 4)}-${b.slice(4, 6)}-${b.slice(6)}`);
    }
  }
  return out;
}

const norm = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export type ResolvedUnit = {
  code: string;
  unit: { name?: string; lat?: number | null; lng?: number | null; crowd_lat?: number | null; crowd_lng?: number | null };
  source: 'exact' | 'repaired';
  nameMatch: boolean;
  gpsAgrees: boolean | null;
  confidence: 'high' | 'low';
};

function distM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function finish(
  unit: ResolvedUnit['unit'], code: string, source: 'exact' | 'repaired',
  textNorm: string, fix?: { lat: number; lng: number },
): ResolvedUnit {
  const nameMatch = norm(unit.name ?? '').split(' ').filter((w) => w.length > 3)
    .some((w) => textNorm.includes(w));
  // GPS may only VETO, never pick: a code read off a sheet that did not come
  // from here is perfectly real and simply not yours, and distance is the only
  // signal that can see that.
  let gpsAgrees: boolean | null = null;
  const uLat = unit.lat ?? unit.crowd_lat, uLng = unit.lng ?? unit.crowd_lng;
  if (fix && typeof uLat === 'number' && typeof uLng === 'number') {
    gpsAgrees = distM(fix.lat, fix.lng, uLat, uLng) <= 5000;
  }
  const confidence: 'high' | 'low' =
    (source === 'exact' || nameMatch) && gpsAgrees !== false ? 'high' : 'low';
  return { code, unit, source, nameMatch, gpsAgrees, confidence };
}

export async function resolveUnitFromText(
  text: string,
  opts: {
    resolve: (code: string) => Promise<ResolvedUnit['unit'] | null>;
    fix?: { lat: number; lng: number };
    maxRepair?: number;
  },
): Promise<ResolvedUnit | null> {
  // maxRepair defaults to the FULL single-substitution space (9 positions x 9
  // digits). Uniqueness cannot be established from a partial sweep: a hit found
  // early would be declared unique while a second sat unprobed past the cap —
  // a wrong unit, not a missed one. Hitting the ceiling abandons the candidate.
  // Keep `resolve` cheap (the cached near-me slice), not 81 network round trips.
  const { resolve, fix, maxRepair = 81 } = opts;
  if (typeof resolve !== 'function') return null;
  const cands = extractCandidates(text);
  const t = norm(text);

  for (const c of cands) {
    const u = await resolve(c);
    if (u) return finish(u, c, 'exact', t, fix);
  }
  for (const c of cands) {
    const all = repairs(c);
    if (all.length > maxRepair) continue; // cannot prove uniqueness; do not guess
    const hits: [ResolvedUnit['unit'], string][] = [];
    for (const r of all) {
      const u = await resolve(r);
      if (u) {
        hits.push([u, r]);
        if (hits.length > 1) break; // ambiguous — an unreadable sheet, not a tie
      }
    }
    if (hits.length === 1) return finish(hits[0][0], hits[0][1], 'repaired', t, fix);
  }
  return null;
}
