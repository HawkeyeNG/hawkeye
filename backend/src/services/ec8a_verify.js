/**
 * EC8A arithmetic self-verification.
 *
 * WHY THIS EXISTS. ec8a_words.js checks each party's count against the same
 * count written in words. This checks the sheet's numbers against EACH OTHER:
 * the party votes must sum to the total valid votes, the ballot account must
 * balance, and votes cast cannot exceed the people accredited to cast them.
 * Together they mean a published figure rests on the sheet's own internal
 * consistency rather than on anyone's confidence in an OCR engine or a model.
 *
 * THE STATUS MODEL IS THE POINT. Every check returns pass / fail / unknown, and
 * `unknown` is never quietly folded into `pass`. A sheet where we could not read
 * the total is not a sheet that balanced. Reporting those two the same way is
 * how an audit ends up asserting things it never checked.
 *
 * Nothing here decides anything. A `fail` is a sheet for a human to look at —
 * it can mean a misread, an arithmetic slip by a tired presiding officer at 6pm,
 * or something worse, and this module has no way to tell those apart.
 */
import { wordsToNumber, figuresOf } from './ec8a_words.js';

/**
 * A polling unit has at most ~1,000 registered voters (INEC splits beyond that),
 * so a five-figure count is a misread — a table rule read as digits, a serial
 * number caught from the next column. Kept as a flag rather than a silent drop:
 * the number is still evidence of something, just not of a vote total.
 */
const IMPLAUSIBLE = 10000;

/**
 * Reconcile one party row's two cells into a single value plus how we know it.
 *
 *   both      figures and words agree            — the assertable case
 *   figures   only the digits were readable      — usable, weaker
 *   words     only the words were readable       — usable, weaker
 *   conflict  both readable and they DISAGREE    — value is null, on purpose
 *   none      neither was readable
 *
 * `conflict` deliberately yields no value. Picking the figures because digits
 * "feel" more reliable would answer the one question the cross-check exists to
 * ask, and would do it with a coin flip.
 */
