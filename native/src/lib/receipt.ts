/**
 * The observer's own copy of what they just reported — the TEXT of it.
 *
 * Twin of the `lines()` half of app/receipt.js, and deliberately only that
 * half: the web draws on a canvas and the app draws with react-native-svg, and
 * two renderers cannot be compared to each other. What CAN be compared is the
 * rule that turns a report into the strings a reader sees, so that rule is a
 * function on both sides and tests/receipt_parity_test.mjs holds them equal.
 * Same reason seatFieldOf and contestBallot are functions — see political.ts.
 *
 * TWO STATES, and conflating them would be a lie. A report that is QUEUED has
 * no entry hash yet because it has not reached the chain, so its card carries
 * no hash and no verify link and says so. A card that showed a verify URL
 * before the entry existed would send someone to a 404 and teach them the
 * receipt cannot be trusted.
 *
 * `pending` is DERIVED from the absence of a hash rather than passed in as a
 * flag: the hash is what makes a report verifiable, so it is the only honest
 * source for whether this copy can claim to be on the ledger. No caller can
 * mark a card verified without one, because there is no flag to set.
 */

export type ReceiptVote = { party: string; count: number };

export type ReceiptData = {
  /** A rehearsal, not a result. See the three-state note in receiptLines. */
  practice?: boolean;
  puName?: string;
  puCode?: string;
  ward?: string;
  lga?: string;
  state?: string;
  contest?: string;
  votes?: ReceiptVote[];
  entryHash?: string | null;
  at?: number;
};

/** (key, english) -> string. See the injected-translator note on receiptLines. */
export type Translate = (key: string, english: string) => string;

export type ReceiptLines = {
  practice: boolean;
  pending: boolean;
  title: string;
  unit: string;
  code: string;
  where: string;
  contest: string;
  when: string;
  votes: ReceiptVote[];
  total: number;
  hashShort: string;
  hash: string;
  verify: string;
  status: string;
  foot: string;
  totalLabel: string;
  hashLabel: string;
  verifyLabel: string;
};

const two = (n: number) => String(n).padStart(2, '0');

/** English is what a card falls back to, never a key or a blank. */
const defaultT: Translate = (_k, english) => english;

/**
 * "19 Sept 2026, 14:32" - local time, because that is when the reader was there.
 *
 * The month names are TRANSLATED TOO, as one comma-separated key rather than
 * twelve. Intl.DateTimeFormat would be the obvious answer and is the wrong one:
 * this runs on Hermes, whose ICU data is not the browser's, so the same date
 * would render differently on the two clients and the parity test could not
 * tell that apart from a bug.
 */
function stamp(ms: number, t: Translate): string {
  const d = new Date(ms);
  const M = String(t('receipt.months', 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sept,Oct,Nov,Dec')).split(',');
  return `${d.getDate()} ${M[d.getMonth()] || ''} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * THE TRANSLATOR IS INJECTED, not imported.
 *
 * This is the twin of app/receipt.js:lines, and the two clients do not share a
 * translate function - the web has HawkeyeI18n, this has lib/i18n. Taking `t`
 * as an argument is what lets the rule stay one comparable rule while still
 * speaking Hausa: the parity test hands BOTH sides the same `t`, so a
 * divergence is a real divergence and not a locale artefact.
 */
export function receiptLines(
  d: ReceiptData | null | undefined,
  t: Translate = defaultT,
): ReceiptLines {
  const data = d || {};
  /**
   * THREE STATES, NOT TWO.
   *
   * Practice is how someone learns what this card is before they ever stand at
   * a unit, so a practice run gets one too - and it has to be unmistakable. It
   * carries the practice chain's own hash (a separate chain with its own
   * genesis, never anchored, never counted) and says so.
   *
   * Checked FIRST, before pending, because a practice run HAS an entry hash and
   * would otherwise render as a recorded public result, which is the one thing
   * this card must never do.
   */
  const practice = !!data.practice;
  const votes = (data.votes || [])
    .filter((v) => Number(v.count) > 0)
    .slice()
    .sort((a, b) => String(a.party).localeCompare(String(b.party)));
  const total = votes.reduce((n, v) => n + Number(v.count), 0);
  const pending = !data.entryHash;
  const where = [data.ward, data.lga, data.state].filter(Boolean).join(' · ');
  return {
    practice,
    pending,
    title: practice
      ? t('receipt.title-practice', 'Practice run — not a real result')
      : pending
        ? t('receipt.title-pending', 'Saved on your phone')
        : t('receipt.title-recorded', 'Your copy of this result'),
    unit: data.puName || '',
    code: data.puCode || '',
    where,
    contest: data.contest || '',
    when: t('receipt.reported', 'Reported {v0}').replace('{v0}', stamp(data.at || Date.now(), t)),
    votes,
    total,
    /* Short form for the face of the card; the full hash is what verifies, and
       it is printed underneath so a photograph of this card is enough. */
    hashShort: pending ? '' : String(data.entryHash).slice(0, 16),
    hash: pending ? '' : String(data.entryHash),
    /* NO VERIFY LINK ON A PRACTICE CARD. The practice chain is not the public
       ledger and ledger.html cannot show it; a link there would 404 and, worse,
       imply the rehearsal was published. */
    verify: (pending || practice) ? '' : 'hawkeye.com.ng/ledger.html#' + String(data.entryHash),
    status: practice
      ? t('receipt.status-practice', 'Practice chain only — this is a rehearsal and is never counted.')
      : pending
        ? t('receipt.status-pending', 'Not yet on the public ledger — it sends when you are back online.')
        : t('receipt.status-recorded', 'Recorded on the public ledger.'),
    foot: t('receipt.foot', 'Hawkeye does not declare results — official results are announced by INEC.'),
    /* THE RENDERER'S OWN LABELS LIVE HERE TOO. They used to be typed
       straight into the drawing, which put them outside everything that
       compares or translates the card - the one place a string is
       guaranteed to be forgotten. */
    totalLabel: t('receipt.total-on-this-sheet', 'Total on this sheet'),
    hashLabel: practice
      ? t('receipt.practice-chain-entry', 'PRACTICE CHAIN ENTRY')
      : t('receipt.ledger-entry', 'LEDGER ENTRY'),
    verifyLabel: t('receipt.verify-at', 'Verify at hawkeye.com.ng/ledger.html'),
  };
}
