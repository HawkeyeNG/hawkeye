/**
 * FIND THE PARTY TABLE ON THE SHEET, instead of assuming where it is.
 *
 * ── the bug this replaces ──────────────────────────────────────────────────
 * rowBand() divided PARTY_TABLE_CROP into 16 equal rows. That constant is a
 * deliberately GENEROUS containing box for the VLM pass — its own comment says
 * "too much costs a few tokens, too little costs the row" — so it is bigger
 * than the table on purpose. Dividing an oversized box into equal rows puts
 * every row in the wrong place.
 *
 * Measured across a 42-sheet spread of the corpus, the old model placed row 1
 * a MEDIAN of 4.0 true row heights away from row 1 (max 11.8, and even the best
 * case was 0.3 off). On 29-13-06-001 and 29-01-01-005 the band for row 1 showed
 * the "Local Government Area / Registration Area" header. A reviewer reported
 * exactly that.
 *
 * bandCoversRow() could not catch it: it derived the row centre from the same
 * constants that drew the band, so it agreed with itself by construction and
 * could only fail at the image edge. A checker that cannot fail is not a checker.
 *
 * ── how this works ─────────────────────────────────────────────────────────
 * The table is ruled: 15 party rows plus TOTAL VALID VOTES, so 17 horizontal
 * rules at an even pitch. A row-wise darkness profile, high-passed to kill the
 * slow shading of a photographed page, turns those rules into sharp peaks.
 *
 * The first attempt scored a comb by SUMMED darkness over a grid of (first,
 * pitch). It recovered the pitch exactly and still failed, because summed
 * darkness has no preferred origin: sliding the comb two rows down picked up
 * the certification paragraph's lines, which are darker than the table's top
 * rules, and scored higher. The band for row 1 then showed rows 3-5.
 *
 * So this fits to DETECTED PEAKS and maximises INLIER COUNT, not darkness. Two
 * very dark lines that happen to sit at the right pitch can add two inliers;
 * they cannot outweigh fifteen. Ties break on residual, then on total strength.
 * This is RANSAC over peak positions, and unlike a darkness sum it is anchored:
 * a comb shifted by two rows loses two inliers off the top and must find two
 * replacements at EXACTLY the table's pitch to break even.
 *
 * ── it is allowed to say "I don't know" ────────────────────────────────────
 * detectRows() returns null when it cannot find enough inliers. Null means the
 * caller shows NO band and the reviewer keeps the full sheet. That is the point:
 * the previous version had no way to express uncertainty, so it pointed at the
 * wrong rows with complete confidence.
 */

/**
 * FIFTEEN PARTY ROWS, and deliberately NOT the TOTAL VALID VOTES row.
 *
 * The TOTAL row is taller than a party row — it carries a second printed line,
 * "(Record Total Valid Votes under #7 above)" — so its rule sits further than
 * one pitch below the last party rule. An earlier version fitted 17 uniform
 * lines across all 16 rows; the extra distance at the bottom dragged the whole
 * comb down and every band came out one row low. The rows this model describes
 * are uniform, which is the only reason a single pitch can describe them.
 *
 * The review UI asks for the 15 parties on the ballot and nothing else, so the
 * TOTAL row never needs a band.
 */
export const TABLE_ROWS = 15;
export const TABLE_LINES = TABLE_ROWS + 1;

export const SEARCH = {
  pitchMin: 0.014,       // fractions of image height; bound the search only
  pitchMax: 0.042,
  firstMin: 0.15,
  firstMax: 0.60,
  xLeft: 0.10,           // profile spans the table's columns, so the page edge
  xRight: 0.80,          // and the photo background cannot vote
  minInliers: 14,        // of 16 — a rule may be faint, folded or overwritten
  // A comb must not merely HIT 16 peaks; the peaks it hits must look like
  // printed rules. Pure noise reached 16/16 inliers without these.
  maxCv: 0.55,           // rules come from one printing pass, so ~equally dark
  minStrengthRatio: 3.0, // ...and far darker than the page around them
  // IN GREY LEVELS, and the gate that actually works. A rule spanning the
  // sampled width pulls its row's mean down by tens of levels; noise averaged
  // over ~680 px moves it by about one. Both scale-free gates above passed on
  // pure noise (see tests/table-detect.test.mjs) because a heavily averaged
  // profile is flat, which reads as "uniform" and as "well above background".
  minStrengthAbs: 6.0,
  // REJECTION ONLY, never placement. Fits with an implausibly small pitch were
  // locking onto the words-column handwriting, which is also roughly regular.
  // A range cannot tell us WHERE the rows are — assuming that is what broke the
  // old model — but it can say that a table of 15 rows occupying under 1.9%% of
  // the image each is not this form. Outside the range we show no band at all.
  pitchPlausibleMin: 0.019,
  pitchPlausibleMax: 0.034,
};

