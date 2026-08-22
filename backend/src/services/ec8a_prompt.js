/**
 * The EC8A read prompt + schema, in one place so the live submission check and
 * the offline audit cannot drift apart.
 *
 * Two consumers, deliberately different shapes:
 *   - services/vision.js  — live, per submission. Small schema: authenticity,
 *     region, and the party counts it can compare against what the observer
 *     typed. Unchanged by this module; it imports only the crossed-out rule.
 *   - scripts/vlm_worker.mjs — the Osun archive audit. Needs every number on the
 *     sheet, because the audit's whole claim to trustworthiness is that a sheet
 *     verifies ITSELF (figures vs words, and the totals arithmetic) rather than
 *     resting on our confidence in a model.
 */

/** Every party code seen across our sheets and labels, plus an escape hatch. */
export const PARTY_CODES = [
  'A', 'AA', 'AAC', 'ADC', 'ADP', 'APC', 'APGA', 'APM', 'APP', 'BP', 'LP',
  'NDC', 'NNPP', 'NRM', 'PDP', 'PRP', 'SDP', 'YPP', 'ZLP', 'OTHER',
];

/**
 * The Osun 2026 governorship ballot, in the order printed on the EC8A (S/N 1-15).
 * Read off sheet 29-01-01-001; a state election runs one ballot statewide, so
 * every sheet in this archive carries these fifteen rows in this order.
 *
 * WHY THIS IS WORTH HARD-CODING. Asking a model to discover the party list is
 * asking it to do the one part of the job the sheet does not require: the rows
 * are fixed and printed. Told only to "list every party row", Qwen returned a
 * SINGLE row for a sheet with fifteen — it reported the parties that caught its
 * eye and dropped thirteen zeroes and a 110. Given the list, the task collapses
 * to filling in known slots, and an omission becomes impossible rather than
 * merely discouraged.
 */
export const OSUN_2026_BALLOT = [
  'A', 'AA', 'AAC', 'ADC', 'ADP', 'APC', 'APGA', 'APM', 'APP', 'BP',
  'NNPP', 'PRP', 'SDP', 'YPP', 'ZLP',
];

/**
 * Names a model may return instead of the printed code.
 *
 * The party-table pass read row 1 of 29-01-01-003 as "ACCORD" — the party's
 * actual name, of which the ballot code "A" is the abbreviation. It is a
 * perfectly good reading, and it cost the row: the merge matches rows by party
 * name, found no "A", and threw away a 191 that pass 1 had read correctly. A
 * transcription lost to a naming convention is the silliest way to lose data in
 * this pipeline, and the fix is a lookup table.
 *
 * Matching by POSITION instead was the tempting alternative and is rejected:
 * the schema pins the row count, not the row set, so a list that repeated APC
 * and dropped A would pair every subsequent party with its neighbour's votes.
 */
export const PARTY_ALIASES = {
  ACCORD: 'A',
  'ACCORD PARTY': 'A',
  'ACTION ALLIANCE': 'AA',
  'AFRICAN ACTION CONGRESS': 'AAC',
  'AFRICAN DEMOCRATIC CONGRESS': 'ADC',
  'ACTION DEMOCRATIC PARTY': 'ADP',
  'ALL PROGRESSIVES CONGRESS': 'APC',
  'ALL PROGRESSIVES GRAND ALLIANCE': 'APGA',
  'ALLIED PEOPLES MOVEMENT': 'APM',
  'ALL PROGRESSIVES PARTY': 'APP',
  'BOOT PARTY': 'BP',
  'NEW NIGERIA PEOPLES PARTY': 'NNPP',
  'PEOPLES REDEMPTION PARTY': 'PRP',
  'SOCIAL DEMOCRATIC PARTY': 'SDP',
  'YOUNG PROGRESSIVES PARTY': 'YPP',
  'ZENITH LABOUR PARTY': 'ZLP',
};

/** Normalise whatever the model called a party into its ballot code. */
export function normaliseParty(name) {
  if (name == null) return null;
  const s = String(name).toUpperCase().replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim();
  return PARTY_ALIASES[s] || s;
}

/**
 * HARD-WON, DO NOT PARAPHRASE. EC8A figures are routinely struck through with
 * the corrected figure written beside them, and a model with no warning
 * concatenates the two (a crossed-out 375 beside a final 7 reads as 3757). This
 * exact wording has been in production against Gemini; Qwen needs it just as
 * much. Only the final clause varies, because the live path omits an unreadable
 * party while the audit records it as an explicit null.
 */
