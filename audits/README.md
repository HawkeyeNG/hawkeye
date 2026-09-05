# Election audits

One folder per race. An audit here is an independent check of INEC against the
EC8A sheets INEC itself published — it needs no observers and no crowd reports,
which is why it can be run on any past race.

```
audits/
  <year>-<state>-<race>/
    sheets/            EC8A images as downloaded, one per polling unit
    hand_labels.json   human-verified transcriptions — the calibration set
    vlm_full.jsonl     pass 1: whole-sheet read
    boxes_full.jsonl   pass 2: cropped summary-box read
    party_full.jsonl   pass 3: cropped party-table read
    vlm_stage0b.jsonl  all passes reconciled — THIS is what gets published
    *.xlsx             the deliverable workbook
```

**RACE.md lives outside this tree**, at
`docs/private/audits/<year>-<state>-<race>/RACE.md`. It records what was run, on
what, what it cost — and the caveats, including which published figures are not
yet what they look like. Its own header says it is an internal evidence base and
that several things in it would mislead an outside reader as written, and this
repository is public, so it is kept in the gitignored `docs/private/` rather than
here. Note that moving it does not unpublish the versions already pushed; it
stops adding to them.

## Crop, then ask one question

The single most effective technique here, and it has now paid twice. Pass 1
reads the whole sheet and spends its attention on whatever dominates the image:
summary-box coverage came back at 57% while party cells were at 95%. Cropping
the box block and asking only about it took the boxes to 92%. Cropping the party
table did the same for the column, and bought two things magnification alone
does not:

- **it removes the polling-agent signature column.** On 29-01-01-001 the words
  cell reads `ONE HUNDRED AND TEN` and an agent's signature begins immediately
  after it, same hand, same size, no ruled line between them in the photograph.
  No prompt reliably separates those; a crop does.
- **it takes in the TOTAL VALID VOTES row**, which no pass had ever read — a
  fourth independent statement of #7 in the officer's own handwriting.

Crops are measured off real sheets and then loosened hard, because the errors
are not symmetric: too much costs a few tokens, too little clips a row silently
and the result is indistinguishable from an unreadable cell. Verify by eye with
`preview_party_crop.mjs` before running, never after — an early bound cut the
TOTAL row's figures while leaving its printed label in frame, so the crop looked
complete and was not.

## Blank is not unreadable

Most rows on a Nigerian ballot poll nothing, and most officers record that as a
drawn dash rather than a `0`. Pass 1's schema offered only a value or `null`, so
those cells came back `null` — identical to a genuinely illegible one. That one
conflation accounted for 7,095 stuck rows.

The party-table prompt asks for three answers, not two: the text, `""` for a
cell that is empty, or `null` for marks that cannot be resolved. The obvious
shortcut — "most rows are zero, so call the nulls zero" — was measured against
the hand labels and **rejected**: 2 of 6 null rows carried real votes. Do not
revive it without measuring on sheets drawn from the blocked population.

The rule is opt-in (`emptyMeansZero`) because the archive already contains 252
empty cells written under the old prompt, where `""` meant nothing in
particular. Reinterpreting those after the fact would invent zeroes.

## The rule that makes an audit defensible

Every published figure must rest on the sheet's own internal consistency, never
on confidence in a model. Each party score is written twice on an EC8A — in
figures and in words — and the summary boxes constrain each other four ways:

    party column        = #7 total valid votes
    officer's TOTAL row = #7                   ← his own hand, read separately
    #5 + #6 + #7        = #8 used ballots
    #3 − #4             = #8 used ballots
    #7 + #6 (cast)      ≤ #2 accredited        ← over-voting, Electoral Act 2022 s.51
    #1                  = #3 ballot papers issued

A check that could not run is `unknown`, and `unknown` is **never** folded into
`pass`. A sheet where the total was unreadable is not a sheet that balanced.

## Arithmetic before GPU

Before paying for another pass, spend the constraints already on the sheet.
Where two passes disagree on ONE box and the rest are known, the sheet's own
equations often single out the right reading — 29-01-01-005's `#3` was recovered
that way as 415, the same value a human had confirmed by hand.