export function resolveRow(row, { emptyMeansZero = false } = {}) {
  const party = row && row.party ? String(row.party).toUpperCase() : null;
  // figures arrives as the TEXT of the cell, and is parsed by the same
  // figuresOf() used on OCR output. Asking a model for a JSON integer here
  // looked tidier and quietly destroyed data: under schema-constrained
  // decoding a zero-padded "05" can only begin `0`, the grammar then forces
  // the number closed, and five votes vanish into a plausible-looking 0.
  // A dash-wrapped "-02-" came back as -2 the same way. The cell text keeps
  // what the officer actually wrote; interpreting it is our job, in code we
  // can test. Integers are still accepted so older runs still parse.
  //
  // A NEGATIVE reading is never a negative vote - the smallest possible count
  // is zero - so a minus sign can only be a dash the officer drew beside the
  // figure. Take the magnitude rather than dropping the cell: -2 is 2, and
  // discarding it would throw away a reading we can be sure of.
  //
  // AN EMPTY CELL IS NOT AN UNREADABLE ONE. The third pass reports "" when the
  // officer wrote nothing (or only a dash or NIL) and null when there are marks
  // it cannot resolve. Under the older schema both arrived as null, which is
  // why 7,095 rows across the archive are stuck: a blank cell — a real result,
  // meaning no votes — was indistinguishable from an illegible one.
  //
  // An empty cell reads as 0, but its PROVENANCE is kept separate. Corroborated
  // by the other cell (also empty, or spelling out zero) it is as good as any
  // agreement. Alone, with the other cell unreadable, it is a single
  // observation and keeps the sheet in review — the same treatment a lone
  // readable cell gets, for the same reason.
  //
  // OPT-IN, AND IT HAS TO BE. The rule only holds for readings taken under the
  // third-pass prompt, which explicitly asks for "" on an empty cell and null
  // on an illegible one. The archive already contains 39 empty figures cells
  // and 213 empty words cells produced under the OLD prompt, which never
  // defined "" at all — the model simply emitted it. Applying this rule to
  // those would invent 252 zeroes out of readings that meant nothing in
  // particular, which is the same class of error as the zero-fill shortcut that
  // was already rejected on measurement. Default off; the party-table merge
  // turns it on for rows it knows came from the new pass.
  //
  // A DRAWN DASH IS A WRITTEN ZERO. On 29-20-08-001 twelve of the fifteen rows
  // hold a single ruled stroke in both cells and nothing else; the three that
  // carry numbers are 127 + 2 + 72, and the officer's own TOTAL row says 201.
  // The sheet is completely legible. Yet a lone "—" parses to null exactly like
  // an unreadable smudge, which is how a clean sheet ends up with twelve
  // "unread" rows — and why the 6-to-15-rows-missing bucket was misdiagnosed as
  // scan quality. `-0-` and `O` and `NIL` were already handled; a bare stroke
  // was the gap. Struck through only when the whole cell is strokes: `-02-` is
  // a figure with decoration and must keep its 2.
  const DASHES_ONLY = /^[\s\-—–_=~/\\|.]*$/;
  // BLANK is the EXPLICIT empty-cell token (see note 3 in ec8a_prompt.js). The
  // schema no longer accepts the empty string, because the model answered ""
  // 10,983 times and null ZERO times: an empty string let it satisfy the schema
  // without either reading the cell or admitting it could not. A cell is now
  // empty only because the model SAID so, which is a claim it can be held to.
  //
  // The empty string is still honoured on the way IN. The archive holds 10,983
  // of them written under the old prompt, and reinterpreting those after the
  // fact would invent readings we never had.
  const isEmpty = (v) => emptyMeansZero && typeof v === 'string'
    && (v.trim().toUpperCase() === 'BLANK' || DASHES_ONLY.test(v));
  const figuresEmpty = isEmpty(row?.figures);
  const wordsEmpty = isEmpty(row?.words);

  const figures = figuresEmpty ? 0 : (typeof row?.figures === 'number'
    ? (Number.isInteger(row.figures) ? Math.abs(row.figures) : null)
    : (row?.figures == null ? null : figuresOf(row.figures)));
  const words = wordsEmpty ? 0 : (row?.words == null ? null : wordsToNumber(row.words));

  let value = null;
  let confidence = 'none';
  if (figures !== null && words !== null) {
    if (figures === words) {
      value = figures;
      // Two independent observations that the cell is blank corroborate each
      // other exactly as two readings of a number would.
      confidence = 'both';
    } else {
      // A blank figures cell against a written FIFTY is not a misread to be
      // smoothed over — it is the sheet disagreeing with itself, which is the
      // whole reason the two cells are read separately.
      confidence = 'conflict';
    }
  } else if (figures !== null) { value = figures; confidence = figuresEmpty ? 'empty' : 'figures'; }
  else if (words !== null) { value = words; confidence = wordsEmpty ? 'empty' : 'words'; }

  return { party, figures, words, value, confidence };
}