export const crossedOutRule = (fallback) =>
  'IMPORTANT — corrections are common on EC8A sheets: a figure may be crossed out / struck through '
  + 'with the final figure written beside, above or after it. Read ONLY the final uncrossed figure. '
  + 'NEVER join crossed-out digits onto the final figure (a crossed-out 375 followed by a final 7 is 7, '
  + `not 3757). If you cannot tell which figure is final, ${fallback}.`;

/**
 * The audit schema.
 *
 * TWO CHOICES CARRY THE WHOLE DESIGN:
 *
 * 1. `words` is a STRING, never a number. The sheet's own redundancy is only a
 *    verifier while the two readings stay independent. Ask a model for two
 *    integers and it will reconcile them itself — silently, invisibly, and
 *    always in favour of agreement — and the cross-check becomes theatre. So the
 *    model transcribes the words cell as text and the already-tested
 *    wordsToNumber() in ec8a_words.js does the parsing, exactly as it does for
 *    PaddleOCR output. Same parser, same failure modes, comparable numbers.
 *
 * 2. `null` is legal everywhere, and the prompt says so. A model that has no way
 *    to answer "unreadable" will invent a plausible figure instead. For an
 *    election audit that is the one failure mode with no recovery: a wrong
 *    number that looks exactly like a right one. An explicit null costs us a row
 *    and buys back the ability to publish the rest.
 */
export function auditSchema(ballot = OSUN_2026_BALLOT) {
  const s = JSON.parse(JSON.stringify(AUDIT_SCHEMA));
  if (ballot && ballot.length) {
    // Pin the row COUNT as well as the codes. minItems is what actually stops
    // the omission: an enum alone still lets the model return one row and call
    // it done, and guided decoding will happily oblige.
    s.properties.parties.items.properties.party.enum = [...ballot];
    s.properties.parties.minItems = ballot.length;
    s.properties.parties.maxItems = ballot.length;
  }
  return s;
}

export const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['authentic', 'parties'],
  properties: {
    authentic: { type: 'string', enum: ['yes', 'unclear', 'no'] },
    reason: { type: ['string', 'null'] },
    state: { type: ['string', 'null'] },
    puCode: { type: ['string', 'null'] },
    registered: { type: ['integer', 'null'] },
    ballotsIssued: { type: ['integer', 'null'] },
    unusedBallots: { type: ['integer', 'null'] },
    accredited: { type: ['integer', 'null'] },
    spoiled: { type: ['integer', 'null'] },
    rejected: { type: ['integer', 'null'] },
    totalValid: { type: ['integer', 'null'] },
    usedBallots: { type: ['integer', 'null'] },
    parties: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['party', 'figures', 'words'],
        properties: {
          party: { type: 'string', enum: PARTY_CODES },
          figures: { type: ['string', 'null'] },
          words: { type: ['string', 'null'] },
        },
      },
    },
  },
};

/**
 * The BOX PASS: a second, narrow read of just the numbered summary boxes,
 * against a crop of the sheet's top-right corner.
 *
 * WHY A SECOND PASS EXISTS. On the full-archive run the model read the summary
 * boxes on only 57% of sheets while reading 95% of party cells — asked for
 * everything at once, it spends its attention on the big table and shrugs at
 * the boxes. A cropped, single-purpose request is the same technique that
 * settled sheet 29-01-02-004 by hand: cut the region out, blow it up, ask one
 * question.
 *
 * EVERY FIELD IS TEXT. The first run's schema still typed boxes as integers,
 * which carries the proven zero-padding bug: under grammar-constrained decoding
 * "06" can only begin `0`, the number closes, and the 6 is gone — that is
 * exactly how sheet 003's spoiled "014" was read as 0. The cell text keeps what
 * the officer wrote; figuresOf() does the interpreting.
 */
export const BOX_FIELDS = [
  'registered', 'accredited', 'ballotsIssued', 'unusedBallots',
  'spoiled', 'rejected', 'totalValid', 'usedBallots',
];

export const BOXES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...BOX_FIELDS],
  properties: Object.fromEntries(BOX_FIELDS.map((f) => [f, { type: ['string', 'null'] }])),
};