Two rules keep that from becoming circular:

- **two independent constraints must agree**, and neither may support the other
  candidate. Validated by corrupting a box on 522 fully-corroborated sheets and
  asking the adjudicator to recover it: 6,706 trials, 2,904 recoveries, **zero**
  wrong choices.
- **the constraint that decides is spent.** It is reported as `assumed`, never
  `pass`, because a constraint used to CHOOSE a value cannot also testify that
  the value is right. Requiring two supporters guarantees at least one survives
  as a genuine check.

## An impossible reading is not a reading

A polling unit holds at most about a thousand registered voters. A box reading
597,961 is a fact about our OCR, not the election — and feeding it into the
equations manufactured enormous, confident-looking discrepancies ("225,000 more
votes than accredited voters" at a unit with room for a thousand) that sat in
the flagged pile looking exactly like real findings. Values at or above 10,000
are treated as unread: the sheet goes to `review`, which is the honest claim.
That is not a smaller finding, it is no finding.

## Fifteen rows are not fifteen parties

Pinning the row count in the schema stopped the model dropping a party. It does
not stop it returning one twice: fifteen rows holding APC twice and no A passes
every count-based check while double-counting one party and dropping another.
Eighteen sheets did exactly this, all dropping the first row, and all were
flagged for a discrepancy we manufactured. Check the row SET, not its length.

Related: the prompt's own worked example used `APC / 308 / THREE HUNDRED AND
EIGHT`, and APC came back as exactly 308 on 38 sheets against a base rate of
about one — **every one of them with both cells agreeing**, so the
figures-vs-words cross-check endorsed all 38. Never put a real-looking number in
a prompt example.

## A `fail` is not a finding

It is a sheet whose own numbers disagree, and a misread is far more common than
a bad sheet. On the Osun sample, of the flagged sheets checked by hand only a
minority were real. Nothing leaves this folder as a finding until a human has
looked at the image.

## A detected crop was measured and rejected

The obvious next move after crop-then-ask-one-question is to stop using fixed
fractions: detect the ruled lines, deskew, and cut a tight crop per sheet. It
promises a large token saving that could be respent on running the party pass at
100% coverage instead of 38.5%.

Measured before building, and it does not survive the measurement.

| claim | measured |
|---|---|
| frees ~40% of pass-3 tokens | the current crop is already **87.7% ink-covered** vertically across 40 sheets, so **12.3%** is the ceiling — before any safety margin |
| the detector is reliable | fires on ~14% of sheets |
| deskew improves reading | **AUC 0.505** for predicting an unread cell, i.e. none |

12.3% of a 14% subset is roughly a **1.7%** saving, bought with a line detector, a
deskew stage, a fallback path and a new failure mode — and that failure mode is
the one this file already names as the worst available: a mis-firing detector
clips a row while the crop still looks complete.

Skew is real (about half the sheets sit more than a degree off) and it predicts
nothing about whether a cell can be read. Keep deskew as plumbing if a detector
is ever built; do not book accuracy against it.

**The cheaper way to buy the same thing:** pinning the crop's OUTPUT width made
the party pass resolution-independent, so running it on every sheet rather than
the 38.5% it was targeted at costs no more per sheet than it did before. That is
the coverage the tighter crop was going to fund, without the detector.

Re-open this only with a measurement showing the crop carries materially more
blank margin than 12.3% on a corpus that is not Osun.

## Building the workbook

```
python3 backend/scripts/build_audit_workbook.py \
  --state 29 --race "2026 Osun State Governorship Election" \
  --run audits/2026-osun-governorship/vlm_merged.jsonl \
  --out audits/2026-osun-governorship/osun-2026-governorship-audit.xlsx
```

It builds from the **register**, not from the sheets: one row per polling unit
that exists, with the transcription joined onto it. Built the other way round,
a unit INEC published no sheet for would silently vanish — and that absence is
a finding, not a gap.