/** Row-wise mean darkness (255 - grey) across the sampled x-range. */
export function darknessProfile(data, info, { xLeft = SEARCH.xLeft, xRight = SEARCH.xRight } = {}) {
  const W = info.width;
  const H = info.height;
  const x0 = Math.max(0, Math.floor(W * xLeft));
  const x1 = Math.min(W, Math.ceil(W * xRight));
  const span = Math.max(1, x1 - x0);
  const prof = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    const base = y * W;
    for (let x = x0; x < x1; x++) sum += 255 - data[base + x];
    prof[y] = sum / span;
  }
  return prof;
}

/**
 * Subtract a wide moving average.
 *
 * A photographed sheet carries large slow gradients — shadow, a curled page —
 * that dwarf a 2px printed rule in absolute darkness. Removing everything
 * broader than the window leaves the rules. Without this the fit chases the
 * darkest REGION of the page instead of its lines.
 */
export function highpass(prof, window) {
  const H = prof.length;
  const w = Math.max(3, Math.round(window) | 1);
  const half = (w - 1) / 2;
  const cum = new Float64Array(H + 1);
  for (let i = 0; i < H; i++) cum[i + 1] = cum[i] + prof[i];
  const out = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    const a = Math.max(0, y - half);
    const b = Math.min(H, y + half + 1);
    out[y] = Math.max(0, prof[y] - (cum[b] - cum[a]) / (b - a));
  }
  return out;
}

/**
 * Local maxima strong enough to be printed rules.
 *
 * `minSep` keeps a single thick rule from contributing several peaks, which
 * would let one line supply two inliers and corrupt the pitch.
 */
export function findPeaks(prof, { minSep = 4, minRel = 0.14 } = {}) {
  const H = prof.length;
  let max = 0;
  for (let y = 0; y < H; y++) if (prof[y] > max) max = prof[y];
  if (max <= 0) return [];
  const floor = max * minRel;
  const cands = [];
  for (let y = 1; y < H - 1; y++) {
    if (prof[y] >= floor && prof[y] >= prof[y - 1] && prof[y] >= prof[y + 1]) {
      cands.push({ y, v: prof[y] });
    }
  }
  cands.sort((a, b) => b.v - a.v);
  const kept = [];
  for (const c of cands) {
    if (kept.every((k) => Math.abs(k.y - c.y) >= minSep)) kept.push(c);
  }
  return kept.sort((a, b) => a.y - b.y);
}

/**
 * Fit 17 evenly spaced rules to the peaks.
 *
 * Every ordered pair of peaks proposes a (first, pitch) hypothesis by assuming
 * the two peaks are lines i and j of the comb. Each hypothesis is scored by how
 * many of the 17 predicted positions have a peak near them.
 */