const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Reconcile one summary box across the two passes: the full-sheet read (an
 * integer under the old schema) and the box pass (the cell's text).
 *
 *   both      the two independent reads agree          — the assertable case
 *   p1 / p2   only one pass produced a value           — usable, weaker
 *   p2-trunc  pass 1 said 0 and pass 2's text BEGINS with 0 ("06", "-014-").
 *             That is the documented integer-grammar truncation: constrained
 *             decoding emits the leading 0, the number closes, the rest is
 *             lost. Pass 2's text is what the officer wrote, so it wins.
 *   conflict  both read, disagree, no known cause      — value is null, on
 *             purpose. Picking a side here is a coin flip wearing a lab coat.
 *
 * Pass-1 negatives are dash artifacts (a count cannot be below zero), so they
 * are read at magnitude before comparing — same rule as party figures.
 */
export function resolveBoxPair(p1, p2raw) {
  const a = Number.isInteger(p1) ? Math.abs(p1) : null;
  const b = p2raw == null ? null : figuresOf(p2raw);
  if (a === null && b === null) return { value: null, source: 'none' };
  if (a === null) return { value: b, source: 'p2' };
  if (b === null) return { value: a, source: 'p1' };
  if (a === b) return { value: a, source: 'both' };
  if (a === 0 && b > 0 && /^[\s\-—–=_.]*0/.test(String(p2raw))) return { value: b, source: 'p2-trunc' };
  return { value: null, source: 'conflict' };
}

/**
 * Run every arithmetic check over one transcribed sheet.
 *
 * @param {object} sheet  a VLM/OCR transcription: { parties: [{party,figures,words}],
 *                        registered, accredited, spoiled, rejected, totalValid, usedBallots }
 * @returns {{rows, checks, summary}}
 */
export function verifySheet(sheet, {
  expectedParties = 0, spentChecks = null, rowIntegrity = null, dropped = [], emptyMeansZero = false,
  resolvedRows = null,
} = {}) {
  // `resolvedRows` is for callers who have already reconciled each row across
  // two passes — that reconciliation needs both readings side by side and
  // cannot be reproduced from a single merged cell, so it happens outside and
  // the result is handed in. Everything below is unchanged either way.
  const rows = resolvedRows || (Array.isArray(sheet?.parties)
    ? sheet.parties.map((r) => resolveRow(r, { emptyMeansZero }))
    : []);
  const registered = num(sheet?.registered);
  const ballotsIssued = num(sheet?.ballotsIssued);
  const unusedBallots = num(sheet?.unusedBallots);
  const accredited = num(sheet?.accredited);
  const spoiled = num(sheet?.spoiled);
  const rejected = num(sheet?.rejected);
  const totalValid = num(sheet?.totalValid);
  const usedBallots = num(sheet?.usedBallots);

  const checks = [];
  /**
   * A constraint SPENT choosing between two candidate readings cannot also be
   * reported as a check that reading passed — that is circular, and it is how
   * an audit ends up certifying its own assumptions. ec8a_resolve.js only ever
   * spends a constraint when a second, independent one agrees, so the surviving
   * check is the real verification and this one is downgraded to `assumed`.
   */
  const add = (name, status, severity, detail) => {
    if (spentChecks && spentChecks.has(name) && status !== 'unknown') {
      checks.push({
        name,
        status: 'assumed',
        severity: 'none',
        detail: { ...detail, note: 'used to adjudicate a disputed reading — not an independent check' },
      });
      return;
    }
    checks.push({ name, status, severity, detail });
  };

  // --- party votes vs the declared total -----------------------------------
  // A missing row makes the sum a LOWER BOUND, not an unknown quantity, and a
  // lower bound is still decisive in one direction: if what we CAN read already
  // exceeds the declared total, the rows we cannot read can only make it worse.
  // Concluding from incomplete data is safe here precisely because the missing
  // terms are non-negative — so the check reports `fail` rather than shrugging.
  const known = rows.filter((r) => r.value !== null);
  // A SHORT LIST IS MISSING DATA, NOT A COMPLETE ONE.
  //
  // Rows the transcriber never reported are indistinguishable, from in here,
  // from rows the sheet never had — and the difference decides whether a sum
  // mismatch is a finding or our own omission. Observed on the first real run:
  // Qwen returned ONE party row for a 15-row sheet, every listed row resolved
  // cleanly, so "nothing is missing" was true of the list and false of the
  // sheet. 11 of 20 sheets got flagged for a discrepancy that was entirely ours.
  // Callers who know the ballot pass its length; rows below that count as
  // missing, which downgrades the check to `unknown` instead of inventing a
  // finding.
  const omitted = Math.max(0, expectedParties - rows.length);
  const missing = (rows.length - known.length) + omitted;
  const partySum = known.reduce((a, r) => a + r.value, 0);
  // A ROW COUNT IS NOT A ROW SET.
  //
  // `omitted` above compares fifteen against fifteen and concludes nothing is
  // missing. Fifteen rows holding APC twice and no A satisfies that test while
  // double-counting one party's votes and dropping another's — the sum is then
  // wrong by construction, party_sum fails, and the sheet is flagged for a
  // discrepancy we manufactured. Eighteen archive sheets did exactly this, all
  // dropping the first row. Caller passes checkRowIntegrity()'s result; a
  // broken row set makes the sum meaningless, so there is nothing to check.
  if (rowIntegrity && !rowIntegrity.ok) {
    add('party_sum', 'unknown', 'none', {
      partySum, totalValid,
      duplicates: rowIntegrity.duplicates,
      missingParties: rowIntegrity.missing,
      stray: rowIntegrity.stray,
      note: 'the transcribed rows are not the ballot: '
        + `${rowIntegrity.duplicates.map((d) => `${d.party} x${d.times}`).join(', ') || 'no duplicates'}`
        + `${rowIntegrity.missing.length ? `; missing ${rowIntegrity.missing.join(', ')}` : ''}`
        + ' — the sum cannot mean anything until the sheet is re-read',
    });
  } else if (totalValid === null) {
    add('party_sum', 'unknown', 'none', { partySum, missing, note: 'total valid votes not readable' });
  } else if (missing > 0) {
    add('party_sum', partySum > totalValid ? 'fail' : 'unknown', partySum > totalValid ? 'high' : 'none', {
      partySum, totalValid, missing, omitted,
      note: partySum > totalValid
        ? `${missing} row(s) unread, but the readable votes alone already exceed the declared total`
        : `${missing} row(s) unread${omitted ? ` (${omitted} never reported)` : ''}`
          + ` — the sum is a lower bound of ${partySum}`,
    });
  } else {
    const ok = partySum === totalValid;
    add('party_sum', ok ? 'pass' : 'fail', ok ? 'none' : 'high', {
      partySum, totalValid, delta: partySum - totalValid,
    });
  }

  // --- ballot account: spoiled + rejected + valid == used -------------------
  if ([spoiled, rejected, totalValid, usedBallots].some((v) => v === null)) {
    add('ballot_account', 'unknown', 'none', { spoiled, rejected, totalValid, usedBallots });
  } else {
    const lhs = spoiled + rejected + totalValid;
    const ok = lhs === usedBallots;
    add('ballot_account', ok ? 'pass' : 'fail', ok ? 'none' : 'medium', {
      spoiled, rejected, totalValid, usedBallots, sum: lhs, delta: lhs - usedBallots,
    });
  }

  // --- over-voting: used ballots must not exceed accredited voters ----------
  // The legally consequential one. Under s.51 of the Electoral Act 2022, votes
  // cast exceeding accredited voters at a unit is the definition of over-voting
  // and the ground on which a unit's result gets cancelled. Flagged high — but
  // still only flagged: a misread accreditation figure produces exactly this
  // shape, and telling the two apart needs a human and the BVAS record.
  // BALLOTS CAST, NOT BALLOTS USED. #8 counts spoiled papers, and a spoiled
  // ballot is replaced - the same voter legitimately consumes two. Testing
  // `usedBallots > accredited` therefore fires on any sheet where anything
  // was spoiled: on the 20 hand-labelled sheets it fired 5 times, and 4 of
  // those were purely the spoiled count. What actually went into the box is
  // valid + rejected, and that fired once - on the one sheet that genuinely
  // has more votes than accredited voters.
  const cast = totalValid === null || rejected === null ? null : totalValid + rejected;
  if (cast === null || accredited === null) {
    add('over_voting', 'unknown', 'none', { cast, accredited, totalValid, rejected });
  } else {
    const ok = cast <= accredited;
    add('over_voting', ok ? 'pass' : 'fail', ok ? 'none' : 'high', {
      cast, accredited, totalValid, rejected, excess: cast - accredited,
    });
  }

  // --- accredited cannot exceed registered ---------------------------------
  if (accredited === null || registered === null) {
    add('accredited_vs_registered', 'unknown', 'none', { accredited, registered });
  } else {
    const ok = accredited <= registered;
    add('accredited_vs_registered', ok ? 'pass' : 'fail', ok ? 'none' : 'high', {
      accredited, registered, excess: accredited - registered,
    });
  }

  // --- valid votes cannot exceed ballots used ------------------------------
  if (totalValid === null || usedBallots === null) {
    add('valid_vs_used', 'unknown', 'none', { totalValid, usedBallots });
  } else {
    const ok = totalValid <= usedBallots;
    add('valid_vs_used', ok ? 'pass' : 'fail', ok ? 'none' : 'medium', {
      totalValid, usedBallots, excess: totalValid - usedBallots,
    });
  }

  // --- ballot stock: issued - unused == used -------------------------------
  //
  // The most useful check on the sheet, and the last one added - because it is
  // the only one that pins #1/#3, which nothing else constrains. Boxes #3 and
  // #4 were not even in the schema until a human rejected a label of mine:
  // I read #1/#3 as 413 where the sheet says 415, every other check passed,
  // and the sheet sailed through as `publishable`. 413 - 231 = 182 against
  // #8's 184; 415 - 231 = 184. One subtraction would have caught it.
  //
  // It is independent of the party column and of the accreditation side, so it
  // catches a class of error the other three cannot see.
  if (ballotsIssued === null || unusedBallots === null || usedBallots === null) {
    add('ballot_stock', 'unknown', 'none', { ballotsIssued, unusedBallots, usedBallots });
  } else {
    const dispensed = ballotsIssued - unusedBallots;
    const ok = dispensed === usedBallots;
    add('ballot_stock', ok ? 'pass' : 'fail', ok ? 'none' : 'medium', {
      ballotsIssued, unusedBallots, usedBallots, dispensed, delta: dispensed - usedBallots,
    });
  }

  // --- registered voters vs ballot papers issued ---------------------------
  //
  // CLOSES THE LAST HOLE. #1 was the only box no check constrained, and it was
  // wrong twice before anyone noticed: a hand label read 413 for 415, and a
  // sheet read 996 where #3 said 995. The obvious fix - compare it against
  // INEC's published register - is not available: this project holds no
  // registered-voter figures at all (the column exists and is null for every
  // one of the 176,846 units).
  //
  // But the sheet closes it itself. INEC issues one ballot paper per
  // registered voter, so #3 == #1, and ballot_stock already pins #3 from #4
  // and #8. That makes #1 constrained transitively, with no external data.
  // Verified on the hand labels: 18 of the 19 sheets where #3 was readable.
  //
  // LOW severity deliberately. The 19th differed by one (996 vs 995) - a real
  // inconsistency on the paper, but it moves no vote. Reporting it as loudly
  // as over-voting would bury the findings that matter under clerical noise.
  if (registered === null || ballotsIssued === null) {
    add('registered_vs_issued', 'unknown', 'none', { registered, ballotsIssued });
  } else {
    const ok = registered === ballotsIssued;
    add('registered_vs_issued', ok ? 'pass' : 'fail', ok ? 'none' : 'low', {
      registered, ballotsIssued, delta: ballotsIssued - registered,
    });
  }

  // --- the officer's own TOTAL VALID VOTES row -----------------------------
  //
  // Below the fifteen party rows the EC8A carries a TOTAL VALID VOTES line the
  // presiding officer fills in by hand, in figures and in words. It is a fourth
  // independent statement of #7 — produced by a different act than either
  // adding up the party column or copying a number into a box — and until the
  // party-table pass nothing in this pipeline read it.
  //
  // That omission is why sheet 29-01-03-003 needed a human to notice its three
  // different totals: party column 348, TOTAL row 347, box #7 349. Two of the
  // three were always visible to the checks here; the third was not.
  //
  // LOW, and measured rather than assumed. Across the first 177 sheets this
  // check could run on, it disagreed on 38 — and the differences did not look
  // like arithmetic. Roughly 40% were out by 1-20, which is what a tired
  // officer adding fifteen figures at 6pm produces; the other 60% were out by
  // hundreds or more, including a TOTAL row read as 1,618,126. That is the
  // signature of a misread, ours or in the scan.
  //
  // A check that is wrong a third of the time must not put sheets in the
  // flagged pile beside genuine over-voting. At `low` it still blocks
  // publication — something on the sheet did not reconcile — and routes to
  // `review`, which is the honest description: a human should look at this.
  // 29-01-03-003, the real three-totals anomaly, lands there too, and Stage 1
  // triage draws from both queues.
  //
  // NOT LOOKING IS NOT THE SAME AS LOOKING AND FAILING. The party-table pass
  // runs on a subset of the archive, so most sheets have no `totalRow` field at
  // all. Reporting those as `unknown` would add a check nobody ran to every one
  // of them and knock every currently-publishable sheet down to review — a
  // change in what we CLAIM, produced by a change in what we MEASURE, which is
  // exactly backwards. Absent field: no check. Present but null: unknown.
  //
  // A LINE THE OFFICER NEVER FILLED IN IS NOT A LINE WE FAILED TO READ. On
  // 29-28-02-009 the TOTAL VALID VOTES row is simply empty — the sheet is
  // otherwise clean and completely legible. Reporting that as `unknown` would
  // say the transcription is incomplete, which is false, and would knock every
  // such sheet out of publishable the moment this check was introduced: a
  // change in what we CLAIM produced by a change in what we MEASURE. `n/a`
  // records the observation without pretending it is a gap in our work.
  const rawTotal = sheet && 'totalRow' in sheet ? sheet.totalRow : undefined;
  // The same ceiling the boxes get: a polling unit cannot poll 1,618,126 votes,
  // and one sheet's TOTAL row came back exactly that. Feeding it in would
  // produce a spectacular, entirely fictional discrepancy.
  const totalPlausible = (v) => (Number.isInteger(v) && v < IMPLAUSIBLE ? v : null);
  const totalRow = rawTotal === 'blank' ? 'blank'
    : (rawTotal === undefined ? undefined : totalPlausible(num(rawTotal)));
  if (totalRow === undefined) {
    /* the pass has not run on this sheet — say nothing */
  } else if (totalRow === 'blank') {
    add('total_row', 'n/a', 'none', { note: 'the officer left the TOTAL VALID VOTES line blank' });
  } else if (totalRow === null) {
    add('total_row', 'unknown', 'none', { totalRow, totalValid, note: 'the TOTAL VALID VOTES row was not read' });
  } else {
    const against = [];
    if (totalValid !== null) against.push({ what: '#7', value: totalValid, ok: totalRow === totalValid });
    if (!missing && rows.length) against.push({ what: 'party column', value: partySum, ok: totalRow === partySum });
    const bad = against.filter((x) => !x.ok);
    if (!against.length) {
      add('total_row', 'unknown', 'none', { totalRow, note: 'nothing readable to compare it against' });
    } else {
      add('total_row', bad.length ? 'fail' : 'pass', bad.length ? 'low' : 'none', {
        totalRow,
        comparisons: against,
        note: bad.length
          ? `the officer's TOTAL row says ${totalRow}, but ${bad.map((x) => `${x.what} says ${x.value}`).join(' and ')}`
          : null,
      });
    }
  }

  // --- magnitude sanity ----------------------------------------------------
  const wild = [
    ...rows.filter((r) => r.value !== null && r.value >= IMPLAUSIBLE).map((r) => `${r.party}=${r.value}`),
    ...Object.entries({ registered, ballotsIssued, unusedBallots, accredited, spoiled, rejected, totalValid, usedBallots })
      .filter(([, v]) => v !== null && v >= IMPLAUSIBLE).map(([k, v]) => `${k}=${v}`),
  ];
  // A value the resolver already discarded as impossible is reported, never
  // failed. `fail` here would say the SHEET is wrong; the truth is that our
  // READING is wrong, and the sheet is simply unread — which is `unknown`, and
  // lands the sheet in review rather than in the findings pile beside genuine
  // over-voting. Dropping the note altogether would be worse: it would leave a
  // garbage scan looking indistinguishable from a merely incomplete one.
  if (!wild.length && dropped.length) {
    add('magnitude', 'unknown', 'none', {
      dropped,
      note: `read ${dropped.map((d) => `${d.field}=${d.value}`).join(', ')} — impossible for a polling unit `
        + `(>= ${IMPLAUSIBLE}), so treated as unread rather than as a discrepancy`,
    });
  } else {
    add('magnitude', wild.length ? 'fail' : 'pass', wild.length ? 'medium' : 'none', {
      note: wild.length ? `implausible for a polling unit (>= ${IMPLAUSIBLE}): ${wild.join(', ')}` : null,
    });
  }

  const summary = {
    parties: rows.length,
    agree: rows.filter((r) => r.confidence === 'both').length,
    conflict: rows.filter((r) => r.confidence === 'conflict').length,
    // `empty` belongs here, not with the agreements: one cell observed blank
    // while the other could not be read is a single observation, and a single
    // observation must keep the sheet in review.
    // `empty` and `contested` belong here, not with the agreements. One cell
    // observed blank while the other could not be read is a single observation;
    // a value carried forward over a pass that contradicted itself is a value
    // three readings support and one disputes. Neither is "read twice, agreed".
    single: rows.filter((r) => ['figures', 'words', 'empty', 'contested'].includes(r.confidence)).length,
    emptyCells: rows.filter((r) => r.confidence === 'empty').length,
    contested: rows.filter((r) => r.confidence === 'contested').length,
    unread: rows.filter((r) => r.confidence === 'none').length,
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    unknown: checks.filter((c) => c.status === 'unknown').length,
    // Constraints spent adjudicating a disputed reading. Not a failure and not
    // a pass: reported separately so a sheet resting on one is never described
    // as having verified itself outright.
    assumed: checks.filter((c) => c.status === 'assumed').length,
    highSeverity: checks.filter((c) => c.status === 'fail' && c.severity === 'high').map((c) => c.name),
  };

  /**
   * PUBLISHABLE is the strictest state and it is deliberately hard to reach:
   * every party row read twice and agreeing, and every arithmetic check
   * actually run and passed. Anything short of that — one unknown check, one
   * single-sourced row — is `review`, which is not an accusation, just an
   * admission that the sheet did not fully verify itself.
   */
  // A `low` failure is a clerical inconsistency that moves no vote. It must
  // still block publication - something on the sheet did not reconcile - but
  // lumping it in with over-voting would drown the real findings.
  const seriousFail = checks.some((c) => c.status === 'fail' && c.severity !== 'low');
  const anyFail = summary.fail > 0;
  const everythingEstablished = summary.unknown === 0 && summary.conflict === 0
    && summary.unread === 0 && summary.single === 0;
  // A low failure must NOT reach `publishable`. Written the obvious way -
  // `seriousFail ? flagged : (everythingEstablished ? publishable : review)` -
  // a low-severity failure falls straight through to publishable, because
  // nothing in `everythingEstablished` looks at failures at all. That is the
  // silent-error shape this module exists to prevent, and it was live here for
  // one commit: a sheet with #1 misread and every other box right came out
  // publishable. `anyFail` is the guard.
  summary.verdict = seriousFail ? 'flagged'
    : (anyFail ? 'review'
      : (everythingEstablished ? 'publishable' : 'review'));

  return { rows, checks, summary };
}
