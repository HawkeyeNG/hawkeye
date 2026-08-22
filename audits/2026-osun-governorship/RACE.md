# 2026 Osun State Governorship Election — EC8A audit

> **STATUS: INTERNAL EVIDENCE BASE. NOT FOR PUBLICATION.**
> Reviewed in-house, not through the Public Docket. Nothing here has been
> written for an outside reader, and several things below would be actively
> misleading if released as they stand — see *Before any of this could be
> published*.

An independent check of INEC against the polling-unit result sheets INEC itself
published. It needs no observers and no crowd reports, which is why it could be
run months after the election.

| | |
|---|---|
| Election day | 15 August 2026 |
| Polling units in the register | 3,763 |
| EC8A sheets INEC published | 3,742 |
| **Units with no sheet published** | **21** |
| Source | INEC IReV, downloaded 2026-08-18 to 2026-08-20 |
| Ballot | 15 parties (see `OSUN_2026_BALLOT`) |
| Model | Qwen2.5-VL-7B-Instruct, self-hosted on a rented RTX 3090 |
| Total GPU spend | ~$2 across all passes |

## What was run

Four passes, each measured against the 20 hand-labelled sheets before being
allowed near the archive.

**Pass 1 — whole sheet** (`vlm_full.jsonl`, 2026-08-21). One request per sheet
for everything: 15 party rows, both cells each, and the eight summary boxes.
Read 95% of party cells but only 57% of boxes — asked for everything at once,
the model spends its attention on the big table.

**Pass 2 — cropped summary boxes** (`boxes_full.jsonl`, 2026-08-21). The
top-right block only, magnified, one narrow question. Boxes went **55% → 92.4%**
at 1.41 s/sheet.

**Stage 0 — arithmetic, no GPU** (`vlm_stage0.jsonl`, 2026-08-22). Spend the
constraints already on the paper before paying for more inference. Where the two
passes disagreed on exactly one box, the sheet's own equations often single out
the right reading; the constraint that decides is *spent* and reported as
`assumed`, never `pass`. Also: impossible values (≥10,000) treated as unread,
and sheets whose 15 rows are not the 15 parties no longer get a manufactured
`party_sum` finding.

**Pass 3 — cropped party table** (`party_full.jsonl`, 2026-08-22). The same crop
technique aimed at what actually blocked the audit after pass 2. Two things it
buys beyond magnification: it cuts off the polling-agent signature column, whose
handwriting runs into the words cells with no ruled line between them; and it
takes in the **TOTAL VALID VOTES row**, a fourth independent statement of #7 in
the officer's own hand that no earlier pass had ever read.

Its schema also separates **empty** from **illegible** — `""` where the officer
wrote nothing, `null` where there are marks we cannot resolve. Pass 1 had no way
to express that difference, and the conflation accounted for 7,095 stuck rows.

## Defects found in our own readings

Every one of these produced *flags*, and every one would have been reported as a
finding about INEC if it had not been caught.

- **Prompt contamination.** The prompt's worked example was
  `APC / 308 / THREE HUNDRED AND EIGHT`. APC reads exactly 308 on **38 sheets**
  against a base rate of ~1, and all 38 arrived with both cells agreeing — the
  figures-vs-words cross-check endorsed every one.
- **Duplicate party rows.** 18 sheets returned APC twice and no A. Fifteen rows
  satisfies a count check while one party is double-counted and another dropped.
- **Impossible values used as data.** Boxes reading up to 597,961 were flowing
  into the equations and producing discrepancies in the hundreds of thousands at
  units with room for a thousand voters.
- **A rejected shortcut.** "Most rows are zero, so call the unread ones zero"
  would have collapsed the review pile. Measured against the hand labels, **2 of
  6 null rows carried real votes**. Dead unless someone re-measures it on sheets
  drawn from the blocked population.

## Calibration

Against the 20 hand-labelled sheets, after all passes: **97.7% of party cells
correct, zero silent errors** (no sheet reached `publishable` carrying a number
the human read differently), and **84/84 cells called empty were genuinely
zero**. The one remaining misread was caught by the arithmetic and held back.

The sample is the first 20 sheets by unit code — one LGA, one officer, one
camera. It bounds the damage; it does not prove accuracy on the sheets that
actually blocked.

## What the verdicts mean

- **publishable** — the transcription is internally consistent. NOT "result
  verified". Anything public must say so in plain words or it reads as
  certification.
- **flagged** — a check failed. **NOT a finding.** On the 20 reviewed sheets, 7
  flagged → 1 real anomaly and 6 misreads of our own.
- **review** — something could not be established.
- **21 units with no sheet** — the cleanest claim in the audit, with zero
  transcription risk. INEC either published a sheet or it did not.

## Confirmed anomalies (human-checked)

- **29-01-02-004** St. Luke's Owode — 347 cast (339 valid + 8 rejected) against
  345 accredited. #2 re-read at 7x magnification: unambiguously 345.
- **29-01-03-003** St. Andrew Ise-Ijesa — **three different totals on one
  sheet**: party column 348, the officer's own TOTAL row 347, box #7 349.

## Triage (Stage 1)

2,349 sheets still carry a failing or unestablished check. At two minutes each
that is 78 hours, and file order would mean reading a thousand clerical wobbles
before reaching anything that matters. Stratified instead:

| tier | count | what it is | hours |
|---|---|---|---|
| **A** | 516 | exhaustive review — anything that could change a unit, plus all 21 unpublished units | ~17 |
| **B** | 300 | random draw across the whole archive, to state a rate with an interval | ~10 |
| **C** | 2,988 | the rest; opportunistic, never claimed as reviewed | — |

Tier A's test is deliberately narrow: **only the party column can change who won
a unit.** A first attempt compared the largest discrepancy of any failing check
against the margin and produced 657 sheets — but `ballot_stock` is about ballot
papers, and `registered_vs_issued` compares two header boxes. A unit can fail
both and still have an unambiguous winner. The real test is whether an unread
row, a disputed row, or votes missing from the column could span the
first-to-second gap.

Sample membership is tracked **separately from tier**, because 41 sampled sheets
are also Tier A. Folding them in dropped exactly the material sheets from the
sample and biased the estimate downward.

### What this audit cannot say

Our statewide totals cover the 3,289 units whose party column fully resolved;
453 units are absent from them entirely, holding roughly 117,000 unattributed
votes against a 53,751-vote lead. **This audit therefore cannot confirm or
overturn the statewide result, and must not be written as though it could.** It
is not a recount, it does not hold INEC's declared figures or the BVAS record.
What it can say is which published sheets fail to reconcile with themselves, and
which units INEC published nothing for.

## The review queue (Stage 2)

One queue, two exits: review and flagged sheets go to the same console, because
the first question for both is *is our reading right?* Approving a **review**
sheet fills the gap; approving a **flagged** one confirms the discrepancy is
real and it becomes a finding.

Three things the console could not do, now fixed in
`backend/src/routes/training.js`:

- **a label could not settle a sheet.** `truth.json` stores non-zero counts
  only, so a party absent from it might have polled nothing or might never have
  been looked at — the same blank-versus-unreadable conflation the audit exists
  to resolve. A label now carries a `complete` flag and the eight summary boxes,
  in a sidecar (`label_meta.json`) so the six existing consumers of `truth.json`
  keep working.
- **Deny was a loop.** It deleted the label and returned the sheet to the pool
  for the next person to fail on identically. `POST /training/illegible` is a
  third exit: the sheet itself cannot be read, which is a finding about the
  quality of the published record — a citizen cannot verify what a citizen
  cannot read.
- **training bias.** Every claim is now tagged `random` or `audit`. Only the
  random stream can support a rate. `GET /api/training/streams` reports the
  split and warns when it degrades — it already does: **549 of 549 approved
  labels predate tagging**, so no accuracy figure over the whole set is
  attributable.

## The findings register (Stage 3)

`findings.json` / `findings.csv`, built by `stage3_findings.mjs`. **A flag is
not a finding.** Three things get in: units with no published sheet (needs no
review — a document either exists or does not), sheets a human tried to read and
could not, and discrepancies on sheets whose transcription a human approved.

It currently holds **23 entries** — 21 unpublished units and the 2 hand-confirmed
anomalies — against 1,111 sheets carrying a failing check. That gap is the
point: the rest are work items and the register does not report them as anything
else.

Every entry is phrased *"this sheet does not reconcile"*, never as an
accusation. A presiding officer adding fifteen figures by hand at six in the
evening is a likelier explanation than anything else, and nothing here can tell
the two apart.

## Before any of this could be published

Decided 2026-08-22: **in-house review, internal evidence base for now.** Not the
Public Docket — crowd review of election anomalies carries obvious partisanship
risk, and a crowd verdict on "does this sheet reconcile" would be a verdict on a
contested election rather than on arithmetic.

Being internal is doing real work here. Four things are safe in an evidence base
and would mislead in public:

1. **1,111 sheets carry a failing check and 2 are findings.** Published as a
   count of "discrepancies", the first number reads as an accusation against
   INEC. It is mostly a measure of our own OCR — on the 20 reviewed sheets, 7
   flagged produced 1 real anomaly and 6 misreads of ours.
2. **The statewide totals in this folder are ours and are partial** (3,289 of
   3,742 units). Quoting them next to INEC's would invite a comparison neither
   number can support.
3. **`streams.json` is a map of where we think the problems are** before a human
   has confirmed one. Published, it is a list of units to go and dispute.
4. **549 of 549 approved labels predate stream tagging**, so any accuracy figure
   over that set is unattributable. A published accuracy claim needs a clean
   random stream measured after tagging.

Accordingly `illegible.json`, `label_meta.json` and `streams.json` are **blocked
from the public `/training` static mount** (server.js) and served only through
`GET /api/training/meta` behind the admin passphrase; `test_audit_privacy.sh`
proves it with a canary rather than trusting a 404. `truth.json`, `sets.json`,
`approved.json`, `dropped.json` and `boxes.json` remain public — they predate
this and both review pages fetch them uncredentialed. **That is a known gap, not
an endorsement**, and it should be closed before any public release.

The route to publication, in order: finish Tier A, get a clean random-stream
accuracy figure, publish the 21 unpublished units first (the claim with no
transcription risk at all), and only then anything resting on our reading.

## Reproducing

```bash
node scripts/stage0_resolve.mjs  <full> <boxes> <out>      # arithmetic, no GPU
bash scripts/run_party_pass.sh                             # calibrate, gate, run
bash scripts/stage0_finish.sh                              # merge, report, workbook
node scripts/stage1_triage.mjs   audits/2026-osun-governorship
node scripts/stage3_findings.mjs audits/2026-osun-governorship storage/training
```

Every merge step is file-to-file with no inference, so the resolution logic can
change and be replayed without paying for GPU again.