export function boxesPrompt() {
  return [
    'This image is the top-right corner of a Nigerian INEC EC8A polling-unit result sheet: a small',
    'table of numbered summary boxes labelled #1 to #8, each with a handwritten value.',
    'Transcribe the EIGHT values. Reply with ONLY a JSON object of this shape:',
    JSON.stringify({
      registered: '<#1 Number of Voters on the Register>',
      accredited: '<#2 Number of Accredited Voters>',
      ballotsIssued: '<#3 Number of Ballot Papers Issued to the Polling Unit>',
      unusedBallots: '<#4 Number of Unused Ballot Papers>',
      spoiled: '<#5 Number of Spoiled Ballot Papers>',
      rejected: '<#6 Number of Rejected Ballots>',
      totalValid: '<#7 Number of Total Valid Votes>',
      usedBallots: '<#8 Total Number of Used Ballot Papers>',
    }),
    '',
    'RULES:',
    '1. Transcribe each value as TEXT, exactly as written. Keep leading zeros ("06" stays "06"). '
      + 'Keep dashes the officer drew around a figure ("-0-") - decoration, never a minus sign. '
      + 'Keep words like NIL or ZERO as written. Do not tidy, pad or convert anything.',
    '2. Use null for any box that is blank or that you cannot read with confidence. null is always '
      + 'acceptable and always preferred over a guess. Do not infer a value from the other boxes or '
      + 'from what would make the arithmetic work.',
    '3. Match values to boxes by the printed #1-#8 labels, not by position alone - handwriting often '
      + 'sits low in its row, drifting toward the box below.',
    '',
    crossedOutRule('use null for that box'),
  ].join('\n');
}

/** The audit read prompt. */
/**
 * THIRD PASS: the party table alone, with EMPTY separated from ILLEGIBLE.
 *
 * The box pass proved the technique — crop one region, ask one question, and
 * summary-box coverage went from 55% to 92%. This applies it to the other half
 * of the sheet, which after that pass is what actually blocks the audit: the
 * party column is unresolved on 1,326 sheets and party_sum is unknown on 964,
 * more than any box.
 *
 * THE SCHEMA WAS HIDING THE ANSWER. 7,095 of the stuck rows came back with
 * BOTH cells null, and null carries two completely different meanings that the
 * old schema could not tell apart:
 *
 *     the cell is EMPTY          — the officer wrote nothing, or drew a dash,
 *                                  because the party polled nothing. That is a
 *                                  result. It is a zero.
 *     the cell is ILLEGIBLE      — there are marks and we cannot resolve them.
 *                                  That is genuinely unknown.
 *
 * Collapsing those into one value is why a third of the archive sits in review.
 * It is also why the obvious shortcut — "most rows are zero, call the nulls
 * zero" — had to be rejected: measured on the hand-labelled 20, 2 of 6 null
 * rows carried real votes. The fix is not to guess which kind of null it is,
 * it is to ASK, and to let the sheet say "" for empty and null for unreadable.
 *
 * Every cell is TEXT for the reason documented on BOXES_SCHEMA: an integer
 * schema silently truncates a zero-padded "05" to 0 and deletes five votes.
 */
/**
 * The party-table crop, as fractions of the full sheet.
 *
 * Exported so the worker and the preview tool cannot drift apart. A preview
 * that does not match what the worker actually sends is worse than no preview:
 * it certifies a crop nobody used.
 *
 * Measured off this archive's 1500x2000 scans, then loosened hard. The table's
 * S/N column starts around 15% across and the words column ends around 70%
 * where the polling-agent signatures begin; rows run from about 30% down to the
 * TOTAL VALID VOTES line near 80%. But these are photographs of paper on a
 * desk, and framing moves: on 29-13-07-001 the whole table sits far enough down
 * that a bottom bound of 86% clipped the TOTAL row's handwritten values while
 * leaving its printed label visible — the most dangerous kind of miss, since
 * the crop still looks complete.
 *
 * The two errors are not symmetric. Too much costs a few tokens. Too little
 * costs the row, silently, in a way indistinguishable from an unreadable cell.
 *
 * `scale` is what the crop is enlarged by afterwards, and it is NOT free.
 * Qwen turns pixels into tokens, so at 2x this crop became ~7,800 vision tokens
 * — enough to overrun an 8k context outright, and enough that fourteen in
 * flight put the vision encoder's activations into CUDA OOM and killed the
 * server mid-run.
 *
 * More to the point, 2x was buying nothing. The source sheets are 1500x2000, so
 * this crop is 1080px wide at source; enlarging it to 2160 invents pixels above
 * the resolution the scan actually holds. 1.4x keeps essentially all the detail
 * that is really there at roughly half the tokens. Anything that changes this
 * number changes what the model sees, so it is re-calibrated against the hand
 * labels afterwards — never assumed to be harmless.
 */
