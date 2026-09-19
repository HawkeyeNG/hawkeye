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
};

const two = (n: number) => String(n).padStart(2, '0');

/** "19 Sept 2026, 14:32" — local time, because that is when the reader was there. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function receiptLines(d: ReceiptData | null | undefined): ReceiptLines {
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
      ? 'Practice run — not a real result'
      : pending ? 'Saved on your phone' : 'Your copy of this result',
    unit: data.puName || '',
    code: data.puCode || '',
    where,
    contest: data.contest || '',
    when: 'Reported ' + stamp(data.at || Date.now()),
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
      ? 'Practice chain only — this is a rehearsal and is never counted.'
      : pending
        ? 'Not yet on the public ledger — it sends when you are back online.'
        : 'Recorded on the public ledger.',
    foot: 'Hawkeye does not declare results — official results are announced by INEC.',
  };
}
