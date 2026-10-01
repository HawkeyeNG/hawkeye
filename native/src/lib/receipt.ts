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

/** Which report the card is for. See the note in receiptLines. */
export type ReceiptKind = 'result' | 'collation' | 'incident';

export type ReceiptData = {
  /** Unset = a unit result, the original card. */
  kind?: ReceiptKind;
  /** collation: the area's name (ward, LGA or state) — the card's headline. */
  area?: string;
  /** collation: the form, e.g. "EC8B". */
  form?: string;
  /** incident: the TYPE, already in the reader's language. */
  incident?: string;
  /** incident: the server's reference once sent. Absent = still on the phone. */
  reference?: string | number | null;
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
  kind: ReceiptKind;
  /** COLLATION / INCIDENT in the top corner; '' on a unit result. */
  label: string;
  /** Draw the figures box. False on an incident, which has none. */
  figures: boolean;
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
   * WHICH REPORT THIS IS — the twin of the same note in app/receipt.js.
   * Unknown = a unit result, the original card.
   *  - collation: the area is the headline and the form sits under it. Its
   *    hash is on the collation chain, which ledger.html does not list, so it
   *    carries the hash and NO verify link.
   *  - incident: not on any ledger. Sent for review once the server gave it a
   *    reference, saved on the phone before. Only what the public incident feed
   *    shows once published — type, state, time — never the description,
   *    media, unit or a position. No figures box.
   */
  const kind: ReceiptKind = data.kind === 'collation' || data.kind === 'incident' ? data.kind : 'result';
  const incident = kind === 'incident';
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
  const votes = incident ? [] : (data.votes || [])
    .filter((v) => Number(v.count) > 0)
    .slice()
    .sort((a, b) => (b.count - a.count) || String(a.party).localeCompare(String(b.party)));
  const total = votes.reduce((n, v) => n + Number(v.count), 0);
  /* An incident is never on a chain: SENT (it has the server's reference) or
     not yet. Everything else is pending until it has an entry hash. */
  const pending = incident ? !data.reference : !data.entryHash;
  const hash = pending || incident ? '' : String(data.entryHash);
  /* The incident's TYPE is its headline, in place of a unit; `where` may only
     be the state, the one place the public feed names. No race line. */
  const where = incident ? (data.state || '') : [data.ward, data.lga, data.state].filter(Boolean).join(' · ');
  const unit = kind === 'collation' ? (data.area || '') : incident ? (data.incident || '') : (data.puName || '');
  const contest = incident ? '' : (data.contest || '');
  return {
    practice,
    pending,
    title: practice
      ? t('receipt.title-practice', 'Practice run — not a real result')
      : pending
        ? t('receipt.title-pending', 'Saved on your phone')
        : incident
          ? t('receipt.title-report', 'Your copy of this report')
          : t('receipt.title-recorded', 'Your copy of this result'),
    unit,
    code: kind === 'collation' ? (data.form || '') : incident ? '' : (data.puCode || ''),
    where,
    contest,
    when: t('receipt.reported', 'Reported {v0}').replace('{v0}', stamp(data.at || Date.now(), t)),
    votes,
    total,
    /* Short form for the face of the card; the full hash is what verifies, and
       it is printed underneath so a photograph of this card is enough. */
    hashShort: hash.slice(0, 16),
    hash,
    /* NO VERIFY LINK ON A PRACTICE CARD. The practice chain is not the public
       ledger and ledger.html cannot show it; a link there would 404 and, worse,
       imply the rehearsal was published. The same for a collation (its own
       chain, not listed there) and an incident (no chain at all). */
    verify: (pending || practice || kind !== 'result') ? '' : 'hawkeye.com.ng/ledger.html#' + hash,
    status: practice
      ? t('receipt.status-practice', 'Practice chain only — this is a rehearsal and is never counted.')
      : incident
        ? (pending
          ? t('receipt.status-incident-pending', 'Not sent yet — it sends when you are back online.')
          : t('receipt.status-review', 'Sent for review — a person checks every report before anything is published.'))
        : pending
          ? t('receipt.status-pending', 'Not yet on the public ledger — it sends when you are back online.')
          : t('receipt.status-recorded', 'Recorded on the public ledger.'),
    foot: incident
      ? t('receipt.foot-incident', 'Hawkeye publishes an incident only after a person has reviewed it.')
      : t('receipt.foot', 'Hawkeye does not declare results — official results are announced by INEC.'),
    /* THE RENDERER'S OWN LABELS LIVE HERE TOO. They used to be typed
       straight into the drawing, which put them outside everything that
       compares or translates the card - the one place a string is
       guaranteed to be forgotten. */
    totalLabel: t('receipt.total-on-this-sheet', 'Total on this sheet'),
    hashLabel: practice
      ? t('receipt.practice-chain-entry', 'PRACTICE CHAIN ENTRY')
      : kind === 'collation'
        ? t('receipt.collation-ledger-entry', 'COLLATION LEDGER ENTRY')
        : t('receipt.ledger-entry', 'LEDGER ENTRY'),
    verifyLabel: t('receipt.verify-at', 'Verify at hawkeye.com.ng/ledger.html'),
    kind,
    /* The one thing that differs on the face of the card: which report. */
    label: kind === 'collation'
      ? t('receipt.kind-collation', 'Collation')
      : incident ? t('receipt.kind-incident', 'Incident') : '',
    figures: !incident,
  };
}
