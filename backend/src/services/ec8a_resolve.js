/**
 * Stage 0 of the audit triage: drain what arithmetic can drain, before GPU.
 *
 * Two independent readings of every summary box exist (the full-sheet pass and
 * the cropped box pass). Where they agree, resolveBoxPair() in ec8a_verify.js
 * settles it. Where they disagree it yields null on purpose, because picking
 * the digits because they "feel" more reliable is a coin flip wearing a lab
 * coat. That refusal left 542 sheets with a nulled box.
 *
 * This module adds the third party to that argument: the sheet's own equations.
 *
 *     #5 + #6 + #7 == #8      ballot account
 *     #3 - #4      == #8      ballot stock
 *     sum(parties) == #7      party column
 *
 * Given two candidate readings for ONE box and the rest of the boxes known,
 * these can single one out. A misread digit satisfying two independent
 * equations at once is not impossible, but it is a coincidence, and requiring
 * two is what separates this from guessing.
 *
 * ── THE PART THAT KEEPS IT HONEST ─────────────────────────────────────────
 *
 * A constraint used to CHOOSE a value cannot then be reported as a check that
 * value PASSED. That is circular, and it is how an audit ends up certifying its
 * own assumptions. So exactly one supporting constraint is marked `spent`, and
 * verifySheet() reports it as `assumed` rather than `pass`. Adjudication is
 * only accepted with at least TWO supporters, which guarantees at least one
 * survives as a genuine, independent check of the chosen value.
 *
 * Counting degrees of freedom: two candidates is one bit of uncertainty. One
 * equation spends that bit. Every further equation is free verification.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * Zero-filling unread party rows. It is tempting — most rows on this ballot
 * poll nothing, blank cells are why a read comes back null, and it would
 * collapse the review pile overnight. Measured against the 20 hand-labelled
 * sheets, 2 of 6 null rows carried REAL VOTES (29-01-01-006 APGA=1,
 * 29-01-02-002 A=128). Both were rows where both cells read and DISAGREED.
 * A blanket zero-fill would have deleted live votes, which is the worst thing
 * this pipeline can do. See scripts/audit_null_rows.mjs — the rule is dead and
 * must stay dead unless someone measures it on sheets drawn from the blocked
 * population, not on the easy first twenty.
 */
import { figuresOf } from './ec8a_words.js';
import { BOX_FIELDS } from './ec8a_prompt.js';

/**
 * The constraints, strongest first.
 *
 * `hard` marks a relation the sheet must satisfy as a matter of arithmetic
 * rather than of practice. #1 == #3 is NOT hard: INEC issues one ballot per
 * registered voter as a rule, but the relation fails on 367 archive sheets and
 * on one of the 20 hand-labelled ones (996 vs 995), so it may support a choice
 * and may never carry it. Over-voting is an INEQUALITY — many values satisfy
 * it, so it is evidence, not selection.
 */
export const CONSTRAINTS = [
  {
    name: 'ballot_account',
    hard: true,
    uses: ['spoiled', 'rejected', 'totalValid', 'usedBallots'],
    test: (b) => b.spoiled + b.rejected + b.totalValid === b.usedBallots,
  },
  {
    name: 'ballot_stock',
    hard: true,
    uses: ['ballotsIssued', 'unusedBallots', 'usedBallots'],
    test: (b) => b.ballotsIssued - b.unusedBallots === b.usedBallots,
  },
  {
    name: 'party_sum',
    hard: true,
    uses: ['partySum', 'totalValid'],
    test: (b) => b.partySum === b.totalValid,
  },
  {
    name: 'registered_vs_issued',
    hard: false,
    uses: ['registered', 'ballotsIssued'],
    test: (b) => b.registered === b.ballotsIssued,
  },
  {
    name: 'over_voting',
    hard: false,
    inequality: true,
    uses: ['totalValid', 'rejected', 'accredited'],
    test: (b) => b.totalValid + b.rejected <= b.accredited,
  },
];