export function fitComb(peaks, H, opts = {}) {
  const S = { ...SEARCH, ...opts };
  const tol = Math.max(2, Math.round(H * 0.006));
  const pitchMin = H * S.pitchMin;
  const pitchMax = H * S.pitchMax;
  const firstMin = H * S.firstMin;
  const firstMax = H * S.firstMax;

  const ys = peaks.map((p) => p.y);
  const strength = new Map(peaks.map((p) => [p.y, p.v]));
  const nearest = (t) => {
    let best = null;
    let bd = Infinity;
    for (const y of ys) {
      const d = Math.abs(y - t);
      if (d < bd) { bd = d; best = y; }
    }
    return bd <= tol ? { y: best, d: bd } : null;
  };

  let best = null;
  for (let a = 0; a < peaks.length; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const gap = peaks[b].y - peaks[a].y;
      if (gap <= 0) continue;
      // Try treating this pair as lines separated by `step` rows.
      for (let step = 1; step <= TABLE_ROWS; step++) {
        const pitch = gap / step;
        if (pitch < pitchMin || pitch > pitchMax) continue;
        for (let idx = 0; idx <= TABLE_ROWS - step; idx++) {
          const first = peaks[a].y - idx * pitch;
          if (first < firstMin || first > firstMax) continue;
          if (first + TABLE_ROWS * pitch > H - 1) continue;
          let inliers = 0;
          let resid = 0;
          const vals = [];
          for (let i = 0; i < TABLE_LINES; i++) {
            const hit = nearest(first + i * pitch);
            if (hit) { inliers++; resid += hit.d; vals.push(strength.get(hit.y) || 0); }
          }
          // TIE-BREAK ON UNIFORMITY, NOT ON DARKNESS.
          //
          // Preferring the darker comb is what let the fit slide. Shifting two
          // rows down drops two table rules off the top and picks up two lines
          // of the certification paragraph at the bottom: the inlier count
          // TIES, and the paragraph is printed heavier than a faint table, so
          // "whichever has more ink" picked the wrong one. The reviewer saw the
          // result of that. tests/table-detect.test.mjs reproduces it directly.
          //
          // A real table is ruled in one printing pass, so its lines are
          // uniformly dark. A comb that mixes fourteen faint rules with two
          // heavy paragraph lines is not, and its spread gives it away. Lowest
          // coefficient of variation wins; residual only breaks a further tie.
          let mean = 0;
          for (const v of vals) mean += v;
          mean = vals.length ? mean / vals.length : 0;
          let varsum = 0;
          for (const v of vals) varsum += (v - mean) * (v - mean);
          const cv = mean > 0 ? Math.sqrt(varsum / vals.length) / mean : Infinity;
          if (!best
            || inliers > best.inliers
            || (inliers === best.inliers && cv < best.cv - 1e-6)
            || (inliers === best.inliers && Math.abs(cv - best.cv) <= 1e-6 && resid < best.resid)) {
            best = { first, pitch, inliers, resid, cv, meanStrength: mean };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Locate the table's 17 rules.
 *
 * @returns {{lines:number[], first:number, pitch:number, inliers:number,
 *            confident:boolean}|null}
 */
export function detectRows(data, info, opts = {}) {
  const H = info.height;
  if (!H || !info.width) return null;
  const S = { ...SEARCH, ...opts };

  const prof = highpass(darknessProfile(data, info, S), H * S.pitchMax * 1.5);
  const peaks = findPeaks(prof, { minSep: Math.max(3, Math.round(H * S.pitchMin * 0.5)) });
  if (peaks.length < S.minInliers) return null;

  const fit = fitComb(peaks, H, S);
  if (!fit || fit.inliers < S.minInliers) return null;

  const pitchFrac = fit.pitch / H;
  if (pitchFrac < S.pitchPlausibleMin || pitchFrac > S.pitchPlausibleMax) return null;

  // Are the lines it found actually rules? Both gates below can reject a fit
  // that hit every one of its 16 predicted positions, which is the point: on
  // xorshift noise the old code returned a confident 16/16 table.
  if (!(fit.cv <= S.maxCv)) return null;
  let profMean = 0;
  for (let y = 0; y < H; y++) profMean += prof[y];
  profMean /= H;
  const strengthRatio = profMean > 0 ? fit.meanStrength / profMean : 0;
  if (strengthRatio < S.minStrengthRatio) return null;
  if (fit.meanStrength < S.minStrengthAbs) return null;

  const lines = [];
  for (let i = 0; i < TABLE_LINES; i++) lines.push(Math.round(fit.first + i * fit.pitch));
  return {
    lines,
    first: fit.first,
    pitch: fit.pitch,
    inliers: fit.inliers,
    cv: fit.cv,
    strengthRatio,
    strength: fit.meanStrength,
    confident: true,
  };
}

/**
 * The band for one row, from DETECTED lines.
 *
 * Always spans the full table width so the reviewer keeps the party-name
 * column. That self-check is the only defence that survives a moved frame, and
 * it matters more here, not less — the geometry is now inferred per sheet, so
 * the reviewer's own eyes remain the final check on it.
 */
export function bandFromLines(detected, meta, rowIndex, { context = 0.6, xLeft = SEARCH.xLeft, xRight = SEARCH.xRight } = {}) {
  const i = Math.min(Math.max(0, rowIndex), TABLE_ROWS - 1);
  const pad = detected.pitch * context;
  const top = Math.max(0, Math.round(detected.lines[i] - pad));
  const bottom = Math.min(meta.height, Math.round(detected.lines[i + 1] + pad));
  const left = Math.max(0, Math.round(meta.width * xLeft));
  const right = Math.min(meta.width, Math.round(meta.width * xRight));
  return { left, top, width: right - left, height: bottom - top };
}
