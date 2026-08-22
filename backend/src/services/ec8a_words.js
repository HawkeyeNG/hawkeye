/**
 * EC8A figures-vs-words cross-check.
 *
 * WHY THIS EXISTS. Every EC8A requires the presiding officer to write each
 * party's score TWICE — once in figures, once in words ("308" / "THREE HUNDRED
 * AND EIGHT"). That redundancy is a verifier sitting on the sheet itself: it
 * needs no second OCR engine, no ground-truth labels, and no model we have to
 * trust. Where figures and words agree, two independent handwritings of the
 * same number were read consistently, and the read is worth far more than any
 * single-engine confidence score. Where they disagree, the sheet goes to a
 * human — the disagreement is the finding, whether its cause is a misread or a
 * genuinely inconsistent sheet.
 *
 * This does NOT assert that a count is correct. It reports agreement,
 * disagreement, or unreadable, and the unreadable bucket stays explicit.
 *
 * GEOMETRY, NOT READING ORDER. PaddleOCR returns boxes in an order that does
 * not follow table rows — a real sheet gave ["ADC","THREE","4","3"] for a row
 * whose figure is 3. Pairing on token order binds parties to the wrong number
 * and would be worse than no check at all, so rows are rebuilt from box
 * y-centres and columns from x-position.
 */

const PARTIES = [
  'A', 'AA', 'AAC', 'ADC', 'ADP', 'APC', 'APGA', 'APM', 'APP', 'BP', 'LP',
  'NNPP', 'NRM', 'PDP', 'PRP', 'SDP', 'YPP', 'ZLP',
];

const UNITS = {
  ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7,
  EIGHT: 8, NINE: 9, TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13,
  FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16, SEVENTEEN: 17, EIGHTEEN: 18,
  NINETEEN: 19,
};
const TENS = {
  TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60, SEVENTY: 70,
  EIGHTY: 80, NINETY: 90,
};
const SCALES = { HUNDRED: 100, THOUSAND: 1000 };
const VOCAB = [...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALES), 'AND'];
// NIL and NILL appear in the words column as often as ZERO on these sheets.
const NIL_WORDS = new Set(['NIL', 'NILL', 'NILE', 'NILS']);

/**
 * Handwriting OCR confuses letters with digits constantly — real observed
 * spellings of ZERO on these sheets include "-2ERD", "26R0-", "ZORO-", "2BRO".
 * Fold digits back to the letters they were misread from before matching.
 */
function normaliseWord(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/[0]/g, 'O').replace(/[1]/g, 'I').replace(/[2]/g, 'Z')
    .replace(/[3]/g, 'E').replace(/[4]/g, 'A').replace(/[5]/g, 'S')
    .replace(/[6]/g, 'G').replace(/[8]/g, 'B')
    .replace(/[^A-Z]/g, '');
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
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

