import { PARTY_TABLE_CROP, SUMMARY_BOXES_CROP } from './ec8a_prompt.js';

/**
 * ── rowBand() and bandCoversRow() were REMOVED here on 2026-09-06 ──────────
 *
 * They divided PARTY_TABLE_CROP into equal rows. That constant is a
 * deliberately GENEROUS containing box for the VLM pass, not a tight bound on
 * the rows, so every row came out in the wrong place: measured across a spread
 * of the corpus, row 1's band was a median of 4.0 true row heights away from
 * row 1 (max 11.8). A reviewer saw the sheet header where party A should be.
 *
 * bandCoversRow() did not catch it because it derived the row centre from the
 * same constants that drew the band — it agreed with itself by construction.
 *
 * Row geometry now comes from services/ec8a_table_detect.js, which finds the
 * rules on each sheet and RETURNS NULL when it cannot. PARTY_TABLE_CROP keeps
 * its original job — the generous crop fed to the model — which it does well.
 */

/**
 * The summary-box block in absolute pixels.
 *
 * ONE BLOCK, NOT ONE BOX. rowBand above bands a single party row because the
 * party table is a known count of evenly-pitched rows, and bandCoversRow can
 * prove a band contains its target. The #1-#8 block has no such calibration:
 * this crop deliberately includes the sheet header as well as the boxes, so
 * dividing it into eight equal slices would invent a geometry nobody has
 * measured. Per the warning in ec8a_prompt.js, a reviewer confidently reading
 * the wrong figure produces a correction that is trusted and never checked
 * again -- so the whole block is served and the reviewer keeps the printed
 * labels that let them see which box they are on.
 *
 * The arithmetic is the worker's, unchanged: `right: 1.0` makes the width
 * `W - left` exactly, and `height` is a fraction of H rather than a bottom edge,
 * so rounding lands on the same pixels it always did.
 */
export function summaryBoxesRect(meta) {
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) throw new Error('summaryBoxesRect needs image dimensions');
  const S = SUMMARY_BOXES_CROP;
  const left = Math.round(W * S.left);
  const top = Math.round(H * S.top);
  return {
    left,
    top,
    width: Math.round(W * S.right) - left,
    height: Math.round(H * S.height),
  };
}

/**
 * Is this rect actually usable as evidence?
 *
 * The equivalent of bandCoversRow: a predicate the endpoint and the tests share,
 * so a geometry change cannot quietly start serving a sliver. It cannot verify
 * WHICH boxes are inside -- nothing has measured that -- but it can refuse a
 * crop that is off the sheet or too small to be the block at all.
 */
export function rectIsUsable(meta, rect, { minWidth = 0.25, minHeight = 0.2 } = {}) {
  if (!meta.width || !meta.height) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.left < 0 || rect.top < 0) return false;
  if (rect.left + rect.width > meta.width) return false;
  if (rect.top + rect.height > meta.height) return false;
  if (rect.width < meta.width * minWidth) return false;
  if (rect.height < meta.height * minHeight) return false;
  return true;
}