export const PARTY_TABLE_CROP = { left: 0.06, right: 0.78, top: 0.24, bottom: 0.95, scale: 1.6 };

export function partyTableSchema(ballot = OSUN_2026_BALLOT) {
  const cell = {
    type: 'object',
    additionalProperties: false,
    required: ['figures', 'words'],
    properties: { figures: { type: ['string', 'null'] }, words: { type: ['string', 'null'] } },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['parties', 'totalRow'],
    properties: {
      parties: {
        type: 'array',
        minItems: ballot.length,
        maxItems: ballot.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['party', 'figures', 'words'],
          properties: {
            party: { type: 'string' },
            figures: { type: ['string', 'null'] },
            words: { type: ['string', 'null'] },
          },
        },
      },
      /**
       * THE ROW NOBODY WAS READING. Below the fifteen parties the EC8A carries
       * a TOTAL VALID VOTES line the presiding officer fills in by hand, in
       * figures and in words — a fourth, independent statement of #7, written
       * by a different act than either the party column or the summary box.
       *
       * Nothing in the audit captured it until now, which is why sheet
       * 29-01-03-003 needed a human to notice its three different totals (party
       * column 348, TOTAL row 347, box #7 349). Capturing it makes that a check
       * the pipeline can run on all 3,742 sheets instead of one.
       */
      totalRow: cell,
    },
  };
}

export function partyTablePrompt(ballot = OSUN_2026_BALLOT) {
  return [
    'This image is the party results table from a Nigerian INEC EC8A polling-unit result sheet.',
    `It has EXACTLY ${ballot.length} rows, one per political party, printed in this fixed order:`,
    `  ${ballot.join(', ')}`,
    'Each row has the party name, then the votes written in FIGURES, then the same number written in WORDS.',
    '',
    'Below the party rows there is a TOTAL VALID VOTES row, also written in figures and in words.',
    '',
    'Reply with ONLY a JSON object of this shape:',
    JSON.stringify({
      parties: [{ party: '<party code>', figures: '<figures cell>', words: '<words cell>' }],
      totalRow: { figures: '<TOTAL VALID VOTES in figures>', words: '<TOTAL VALID VOTES in words>' },
    }),
    '',
    'RULES:',
    `1. Return exactly ${ballot.length} rows, in the order listed above, each party EXACTLY ONCE. `
      + 'Never repeat a party and never drop one, even if its row is hard to find.',
    '2. THE MOST IMPORTANT RULE. For each cell choose ONE of three answers:',
    '   - the text as written, if you can read it (keep leading zeros: "05" stays "05")',
    '   - "" (empty string) if the cell is EMPTY — nothing written in it at all, or only a dash, '
      + 'stroke or NIL mark meaning no votes',
    '   - null if there ARE marks in the cell but you cannot read them with confidence',
    '   "" and null are NOT interchangeable. "" says the officer recorded no votes. null says we '
      + 'cannot tell what the officer recorded. Getting this backwards either invents a zero where '
      + 'a vote was cast, or throws away a result that was plainly recorded.',
    '3. Read the two cells INDEPENDENTLY. Do not spell out the figure you read and put it in "words", '
      + 'and do not convert the words into a number for "figures". They are cross-checked against each '
      + 'other afterwards, so copying one into the other destroys the only check this table carries. '
      + 'If one cell is empty and the other is not, say so — that is a real and useful observation.',
    '4. Do not infer a number from the other rows, from a total, or from what would make the column '
      + 'add up. Guessing is worse than null. In particular, do NOT compute the TOTAL VALID VOTES '
      + 'row by adding the party rows up: read what is written on that line, whatever it says. The '
      + 'point of reading it separately is to find out when it does NOT match.',
    '',
    crossedOutRule('use null for that cell'),
  ].join('\n');
}