/**
 * A polling unit holds at most about a thousand registered voters — INEC splits
 * one that grows past that — so a box reading 597,961 is not a fact about the
 * election, it is a fact about our OCR: a table rule read as digits, a serial
 * number caught from the next column.
 *
 * The `magnitude` check already notices such a value. What it did not do was
 * stop it being USED: the number still flowed into ballot_account, ballot_stock
 * and over_voting, where it produced enormous, confident-looking discrepancies
 * — "225,000 more votes than accredited voters" at a unit with room for a
 * thousand — that sat in the flagged pile looking exactly like real findings.
 *
 * An impossible reading is not a reading. Treating it as unread moves the sheet
 * to `review`, which is the honest claim: we could not read it. That is not a
 * smaller finding, it is no finding. 10 of 1,091 flagged sheets fail only
 * checks that touch such a value.
 *
 * 10,000 is deliberately loose — nothing near a genuine unit total is a close
 * call, and the ceiling exists to catch garbage, not to second-guess turnout.
 */
export const IMPLAUSIBLE = 10000;
const plausible = (v) => (v !== null && v < IMPLAUSIBLE ? v : null);

/** Pass-1 gave an integer (dash artifacts arrive negative); pass 2 gave text. */
const pass1 = (v) => plausible(Number.isInteger(v) ? Math.abs(v) : null);
const pass2 = (v) => plausible(v == null ? null : figuresOf(v));

/**
 * The documented integer-grammar truncation: pass 1 said 0 and pass 2's text
 * BEGINS with 0, so the constrained decoder emitted the leading zero and closed
 * the number. Pass 2 is what the officer wrote. Settled already, not a conflict.
 */
const isTruncation = (a, b, raw) => a === 0 && b > 0 && /^[\s\-—–=_.]*0/.test(String(raw));

/**
 * Adjudicate the summary boxes of one sheet.
 *
 * @param {object} p1sheet    the full-sheet pass transcription
 * @param {object} p2raw      the box pass, field -> cell text
 * @param {number|null} partySum  the resolved party-column total, or null
 * @returns {{boxes, meta, spent, adjudicated}}
 *   boxes       field -> value|null, ready for verifySheet()
 *   meta        field -> how it was settled (both / p1 / p2 / p2-trunc /
 *               adjudicated / conflict / none)
 *   spent       Set of constraint names consumed making a choice — these must
 *               NOT be reported as passing checks
 *   adjudicated array of {field, chose, over, by} for the audit trail
 */
