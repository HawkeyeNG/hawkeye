import fs from 'node:fs';

/**
 * Where ground truth comes from, and who wrote it.
 *
 * WHY THIS EXISTS. Every accuracy figure this project has quoted traces back to
 * `hand_labels.json`, whose own header says:
 *
 *     "_labeller": "claude-opus-5, reading the JPEGs directly.
 *                   NOT an independent human labeller"
 *
 * 16 of those 20 sheets came back identical to the machine's own earlier output,
 * and the 97.7% derived from them is an agreement rate wearing an accuracy's
 * clothes. A ruler drawn by the thing being measured is not a ruler.
 *
 * The blind review console produces the real thing: a human reads the sheet with
 * no machine output on the page and none in the network tab — the server refuses
 * to release the prediction (409) until the reading is committed and immutable.
 * Those readings land in `audit_review/reviews.json`.
 *
 * THE BLIND READING, NEVER THE FINAL. A review has two steps: `blind` is taken
 * before the reveal, `final` after it. Only the blind one is independent. The
 * final is what the reviewer settled on having SEEN the machine, so scoring the
 * machine against it measures how persuasive the machine was. That is the same
 * anchoring that made hand_labels useless, one step further along.
 *
 * PROVENANCE IS NOT OPTIONAL. There is no way to get labels out of this module
 * without also getting where they came from, because the failure being prevented
 * is precisely a number quoted without knowing what it rests on.
 */

export const PROVENANCE = {
  HUMAN_BLIND: 'human_blind',
  MACHINE_AUTHORED: 'machine_authored',
};

/** reviews.json -> the same shape hand_labels.json exposes, plus provenance. */
export function labelsFromReviews(reviews, ballot) {
  const out = {};
  for (const [key, rec] of Object.entries(reviews || {})) {
    const blind = rec?.blind;
    if (!blind || !blind.parties) continue;
    // Party codes are stored uppercased and truncated to 6 by cleanParties, so
    // the ballot must be matched the same way or every row misses.
    const norm = (p) => String(p).toUpperCase().slice(0, 6);
    const byCode = {};
    for (const [p, v] of Object.entries(blind.parties)) byCode[norm(p)] = v;
    out[key] = {
      ...(blind.boxes || {}),
      // Ballot order, so it lines up with hand_labels' `figures` array. A party
      // the reviewer did not fill is null — NOT zero. That distinction is the
      // whole point of the exercise and collapsing it here would undo it.
      figures: (ballot || []).map((p) => {
        const v = byCode[norm(p)];
        return v === undefined ? null : v;
      }),
      _provenance: PROVENANCE.HUMAN_BLIND,
      _by: blind.by,
      _at: blind.at,
    };
  }
  return out;
}

/**
 * Load the best available labels, and say plainly what they are.
 *
 * Human blind readings win per sheet. hand_labels fills only where no human has
 * read that sheet, and every such entry is stamped machine_authored so it cannot
 * quietly become evidence.
 */
export function loadLabels({ reviewsPath, handLabelsPath, ballot }) {
  const read = (p) => {
    try { return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
    catch (e) { throw new Error(`labels: ${p} is unreadable — ${e.message}`); }
  };

  const reviews = read(reviewsPath) || {};
  const hand = read(handLabelsPath) || {};
  const ball = ballot || hand._ballot || [];

  const human = labelsFromReviews(reviews, ball);
  const labels = { ...human };
  let machine = 0;
  for (const [k, v] of Object.entries(hand)) {
    if (k.startsWith('_')) continue;          // _note, _labeller, _ballot
    if (labels[k]) continue;                  // a human has read this sheet
    labels[k] = { ...v, _provenance: PROVENANCE.MACHINE_AUTHORED };
    machine += 1;
  }

  const humanCount = Object.keys(human).length;
  return {
    labels,
    ballot: ball,
    provenance: {
      [PROVENANCE.HUMAN_BLIND]: humanCount,
      [PROVENANCE.MACHINE_AUTHORED]: machine,
      total: humanCount + machine,
      // The one sentence a caller must print beside any figure it derives.
      note: humanCount === 0
        ? 'NO HUMAN LABELS. Every figure below rests on labels a model wrote about its own output — an agreement rate, not an accuracy.'
        : (machine === 0
          ? `All ${humanCount} labels are independent human blind readings.`
          : `${humanCount} human blind readings and ${machine} model-authored labels. Any figure mixing them is not an accuracy — report them separately.`),
    },
  };
}

/** Only the labels a human actually read. Use this for any published claim. */
export function humanOnly(loaded) {
  const labels = Object.fromEntries(
    Object.entries(loaded.labels).filter(([, v]) => v._provenance === PROVENANCE.HUMAN_BLIND),
  );
  return { ...loaded, labels, provenance: { ...loaded.provenance, [PROVENANCE.MACHINE_AUTHORED]: 0 } };
}