export function auditPrompt(ballot = OSUN_2026_BALLOT) {
  return [
    'This image is a photograph of a Nigerian INEC EC8A polling-unit result sheet.',
    'Transcribe it. Reply with ONLY a JSON object matching this shape:',
    JSON.stringify({
      authentic: 'yes|unclear|no',
      reason: '<short, or null>',
      state: '<State name in the sheet header, or null>',
      puCode: '<polling unit code on the sheet, or null>',
      registered: null,
      ballotsIssued: null,
      unusedBallots: null,
      accredited: null,
      spoiled: null,
      rejected: null,
      totalValid: null,
      usedBallots: null,
      // NEVER put a real-looking number here. The example used to read
      // { party: 'APC', figures: '308', words: 'THREE HUNDRED AND EIGHT' }, and
      // across the Osun archive APC came back as exactly 308 thirty-eight times
      // against a base rate of about one for each neighbouring value. Worse,
      // every one of those arrived with BOTH cells filled in and agreeing, so
      // the figures-vs-words cross-check — the one mechanism built to catch
      // invention — endorsed all thirty-eight. A model that loses its place on
      // a hard sheet falls back on the sample it was shown, and the sample was
      // a plausible, well-formed, arithmetically live lie. Placeholders only.
      parties: [{ party: '<party code>', figures: '<figures cell, as written>', words: '<words cell, as written>' }],
    }),
    '',
    'RULES:',
    '1. Use null for ANY value you cannot read with confidence. null is always an acceptable answer '
      + 'and is strongly preferred over a guess. Do not infer a number from context, from the other '
      + 'numbers on the sheet, or from what would make the totals add up.',
    '2. For each party row, report BOTH cells INDEPENDENTLY, each as TEXT, exactly as written. '
      + 'Keep leading zeros ("05" stays "05", not 5). Keep any dashes the officer drew around the '
      + 'figure ("-02-") - they are decoration, never a minus sign. Do not tidy, pad or convert '
      + 'anything: copy the marks in the cell.',
    '3. DO NOT spell out the figure you read and put that in "words". DO NOT convert the words into a '
      + 'number and put that in "figures". The two cells are checked against each other afterwards, so '
      + 'copying one into the other destroys the only check this sheet carries. If one cell is blank or '
      + 'illegible, that cell is null even when the other is perfectly clear.',
    `4. The party table has EXACTLY ${ballot.length} rows, printed in this fixed order:`,
    `   ${ballot.join(', ')}`,
    `   Return exactly ${ballot.length} objects in "parties", one per row, in that same order. Never skip a row. `
      + 'Most rows on a typical sheet are zero — a row showing 0 or the word ZERO is a real result and must be '
      + 'reported as figures 0, not omitted and not null. Omitting a row silently changes the totals, which is '
      + 'the worst thing you can do to this document.',
    `   EVERY ONE of the ${ballot.length} party codes must appear EXACTLY ONCE. Do not repeat a party to reach `
      + `${ballot.length} rows, and do not let a repeat push another party out of the list. If you cannot find a `
      + 'row for a party, still emit that party with both cells null — a null row is recoverable, a party that '
      + 'silently became a second copy of its neighbour is not.',
    '5. The summary boxes, numbered #1-#8 on the sheet: "registered" is #1 voters on the register, '
      + '"accredited" #2 accredited voters, "ballotsIssued" #3 ballot papers issued to the unit, '
      + '"unusedBallots" #4 unused ballot papers, "spoiled" #5, "rejected" #6, "totalValid" #7 total '
      + 'valid votes, "usedBallots" #8 total used ballot papers. Read each from its own box; null if '
      + 'absent or unreadable.',
    '6. Set authentic="no" if this is a screenshot, digitally edited, AI-generated, or not an EC8A at all; '
      + '"unclear" if you cannot tell; "yes" for a normal photograph of a real sheet.',
    '',
    crossedOutRule('use null for that figure'),
  ].join('\n');
}

/**
 * Pull a JSON object out of a model reply. Models wrap JSON in prose or fences
 * even when told not to; guided decoding makes that rare, not impossible, and a
 * long archive run finds every rare case. Returns null rather than throwing —
 * the caller records the raw text so a parse failure is recoverable later
 * without paying for the inference again.
 */
export function parseModelJson(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const base = [fenced && fenced[1], /\{[\s\S]*\}/.exec(s)?.[0], s].filter(Boolean);
  // An unconstrained model writes a zero-padded figure exactly as the officer
  // did — `"spoiled": 06` — which is not valid JSON and threw away two
  // otherwise-complete sheets. Strip the leading zeros and try again rather
  // than lose the read over notation.
  const candidates = [...base, ...base.map((c) => c.replace(/:\s*0+(\d)/g, ': $1'))];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try the next shape */ }
  }
  return null;
}