export function adjudicateBoxes(p1sheet, p2raw = {}, partySum = null) {
  const boxes = {};
  const meta = {};
  const candidates = {};
  // Kept, not discarded: what we read is still evidence about the scan, and a
  // sheet that produced garbage must not come out looking cleanly unreadable.
  const implausible = [];

  for (const f of BOX_FIELDS) {
    const rawA = Number.isInteger(p1sheet?.[f]) ? Math.abs(p1sheet[f]) : null;
    const rawB = p2raw?.[f] == null ? null : figuresOf(p2raw[f]);
    for (const [pass, v] of [['pass1', rawA], ['pass2', rawB]]) {
      if (v !== null && v >= IMPLAUSIBLE) implausible.push({ field: f, value: v, pass });
    }
    const a = pass1(p1sheet?.[f]);
    const b = pass2(p2raw?.[f]);
    if (a === null && b === null) {
      boxes[f] = null;
      meta[f] = implausible.some((x) => x.field === f) ? 'implausible' : 'none';
      continue;
    }
    if (a === null) { boxes[f] = b; meta[f] = 'p2'; continue; }
    if (b === null) { boxes[f] = a; meta[f] = 'p1'; continue; }
    if (a === b) { boxes[f] = a; meta[f] = 'both'; continue; }
    if (isTruncation(a, b, p2raw[f])) { boxes[f] = b; meta[f] = 'p2-trunc'; continue; }
    boxes[f] = null; meta[f] = 'conflict'; candidates[f] = [a, b];
  }

  const spent = new Set();
  const adjudicated = [];
  const conflicted = Object.keys(candidates);

  // One conflicted box at a time. Two simultaneous unknowns can be satisfied by
  // a pair of wrong values that happen to cancel, and disentangling that needs
  // the image, not more algebra.
  if (conflicted.length === 1) {
    const f = conflicted[0];
    const [a, b] = candidates[f];
    const env = { ...boxes, partySum };

    const usable = CONSTRAINTS.filter((c) => c.uses.includes(f)
      && c.uses.every((u) => u === f || Number.isInteger(env[u])));
    const supports = (v) => usable.filter((c) => c.test({ ...env, [f]: v }));
    const forA = supports(a);
    const forB = supports(b);

    // Accept only when one candidate is supported and the other is not at all.
    // A split verdict means the equations disagree about the sheet, which is a
    // finding in its own right, not a value to pick.
    const decide = (winners, losers, value, other) => {
      if (losers.length) return false;
      // THE QUORUM IS EQUALITIES ONLY.
      //
      // Two supporters, one of them a hard equality, was the first rule — and it
      // let 10 of 153 decisions rest on a hard equality plus `over_voting`,
      // which is an INEQUALITY. Once the equality is spent selecting, an
      // inequality is all that remains to "confirm" the choice, and a great many
      // values satisfy `cast <= accredited`. That is one constraint doing both
      // jobs, which is exactly the circularity this module exists to avoid.
      //
      // Inequalities may still support a candidate — an inequality the rejected
      // value violates is real evidence — they just cannot make up the quorum.
      const equalities = winners.filter((c) => !c.inequality);
      if (equalities.length < 2) return false;
      // The SELECTOR must be a hard equality: #1 == #3 is a convention INEC
      // follows rather than arithmetic the sheet guarantees, and it fails on
      // 367 sheets here, so it may corroborate but must never carry a choice.
      const selector = equalities.find((c) => c.hard);
      if (!selector) return false;
      boxes[f] = value;
      meta[f] = `adjudicated:${selector.name}`;
      spent.add(selector.name);
      adjudicated.push({
        field: f,
        chose: value,
        over: other,
        by: winners.map((c) => c.name),
        spent: selector.name,
        corroborated: winners.filter((c) => c.name !== selector.name).map((c) => c.name),
      });
      return true;
    };

    decide(forA, forB, a, b) || decide(forB, forA, b, a);
  }

  return { boxes, meta, spent, adjudicated, implausible };
}

/**
 * Reconcile one party row across the full-sheet pass and the party-table pass.
 *
 * Same discipline as the boxes: agreement is the assertable case, a lone
 * reading is usable but weaker, an unexplained disagreement yields null on
 * purpose. One asymmetry is deliberate and is the entire reason the third pass
 * exists.
 *
 * PASS 1 COULD NOT SAY "EMPTY". Its prompt offered only a value or null, so a
 * cell holding a single ruled stroke — how most presiding officers write "no
 * votes" — came back as null, indistinguishable from an illegible smudge. Pass
 * 3 is asked the question directly and can answer "". So where pass 1 has
 * nothing and pass 3 says the cell is empty, pass 3 wins: it is an affirmative
 * observation against an absence of one, not two readings in conflict.
 *
 * The reverse never holds. Pass 3 reporting empty where pass 1 read a NUMBER is
 * a real conflict and stays one — that is the direction in which a mistake
 * deletes votes, and 29-20-08-001 is only safe to resolve because both passes
 * agree the cells are bare.
 *
 * @param {object} p1  {party, figures, words} from the full-sheet pass
 * @param {object} p3  {party, figures, words} from the party-table pass
 */
