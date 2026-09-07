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
/**
 * The digits, on their own. Not every presiding officer writes the words cell
 * as a place-value phrase: "130" is written "ONE THREE ZERO" as readily as
 * "ONE HUNDRED AND THIRTY", and both are correct completions of the form.
 * TEN..NINETEEN are deliberately absent — a digit spelling never uses them.
 */
const DIGIT_WORDS = {
  ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4,
  FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9,
};
const VOCAB = [...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALES), 'AND'];
// NIL and NILL appear in the words column as often as ZERO on these sheets.
// NONE BELONGS HERE, AND ITS ABSENCE WAS A LIVE BUG. "NONE" is one edit from
// "ONE", so a cell meaning ZERO was read as 1 — measured on ~20 cells in the
// Osun corpus, several of which then agreed with a figures cell of 0 only by
// failing to. A word meaning nothing must resolve before any fuzzy matching.
const NIL_WORDS = new Set(['NIL', 'NILL', 'NILE', 'NILS', 'NONE', 'NONES', 'NON']);

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
  let bestD = Infinity, best = [];
  for (const cand of VOCAB) {
    if (Math.abs(cand.length - w.length) > budget) continue;
    const d = editDistance(w, cand);
    if (d < bestD) { bestD = d; best = [cand]; }
    else if (d === bestD) best.push(cand);
  }
  if (bestD > budget || !best.length) return null;
  if (best.length === 1) return { word: best[0], d: bestD };
  // AN AMBIGUOUS SMUDGE IS NOT A WORD. Two vocabulary entries at the same edit
  // distance give no basis for choosing, and the wrong choice does not fail
  // loudly — it becomes a confident number that agrees or disagrees with the
  // figures cell on its own account. Hand the tie back for the caller to
  // resolve with the rest of the phrase in view; it has context this does not.
  return { tie: best };
}

/**
 * Parse an English number phrase to an integer. Returns null when the phrase
 * carries no recognisable number word — silence is better than a guess here.
 */