/** Snap a noisy token to the nearest number word, or null if nothing is close. */
function snapWord(raw) {
  const w = normaliseWord(raw);
  if (!w) return null;
  if (VOCAB.includes(w)) return w;
  // Tolerance scales with length: short words must be near-exact or "ONE"
  // swallows every three-letter smudge on the sheet.
  const budget = w.length <= 3 ? 1 : (w.length <= 6 ? 2 : 3);
  let best = null, bestD = Infinity;
  for (const cand of VOCAB) {
    if (Math.abs(cand.length - w.length) > budget) continue;
    const d = editDistance(w, cand);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return bestD <= budget ? best : null;
}

/**
 * Parse an English number phrase to an integer. Returns null when the phrase
 * carries no recognisable number word — silence is better than a guess here.
 */
export function wordsToNumber(phrase) {
  if (NIL_WORDS.has(normaliseWord(phrase))) return 0;
  const words = String(phrase).split(/[\s-]+/).map(snapWord).filter(Boolean);
  if (!words.length) return null;
  let total = 0, current = 0, seen = false;
  for (const w of words) {
    if (w === 'AND') continue;
    if (w in UNITS) { current += UNITS[w]; seen = true; continue; }
    if (w in TENS) { current += TENS[w]; seen = true; continue; }
    if (w === 'HUNDRED') { current = (current || 1) * 100; seen = true; continue; }
    if (w === 'THOUSAND') { total += (current || 1) * 1000; current = 0; seen = true; continue; }
  }
  return seen ? total + current : null;
}

/**
 * Read the figures cell.
 *
 * A lone "O" is the commonest single cause of a lost row: officers write the
 * zero as a letter and OCR reports it faithfully, so a digits-only rule scores
 * most of a clean sheet unreadable. A mark on the paper that can only mean zero
 * is read as zero. An ABSENT token still returns null — we never invent a
 * figure for a cell nothing was read from.
 */
export function figuresOf(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (/^NIL+$/i.test(s.replace(/[^A-Za-z]/g, ""))) return 0;   // officers write NIL / NILL for zero
  if (/^[\s\-—–_.]*[Oo0][\s\-—–_.]*$/.test(s)) return 0;   // "O", "0", "-0-", "—O—"
  const m = s.match(/\d+/g);
  if (!m) return null;
  const joined = m.join('');
  if (joined.length > 6) return null;      // a run that long is table furniture
  return parseInt(joined, 10);
}

/**
 * Snap to a party code. AMBIGUITY REJECTS: "AP1" normalises to "API", which is
 * one edit from APC, APP and APM alike — picking the first would bind a real
 * row of figures to an arbitrary party, which is worse than dropping the row.
 */
function partyOf(raw) {
  const w = normaliseWord(raw);
  if (!w || w.length > 5) return null;
  if (PARTIES.includes(w)) return w;
  const near = PARTIES.filter((p) => p.length >= 3 && editDistance(w, p) === 1);
  return near.length === 1 ? near[0] : null;
}

/**
 * Rebuild table rows from box geometry. Tokens whose vertical centres fall
 * within `tol` of each other belong to the same row; within a row they are
 * ordered left-to-right.
 */
function groupRows(tokens, tol) {
  const withBox = tokens.filter((t) => t.box);
  const rows = [];
  for (const t of withBox.slice().sort((a, b) => a.cy - b.cy)) {
    const row = rows[rows.length - 1];
    // Compare against the row's ANCHOR, never a running mean. A mean drifts
    // downward as each token joins, so on a dense table one row swallows the
    // next and the next — observed as "APC 148 / APM 0" beside "APM 0 / 48",
    // i.e. one officer's 148 torn across two parties. A fixed anchor cannot
    // chain: a token is either within tol of where the row started, or it
    // opens a new row.
    if (row && Math.abs(t.cy - row.anchor) <= tol) {
      row.items.push(t);
    } else {
      rows.push({ anchor: t.cy, items: [t] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.cx - b.cx);
  return rows;
}

/**
 * Cross-check one sheet.
 *
 * @param {string[]} texts  rec_texts from paddle_worker
 * @param {Array<number[]|null>} boxes  matching rec_boxes ([x1,y1,x2,y2])
 * @returns {{rows: Array, agree: number, disagree: number, unreadable: number, checked: number}}
 */
/**
 * Locate the three column centres from the printed table headers.
 *
 * The headers are PRINTED, not handwritten, so OCR reads them reliably even
 * when every figure below them is a scrawl — which makes them a far better
 * anchor than anything derived from the data. Returns null if the sheet is too
 * damaged to find them, and the caller then reports nothing rather than
 * guessing a layout.
 */
function columnCentres(tokens) {
  const find = (re) => {
    const hit = tokens.filter((t) => t.box && re.test(String(t.text).toUpperCase()));
    if (!hit.length) return null;
    const t = hit.sort((a, b) => a.cy - b.cy)[0];   // topmost match = the header
    return t.cx;
  };
  const figures = find(/\bFIGURES?\b/);
  const words = find(/\bWORDS?\b/);
  const party = find(/\bPARTY\b/);
  if (figures === null || words === null) return null;
  return { party: party === null ? figures - (words - figures) : party, figures, words };
}

/** Nearest column centre, or null when the token sits outside all of them. */
function columnOf(cx, cols) {
  const gaps = [Math.abs(cols.figures - cols.party), Math.abs(cols.words - cols.figures)];
  const limit = Math.min(...gaps) * 0.55;
  let best = null, bestD = Infinity;
  for (const name of ['party', 'figures', 'words']) {
    const d = Math.abs(cx - cols[name]);
    if (d < bestD) { bestD = d; best = name; }
  }
  return bestD <= limit ? best : null;
}

export function crossCheckSheet(texts, boxes) {
  const tokens = texts.map((t, i) => {
    const b = boxes && boxes[i];
    return b ? { text: t, box: b, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, h: b[3] - b[1] } : { text: t, box: null };
  }).filter((t) => t.box);

  if (!tokens.length) return { rows: [], agree: 0, disagree: 0, unreadable: 0, checked: 0, note: 'no geometry' };
  const cols = columnCentres(tokens);
  if (!cols) return { rows: [], agree: 0, disagree: 0, unreadable: 0, checked: 0, note: 'headers not found' };

  // COLUMN FIRST, ROW SECOND. Routing by content ("does this token contain a
  // digit?") reads the officer's letter-O zero as a word and loses the figures
  // cell entirely. Where a token SITS decides what it is; what it says only
  // decides how to parse it.
  const inCol = { party: [], figures: [], words: [] };
  for (const t of tokens) {
    const c = columnOf(t.cx, cols);
    if (c) inCol[c].push(t);
  }

  const partyRows = inCol.party
    .map((t) => ({ party: partyOf(t.text), cy: t.cy }))
    .filter((r) => r.party)
    .sort((a, b) => a.cy - b.cy);
  if (!partyRows.length) return { rows: [], agree: 0, disagree: 0, unreadable: 0, checked: 0, note: 'no party rows' };

  // Row pitch from the party column itself — no magic constant survives a
  // different scan resolution, but the gap between consecutive parties does.
  const gaps = partyRows.slice(1).map((r, i) => r.cy - partyRows[i].cy).filter((g) => g > 1).sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 40;
  const window = pitch * 0.5;

  /**
   * MUTUAL NEAREST. Letting every row grab its closest token independently
   * lets one row steal its neighbour's cell, which showed up as the tell-tale
   * pair "ADC figures=1 words=0" directly above "ADP figures=0 words=1" — one
   * row's values slid onto the row above. Binding each token to its OWN
   * nearest party row first means a token belongs to exactly one row, so a
   * shift produces an honest `unreadable` instead of two false mismatches.
   */
  const assign = (list) => {
    const byRow = new Map();
    for (const t of list) {
      let best = null, bestD = Infinity;
      for (const r of partyRows) {
        const d = Math.abs(t.cy - r.cy);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (!best || bestD > window) continue;
      if (!byRow.has(best)) byRow.set(best, []);
      byRow.get(best).push(t);
    }
    for (const arr of byRow.values()) arr.sort((a, b) => a.cx - b.cx);
    return byRow;
  };
  const figByRow = assign(inCol.figures);
  const wordByRow = assign(inCol.words);

  const out = [];
  for (const row of partyRows) {
    const figTokens = figByRow.get(row) || [];
    const wordTokens = wordByRow.get(row) || [];

    let figures = null;
    for (const t of figTokens) { const f = figuresOf(t.text); if (f !== null) { figures = f; break; } }
    // Join before parsing: phrases split across boxes ("THREE" | "HUNDRED" |
    // "AND" | "EIGHT") must compose to 308, not 3.
    const words = wordTokens.length ? wordsToNumber(wordTokens.map((t) => t.text).join(' ')) : null;

    const status = (figures === null || words === null) ? 'unreadable'
      : (figures === words ? 'agree' : 'disagree');
    out.push({ party: row.party, figures, words, status });
  }

  return {
    rows: out,
    checked: out.length,
    agree: out.filter((r) => r.status === 'agree').length,
    disagree: out.filter((r) => r.status === 'disagree').length,
    unreadable: out.filter((r) => r.status === 'unreadable').length,
  };
}