export function resolvePartyAcrossPasses(p1, p3, resolveRow) {
  const a = p1 ? resolveRow(p1, { emptyMeansZero: false }) : null;
  const b = p3 ? resolveRow(p3, { emptyMeansZero: true }) : null;

  if (!b || b.confidence === 'none') {
    return a ? { ...a, source: 'p1' } : { party: p1?.party ?? null, value: null, confidence: 'none', source: 'none' };
  }
  if (!a || a.confidence === 'none') return { ...b, source: 'p3' };

  // ONE PASS CONTRADICTING ITSELF IS NOT A CLEAN VOTE FOR THE OTHER.
  //
  // Where pass 3 reads figures 151 against words "ONE HUNDRED AND FIFTY" while
  // pass 1 reads 150 in both cells, three of the four cell readings say 150 and
  // the lone dissenter is internally contradicted. Pass 1's value is the right
  // one to carry forward — but calling the row `both`, as though everything
  // agreed, would be false, and `both` is exactly what lets a sheet reach
  // `publishable`. A published figure is supposed to mean every cell was read
  // twice and the readings matched; here one did not. `contested` keeps the
  // value and withholds the claim, counting as single-sourced downstream.
  if (a.confidence === 'conflict' && b.confidence !== 'conflict') return { ...b, confidence: 'contested', source: 'p3-over-p1conflict' };
  if (b.confidence === 'conflict' && a.confidence !== 'conflict') return { ...a, confidence: 'contested', source: 'p1-over-p3conflict' };
  if (a.value === null || b.value === null) {
    return { party: a.party ?? b.party, value: null, confidence: 'conflict', source: 'both-conflict' };
  }
  if (a.value === b.value) {
    // Two independent passes agreeing is the strongest state available, even
    // when one of them only agreed that the cell was blank.
    return { ...b, confidence: a.confidence === 'both' || b.confidence === 'both' ? 'both' : b.confidence, source: 'agree' };
  }
  // Both passes internally consistent and they disagree on the number. There is
  // no tie-breaker here that is not a coin flip, and inventing one would answer
  // the very question the second pass was run to ask.
  return { party: a.party, value: null, confidence: 'conflict', source: 'disagree', p1: a.value, p3: b.value };
}

/**
 * Party rows: are the 15 rows actually the 15 PARTIES?
 *
 * Pinning the table to 15 rows in the schema stopped the model dropping a
 * party. It does not stop it returning the same party TWICE — fifteen rows
 * holding APC twice and no A satisfies every constraint in the schema, passes
 * the "nothing is missing" test in verifySheet() (which compares a count
 * against a count), then double-counts one party and drops another. The sum
 * comes out wrong, the sheet gets flagged, and the finding is entirely ours.
 *
 * Observed on 18 archive sheets, all of them dropping party A — the first row —
 * and 16 of them repeating APC with the value 308, which is the number printed
 * in the prompt's own worked example. A model that loses its place at the top
 * of the table falls back on the sample it was shown.
 *
 * @returns {{ok, duplicates, missing, stray}}
 */
export function checkRowIntegrity(parties, ballot) {
  const names = (parties || []).map((p) => (p?.party == null ? null : String(p.party).toUpperCase()));
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([n, c]) => n !== null && c > 1).map(([n, c]) => ({ party: n, times: c }));
  const missing = ballot.filter((p) => !counts.has(p));
  const stray = [...counts.keys()].filter((p) => p !== null && !ballot.includes(p));
  return { ok: !duplicates.length && !missing.length && !stray.length, duplicates, missing, stray };
}

/**
 * Values the model may have copied out of its own prompt rather than the sheet.
 *
 * The full-sheet prompt demonstrates the output shape with a real-looking row,
 * `{ party: 'APC', figures: '308', words: 'THREE HUNDRED AND EIGHT' }`. Across
 * the archive APC reads 308 thirty-eight times against a base rate of about one
 * for every neighbouring value — and all thirty-eight arrived with BOTH cells
 * populated and agreeing, so the figures-vs-words cross-check, the one
 * mechanism built to catch invention, endorsed every one of them.
 *
 * That is the worst failure mode available here: a confident, well-formed,
 * internally consistent lie. The prompt has since been changed so there is no
 * numeric example left to copy; this flags readings taken before that.
 */
export const PROMPT_LEAK_VALUES = [{ party: 'APC', value: 308 }];

export function checkPromptLeak(rows) {
  return (rows || []).filter((r) => PROMPT_LEAK_VALUES
    .some((L) => r.party === L.party && r.value === L.value))
    .map((r) => ({ party: r.party, value: r.value, confidence: r.confidence }));
}