export function wordsToNumber(phrase) {
  if (NIL_WORDS.has(normaliseWord(phrase))) return 0;
  const raw = String(phrase).split(/[\s-]+/);
  // Punctuation-only tokens ("&", a stray dash) normalise to nothing. They are
  // not failed reads and must not count against the phrase — officers write
  // "ONE HUNDRED & SEVENTY TWO" and that is a clean sheet, not a doubtful one.
  const meaningful = raw.filter((t) => normaliseWord(t).length > 0);

  // Resolve ties with the whole phrase in view. The only tie that occurs in the
  // corpus is 'OND', one edit from BOTH 'ONE' and 'AND', and its correct
  // reading depends entirely on position:
  //   lone cell  ['—OND', 1]                       — 'AND' carries no count, so
  //                                                  the cell can only be ONE
  //   mid-phrase 'CNE HUNDRED AHD FORTH HIREE'     — here the garbled token IS
  //                                                  the connector, and reading
  //                                                  it as ONE would silently
  //                                                  add 1 to a party's total
  // So: prefer the connector when other value words are present, prefer the
  // value word when the cell has nothing else in it. A value-versus-value tie
  // is never resolved — that one stays refused.
  const snaps = meaningful.map(snapWord);

  // A FUZZY MATCH NEEDS AN ANCHOR. "QWERTY ZXCV" used to return a confident 20,
  // because QWERTY is two substitutions from TWENTY and that sits inside the
  // length-6 budget. What separates it from "NINTI FIVE" (a real 95) is not how
  // far the words are from the vocabulary — both are 2 — but whether anything
  // ELSE in the cell was read exactly. FIVE anchors NINTI; nothing anchors
  // QWERTY. So in a multi-word cell a fuzzy reading is trusted only alongside
  // an exact one.
  //
  // A LONE token is exempt, because it has nothing to be anchored by and the
  // corpus is full of legitimate single-token smudges: '—ONE——', 'GONE',
  // '-2ERD', 's1x'. Refusing those would throw away real rows to catch a case
  // that needs two words to occur.
  //
  // Rejected the obvious alternative — requiring a majority of tokens to snap —
  // after running it over the corpus: it discarded "FIFTY VOTES" (50, agreeing
  // with the figures) and "NIL ZERO" (0, likewise), because one token was a
  // word the vocabulary has no reason to contain. Ten genuine corroborations
  // lost to catch thirty bad ones is the wrong trade.
  const hasExact = snaps.some((s) => typeof s === 'string');
  const lone = meaningful.length === 1;
  const trust = (s) => (typeof s === 'string' ? s
    : (hasExact || lone ? s.word : null));

  const provisional = snaps.map((s) => (typeof s === 'string' || (s && s.word) ? s : null));
  const hasValue = provisional.some((s) => {
    const w = typeof s === 'string' ? s : s?.word;
    return w && w !== 'AND';
  });

  const words = snaps.map((s) => {
    if (typeof s === 'string') return s;
    if (!s) return null;
    if (s.word) return trust(s);
    if (!s.tie) return null;
    // 'OND' sits one edit from BOTH 'ONE' and 'AND'. Position decides: in a lone
    // cell it can only be the value (['—OND', 1] in the corpus), but mid-phrase
    // it is the connector, and reading it as ONE would silently add 1 to a
    // party's total. A value-versus-value tie is never resolved.
    const values = s.tie.filter((c) => c !== 'AND');
    if (s.tie.includes('AND') && values.length === 1) {
      const picked = hasValue ? 'AND' : values[0];
      return picked === 'AND' ? 'AND' : (hasExact || lone ? picked : null);
    }
    // A UNIT AGAINST ITS OWN TENS FORM RESOLVES TO THE UNIT. Every tens word is
    // its unit plus a suffix, so a dropped or smudged tail puts 'NINEY' exactly
    // one edit from both NINE and NINETY, and 'EIGHTE' from both EIGHT and
    // EIGHTY. Refusing these cost real rows: 'NINEY-ONE' (figures 91) and
    // 'TWO ONE EIGHTE' (figures 218) both read correctly once the unit is
    // chosen, because the digit-by-digit grammar above then takes them — and
    // it is the conservative choice, since the unit is the smaller magnitude.
    const units = s.tie.filter((c) => c in UNITS);
    const tens = s.tie.filter((c) => c in TENS);
    if (s.tie.length === 2 && units.length === 1 && tens.length === 1) {
      return hasExact || lone ? units[0] : null;
    }
    return null;
  }).filter(Boolean);
  if (!words.length) return null;

  // DIGIT-BY-DIGIT FIRST. Some officers spell the count out one digit at a
  // time. Read as a place-value phrase, "ONE THREE ZERO" sums to 4 and "NINE
  // FIVE SIX" to 20 — so a correctly filled sheet was being reported as a
  // figures-vs-words DISAGREEMENT. That is worse than missing the row: it
  // manufactures a finding against an officer who did nothing wrong, and sends
  // a clean sheet to a human to adjudicate a fault that is ours.
  //
  // Applied only when EVERY token is a single-digit word AND there are at least
  // two of them. There is no English reading of "ONE THREE ZERO" that means 4,
  // while a lone "THREE" is just three and must stay three. "THIRTEEN" is not
  // in DIGIT_WORDS, so a real place-value phrase cannot be captured by mistake.
  const digitTokens = words.filter((w) => w !== 'AND');
  if (digitTokens.length >= 2 && digitTokens.every((w) => w in DIGIT_WORDS)) {
    const joined = digitTokens.map((w) => DIGIT_WORDS[w]).join('');
    // Same ceiling figuresOf() uses: a run that long is table furniture, not a
    // count, and a polling unit cannot have a million votes.
    return joined.length > 6 ? null : Number(joined);
  }

  // HUNDREDS WITHOUT THE WORD "HUNDRED". A third grammar, and the one that
  // reads most like speech: "172" written "ONE SEVENTY TWO". Read as a plain
  // sum that is 1 + 70 + 2 = 73, so a correct sheet became a disagreement the
  // same way digit spellings did.
  //
  // The shape is narrow on purpose: a single digit 1-9, then a TENS or teen
  // word, then at most one more unit — and no scale word anywhere, because
  // "ONE HUNDRED AND SEVENTY TWO" must keep its own reading. "TWENTY ONE"
  // starts with a TENS word and is untouched; "ONE HUNDRED" has a scale and is
  // untouched. Capped at 9xx, which is what this grammar can express.
  //
  // A TEEN MAY NOT FILL THE TENS SLOT, and this was measured rather than
  // guessed. "NINE TEEN" is not 910 — it is OCR splitting NINETEEN, and the
  // figures on those rows say 19. Across the corpus the teen shape scored 6
  // right against 18 where neither reading matched, so it is refused outright.
  // The TENS shape scored 233-0 on three tokens and 31-4 on two.
  if (digitTokens.length >= 2 && digitTokens.length <= 3
      && digitTokens[0] in DIGIT_WORDS && DIGIT_WORDS[digitTokens[0]] > 0
      && digitTokens[1] in TENS
      && !digitTokens.some((w) => w in SCALES)) {
    const rest = digitTokens.slice(1);
    // TENS, then at most one unit under ten. Anything else is not this grammar.
    const tail = rest.length === 1
      ? TENS[rest[0]]
      : (rest.length === 2 && rest[1] in UNITS && UNITS[rest[1]] < 10
        ? TENS[rest[0]] + UNITS[rest[1]]
        : null);
    if (tail !== null) return DIGIT_WORDS[digitTokens[0]] * 100 + tail;
  }

  let total = 0, current = 0, seen = false, hundreds = 0;
  for (const w of words) {
    if (w === 'AND') continue;
    if (w in UNITS) { current += UNITS[w]; seen = true; continue; }
    if (w in TENS) { current += TENS[w]; seen = true; continue; }
    if (w === 'HUNDRED') {
      // A SCALE WORD CANNOT REPEAT INSIDE ONE GROUP. "HUNDRED HUNDRED HUNDRED"
      // compounded silently to 1,000,000 — each pass multiplying the last. No
      // officer writes that; it is OCR reading a ruled line three times.
      // THOUSAND opens a fresh group, so "ONE THOUSAND TWO HUNDRED" is fine.
      if (++hundreds > 1) return null;
      current = (current || 1) * 100; seen = true; continue;
    }
    if (w === 'THOUSAND') {
      total += (current || 1) * 1000; current = 0; hundreds = 0; seen = true; continue;
    }
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
