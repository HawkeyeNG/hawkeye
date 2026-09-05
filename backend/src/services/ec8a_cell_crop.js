import { PARTY_TABLE_CROP } from './ec8a_prompt.js';

/**
 * A ROW BAND for human review — one question instead of a whole sheet.
 *
 * WHY. The tier-A review pile scales to ~73,000 sheets for 2027, against a
 * pipeline that has processed 490. At 2 minutes a sheet that is ~2,400 hours.
 * But those 490 sheets carry only 751 actually-disputed cells: the reviewer is
 * scanning a whole form to answer one question about one number. Showing the row
 * and asking that question directly is where the throughput is.
 *
 * WHY A BAND AND NOT A CELL. ec8a_prompt.js records the hard-won warning: these
 * are photographs of paper on a desk and the framing moves. On 29-13-07-001 the
 * table sat low enough that a bottom bound clipped the TOTAL row's values while
 * leaving its printed label visible — "the most dangerous kind of miss, since
 * the crop still looks complete."
 *
 * A tight cell crop inherits that failure and makes it worse. A model reading
 * the wrong cell produces a flag someone checks; a REVIEWER confidently reading
 * the wrong row produces a correction that is trusted and never checked again.
 * So the band is deliberately generous, and it ALWAYS INCLUDES THE PARTY-NAME
 * COLUMN — the reviewer can see which row they are on and catch a misalignment
 * themselves, which is the only defence that survives a moved frame.
 *
 * The asymmetry from the same note applies unchanged: too much costs a little
 * screen space, too little costs the row silently.
 */

// The party table, as a fraction of the whole sheet. Same constant the VLM pass
// crops with, so the two cannot drift apart.
const T = PARTY_TABLE_CROP;

/** Rows on an EC8A party table: the ballot's parties, plus the TOTAL line. */
export const ROWS_DEFAULT = 15;

/**
 * Vertical band for one row, in absolute pixels, with neighbours included.
 *
 * `context` is in ROW HEIGHTS, not pixels, so the margin scales with the sheet
 * and with the ballot length rather than being tuned to one resolution.
 */
export function rowBand(meta, rowIndex, { rows = ROWS_DEFAULT, context = 1 } = {}) {
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) throw new Error('rowBand needs image dimensions');
  const n = Math.max(1, rows + 1);                    // + the TOTAL row
  const i = Math.min(Math.max(0, rowIndex), n - 1);

  const tableTop = H * T.top;
  const tableBottom = H * T.bottom;
  const rowH = (tableBottom - tableTop) / n;

  const top = Math.max(0, Math.round(tableTop + (i - context) * rowH));
  const bottom = Math.min(H, Math.round(tableTop + (i + 1 + context) * rowH));

  // Always from the party column across to the end of the words column. Cropping
  // to the figures cell alone would remove the reviewer's only way to tell they
  // are looking at the right party.
  const left = Math.max(0, Math.round(W * T.left));
  const right = Math.min(W, Math.round(W * T.right));

  return { left, top, width: right - left, height: bottom - top, rowHeight: rowH };
}

/**
 * Does the band actually contain the row it claims to?
 *
 * Exported so the endpoint and the tests use the SAME predicate, and so a
 * geometry change cannot quietly stop covering its target.
 */
export function bandCoversRow(meta, band, rowIndex, { rows = ROWS_DEFAULT } = {}) {
  const n = Math.max(1, rows + 1);
  const tableTop = meta.height * T.top;
  const rowH = (meta.height * T.bottom - tableTop) / n;
  const centre = tableTop + (rowIndex + 0.5) * rowH;
  return centre >= band.top && centre <= band.top + band.height;
}
