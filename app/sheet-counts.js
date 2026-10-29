/* Party counts off a recognised EC8A sheet, for the website and Hawkeye Lite.
 *
 * GENERATED from native/src/lib/sheet-counts.ts by scripts/gen_sheet_counts_web.mjs
 * (the same code with the types stripped). Do not edit this copy: change the
 * TypeScript and regenerate. tests/sheet_counts_test.mjs fails if this file is
 * stale, and runs every check against BOTH copies, so a sheet pre-fills the same
 * way in the app, in Lite and on the website. The reasoning, the history and
 * the rules are documented in the TypeScript.
 *
 * Exposes window.HAWKEYE_SHEETCOUNTS.parseCounts(text, partyCodes, lines), where
 * lines are {text, left, right, top, bottom} in pixels, origin top-left.
 */
(function () {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * "Party A" matches "Party A", "PARTY A" and "PartyA"; "APC" matches "APC" but
   * never "APCX" or "XAPC" — a code counts only where it is not part of a longer
   * word, because codes are short and collide with ordinary text on the form.
   */
  function codePattern(code) {
    const words = code.trim().split(/\s+/).map(escapeRe);
    // A one- or two-letter code must be in capitals, as the form prints it: OCR
    // noise is full of stray lowercase "a"s, and one of them once became Accord.
    const exact = words.length === 1 && code.trim().length <= 2;
    return new RegExp(`(?:^|[^A-Za-z0-9])${words.join('[\\s.:-]*')}(?![A-Za-z0-9])`, exact ? '' : 'i');
  }

  /**
   * A code labels a row only where it starts the line: nothing before it but the
   * row's S/N ("3", "1O", "|"). The same letters inside a heading, an address or
   * a line of noise ("Registration Area … a #2 | Number of …") label nothing.
   */
  const startsRow = (before) =>
    before.split(/[^A-Za-z0-9]+/).filter(Boolean).every((t) => /^[0-9OoIl]{1,3}$/.test(t));

  /** The two misreads worth repairing, nothing riskier: "1OO" → "100", "1,204" → "1204". */
  function repairDigits(s) {
    return s
      .replace(/[Oo](?=\d)/g, '0')
      .replace(/(\d)[Oo]/g, (_, d) => `${d}0`)
      .replace(/(\d)[Oo]/g, (_, d) => `${d}0`)
      .replace(/(\d)[.,](?=\d{3}\b)/g, '$1');
  }

  /** 1–6 digits is a tally; anything longer is a serial, a phone number or a code. */
  const tally = (digits) => (digits.length <= 6 ? Number(digits) : null);

  /** The first whole number in a string, and the text after it. "#2" is an item number, not a count. */
  function firstNumber(s) {
    const r = repairDigits(s);
    const m = r.match(/(?:^|[^A-Za-z0-9#])(\d+)(?![A-Za-z0-9])/);
    return m ? { n: tally(m[1]), after: r.slice((m.index ?? 0) + m[0].length) } : { n: null, after: s };
  }

  /** A line that STARTS with a whole number: "42", "42.", "42 FORTY-TWO". Not "2ERO", not "#8". */
  function leadingNumber(s) {
    const m = repairDigits(s).match(/^[\s|(]*(\d+)(?![A-Za-z0-9])/);
    return m ? tally(m[1]) : null;
  }

  // ── number words ─────────────────────────────────────────────────────────────

  const UNITS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9 };
  const TEENS = {
    TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13, FOURTEEN: 14,
    FIFTEEN: 15, SIXTEEN: 16, SEVENTEEN: 17, EIGHTEEN: 18, NINETEEN: 19,
  };
  const TENS = {
    TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60, SEVENTY: 70, EIGHTY: 80, NINETY: 90,
  };
  /** NONE is a zero on these forms, not a misread ONE. */
  const ZEROS = new Set(['ZERO', 'NIL', 'NONE']);
  const VOCAB = [...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...ZEROS, 'HUNDRED', 'THOUSAND', 'AND'];
  /** Digits a handwritten word gets misread as ("2ERO", "s1x", "ZER0"). */
  const AS_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };

  function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * One handwritten token → a number word. Exact if it reads as one untouched;
   * otherwise the nearest within a budget that grows with length (none for two
   * letters, so "T0" — a misread 90 — never becomes TWO). Two equally near words
   * are a tie, decided by the phrase, never by guessing.
   */
  function snap(token) {
    const t = token.toUpperCase().replace(/\d/g, (d) => AS_LETTER[d] ?? d).replace(/[^A-Z]/g, '');
    if (!t) return null;
    if (VOCAB.includes(t)) return { word: t, exact: !/\d/.test(token) };
    const budget = t.length <= 2 ? 0 : t.length <= 5 ? 1 : 2;
    let best = budget + 1;
    let near = [];
    for (const v of VOCAB) {
      const d = editDistance(t, v);
      if (d < best) { best = d; near = [v]; } else if (d === best) near.push(v);
    }
    if (best > budget) return null;
    return near.length === 1 ? { word: near[0], exact: false } : { tie: near };
  }

  /** The long form only: "ONE THOUSAND TWO HUNDRED AND FOUR", "FORTY TWO", "ZERO". */
  function wordsToNumber(words) {
    if (words.every((w) => ZEROS.has(w))) return 0;
    let total = 0;
    let cur = 0;
    let last = '';
    for (const w of words) {
      if (ZEROS.has(w)) return null;
      if (w === 'AND') {
        if (last !== 'hundred' && last !== 'thousand') return null;
        last = 'and';
      } else if (w in UNITS) {
        if (last === 'unit' || last === 'teen') return null;
        cur += UNITS[w]; last = 'unit';
      } else if (w in TEENS) {
        if (last === 'unit' || last === 'teen' || last === 'tens') return null;
        cur += TEENS[w]; last = 'teen';
      } else if (w in TENS) {
        if (last === 'unit' || last === 'teen' || last === 'tens') return null;
        cur += TENS[w]; last = 'tens';
      } else if (w === 'HUNDRED') {
        if (last !== 'unit' || cur > 9) return null;
        cur *= 100; last = 'hundred';
      } else if (w === 'THOUSAND') {
        if (cur < 1 || cur > 999 || total) return null;
        total = cur * 1000; cur = 0; last = 'thousand';
      }
    }
    return last === 'and' || last === '' ? null : total + cur;
  }

  /**
   * Read a words cell. `wordy` says the text is number words at all (one token
   * snapped), so an agent's name is not mistaken for a garbled count; `value` is
   * the number, or null when it is number words that do not add up — which then
   * blocks the figure too, because the cell disagrees with itself.
   *
   * A fuzzy reading counts only beside a token read exactly ("NINTI FIVE" is 95,
   * "QWERTY ZXCV" is nothing); a lone smudged token ("ZERD", "SEVENTERN") is
   * allowed, as such cells are common and mean what they look like.
   */
  function readWords(text) {
    const tokens = text.split(/[^A-Za-z0-9]+/).filter((t) => /[A-Za-z]/.test(t));
    const snaps = tokens.map(snap);
    if (!snaps.some((s) => s && 'word' in s)) return { wordy: false, value: null };
    const hasValue = snaps.some((s) => s && 'word' in s && s.word !== 'AND');
    const words = [];
    for (const s of snaps) {
      if (!s) return { wordy: true, value: null };
      if ('tie' in s) {
        // "OND" mid-phrase is AND: reading it as ONE would silently add 1.
        if (s.tie.includes('AND') && hasValue) { words.push('AND'); continue; }
        return { wordy: true, value: null };
      }
      words.push(s.word);
    }
    const anchored = words.length === 1 || snaps.some((s) => s && 'word' in s && s.exact);
    return { wordy: true, value: anchored ? wordsToNumber(words) : null };
  }

  // ── geometry ─────────────────────────────────────────────────────────────────

  const mid = (b) => (b.top + b.bottom) / 2;

  function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /** Share of a line's width that falls inside [left, right]. */
  function inside(b, left, right) {
    return Math.max(0, Math.min(b.right, right) - Math.max(b.left, left)) / Math.max(1, b.right - b.left);
  }

  /**
   * Pull party counts out of a recognised sheet.
   *
   * `lines` is the reader's own line geometry. Without it — a reader that returned
   * no boxes — only the same-line rule runs, on the text's lines.
   * Keys are the codes exactly as given, so callers can index their own fields.
   */
  function parseCounts(text, partyCodes, lines = []) {
    const rows = lines.length
      ? lines.map((box) => ({ text: box.text, box }))
      : text.split(/\r?\n/).map((t) => ({ text: t }));
    const codes = [...new Set(partyCodes.filter((c) => c.trim()))];
    const figure = {};
    const words = {};
    const labelled = new Map();

    // 1. Same line. The first read per party wins, so a repeated header row
    //    cannot overwrite a real one.
    for (const code of codes) {
      const re = codePattern(code);
      for (const row of rows) {
        const m = re.exec(row.text);
        if (!m) continue;
        const at = m.index + (/^[^A-Za-z0-9]/.test(m[0]) ? 1 : 0); // where the code itself starts
        if (!startsRow(row.text.slice(0, at))) continue;
        const rest = row.text.slice(m.index + m[0].length);
        const f = firstNumber(rest);
        if (f.n != null && figure[code] === undefined) figure[code] = f.n;
        const w = readWords(f.after);
        if (w.wordy && words[code] === undefined) words[code] = w;
        if (row.box) labelled.set(code, [...(labelled.get(code) ?? []), row.box]);
      }
    }

    if (lines.length && labelled.size) {
      // 2. By position. One label per party: where a code stands on several lines,
      //    keep the one nearest the party column (the median left edge of the
      //    codes that matched only once).
      const once = [...labelled.values()].filter((ls) => ls.length === 1).map((ls) => ls[0].left);
      const column = once.length ? median(once) : null;
      const parties = [...labelled].map(([code, ls]) => ({
        code: code,
        box: column == null ? ls[0] : ls.reduce((a, b) => (Math.abs(b.left - column) < Math.abs(a.left - column) ? b : a)),
      }));
      const isLabel = new Set([...labelled.values()].flat());

      // Every other line in the party column is a row too — a label the reader
      // got wrong still holds its own figure. So are TOTAL labels.
      const colLeft = Math.min(...parties.map((p) => p.box.left));
      const colRight = Math.max(...parties.map((p) => p.box.right));
      const rowsOnly = lines
        .filter((l) => !isLabel.has(l) && leadingNumber(l.text) == null)
        .filter((l) => inside(l, colLeft, colRight) >= 0.5 || /(?:^|[^A-Z])TOTAL(?![A-Z])/i.test(l.text))
        .map((box) => ({ code: null, box }));
      const anchors = [...parties, ...rowsOnly];
      for (const a of rowsOnly) isLabel.add(a.box);

      // Row pitch: the smallest gap between neighbouring rows from the first party
      // to the last (a row nobody read makes a double gap, never a smaller one),
      // else four label heights when only one row was read.
      const height = median(parties.map((p) => p.box.bottom - p.box.top));
      const top = Math.min(...parties.map((p) => mid(p.box)));
      const bottom = Math.max(...parties.map((p) => mid(p.box)));
      const ys = anchors.map((a) => mid(a.box)).filter((y) => y >= top && y <= bottom).sort((a, b) => a - b);
      const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > height / 2);
      const pitch = gaps.length ? Math.min(...gaps) : 4 * height;

      // Everything else that could be an entry: a figure, number words, or both.
      const entries = [];
      for (const box of lines) {
        if (isLabel.has(box)) continue;
        const n = leadingNumber(box.text);
        const w = readWords(n != null ? repairDigits(box.text).replace(/^[\s|(]*\d+/, '') : box.text);
        if (n != null || w.wordy) entries.push({ box, n, words: w.wordy ? w : null, r: 0 });
      }

      // How this sheet lines handwriting up with its labels: the median offset
      // from each party label to the nearest entry beside it.
      const offsets = [];
      for (const p of parties) {
        let best = null;
        for (const e of entries) {
          if (e.box.left <= p.box.left) continue;
          const d = mid(e.box) - mid(p.box);
          if (Math.abs(d) <= pitch && (best == null || Math.abs(d) < Math.abs(best))) best = d;
        }
        if (best != null) offsets.push(best);
      }
      const offset = offsets.length ? median(offsets) : 0;

      // Each entry to its nearest row, within half a pitch.
      const won = new Map();
      for (const e of entries) {
        let best = null;
        for (const a of anchors) {
          if (e.box.left <= a.box.left) continue; // the S/N column, or left of this row's label
          const r = mid(e.box) - mid(a.box) - offset;
          if (Math.abs(r) <= pitch / 2 && (!best || Math.abs(r) < Math.abs(best.r))) best = { code: a.code, r };
        }
        if (best?.code != null) won.set(best.code, [...(won.get(best.code) ?? []), { ...e, r: best.r }]);
      }

      // The words column, sheet-wide, so an agent's scribble beside a row is not
      // taken for its words.
      const wordLines = [...won.values()].flat().filter((e) => e.n == null && e.words);
      const wl = wordLines.length ? median(wordLines.map((e) => e.box.left)) : 0;
      const wr = wordLines.length ? median(wordLines.map((e) => e.box.right)) : 0;

      for (const [code, es] of won) {
        // FIGURES: the leftmost numeric column, then the nearest.
        const nums = es.filter((e) => e.n != null);
        const first = nums.filter((c) => !nums.some((o) => o.box.right < c.box.left));
        if (figure[code] === undefined && first.length) {
          const f = first.reduce((a, b) => (Math.abs(b.r) < Math.abs(a.r) ? b : a));
          figure[code] = f.n;
          if (f.words && words[code] === undefined) words[code] = f.words;
        }
        // WORDS: every words line in the words column, read top to bottom as one cell.
        if (words[code] === undefined) {
          const cell = es
            .filter((e) => e.n == null && e.words && inside(e.box, wl, wr) > 0)
            .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
          if (cell.length) words[code] = readWords(cell.map((e) => e.box.text).join(' '));
        }
      }
    }

    // 3. Figures and words must agree.
    const out = {};
    for (const code of codes) {
      const f = figure[code];
      const w = words[code];
      if (w?.wordy) {
        if (w.value != null && (f === undefined || f === w.value)) out[code] = w.value;
      } else if (f !== undefined) {
        out[code] = f;
      }
    }
    return out;
  }

  window.HAWKEYE_SHEETCOUNTS = { parseCounts };
})();
