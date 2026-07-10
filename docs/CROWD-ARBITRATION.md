# Crowd Arbitration — The Public Docket

*Design v1 · 2026-07-10 · status: **BUILT & LIVE** (same day) — docket.html /
case.html, routes/docket.js, services/docket.js, disputed axis in aggregate.js,
docket chain head in the Rekor anchor artifact*

## Premise

AI and statistics only **flag**; they never decide. The arbiter is not Hawkeye
staff either — it is **the crowd, on the public record**. Every flagged result
becomes a *case* that the entire world is invited to re-verify after the
election, with the same evidence a tribunal would see, and the crowd's
resolution is itself signed, counted, published, and anchored. Nobody — not an
admin, not the AI, not a party agent — can quietly bless or bury a result.

## Lifecycle

```
report accepted → (flags?) → result badged DISPUTED, trust capped
     election window closes → every open flag becomes a CASE on the docket
     review window (14 days) → verified identities cast structured verdicts
     quorum + supermajority → RESOLVED: upheld (excluded) / cleared (restored)
     no quorum/majority     → UNRESOLVED: stays disputed forever
     every step appended to the ledger; docket close anchored to Rekor
```

## 1. During the election — flag travels with the result

- Any high-severity discrepancy (vision `sheet_authenticity`, count mismatch,
  over-voting, serial reuse…) marks the result **DISPUTED** wherever it
  appears: results page, dashboard, maps, bot `/results`, API. Badge + reason +
  evidence link, inline.
- A disputed result's confidence is **capped** and it is **excluded from
  headline tallies** (shown separately as "in dispute") until resolved. Same
  design language as unverified-location capping: nothing deleted, trust
  paused.
- The flag event is **appended to the ledger** as its own entry (never mutating
  the original — the chain stays intact), so "flagged at 17:07" is as
  tamper-evident as the report itself.

## 2. After the election — the docket opens

- Every result still carrying an open flag becomes a **case** at
  `/docket.html`, one page per case (`/case.html?id=N`), announced site-wide
  and via the bots.
- **The case file** (everything a juror needs, nothing they don't):
  - the sheet photo and venue photo (the primary evidence)
  - unit metadata: registered voters, ward/LGA/state, geofence status
  - the observer-typed counts vs the AI-vision read-back vs OCR tokens
  - the specific flag(s), each with the AI/statistical reasoning shown in full
    (advisory framing, clearly labelled)
  - the submission's ledger entry + inclusion proof, verifiable in-browser
- Cases are open for a fixed, published **review window (14 days)**.

## 3. Who may judge, and how (anti-Sybil + anti-brigade)

- **Verdicts require a verified identity** — the existing observer identity
  (phone-verified, device-bound key, one per person). Browsing the docket is
  open to everyone; *voting* is one-verdict-per-identity-per-case, signed with
  the device key like any report.
- **Structured verdicts, not vibes.** A juror answers factual questions:
  1. Is this an official EC8A result sheet? (yes / no / can't tell)
  2. Do the sheet's figures match the reported counts? (yes / no / can't tell)
  3. Does the evidence support the flag? (yes / no / can't tell)
  A per-case verdict (legit / fraudulent / inconclusive) is **computed from the
  answers** by a published rule — jurors never tick a party-colored box.
- **Every verdict is public** (anonymous juror id, timestamp, answers), so the
  jury itself can be audited: brigade patterns (burst timing, identical answer
  sets, single-state clusters) are visible to anyone, and flagged by the same
  statistical layer — advisory, as always.

## 4. Resolution rule (published, mechanical)

- **Quorum:** ≥ 50 verdicts.
- **Supermajority:** ≥ ⅔ on the computed verdict.
- Outcomes:
  - **Upheld** (fraud confirmed): result permanently excluded from tallies,
    badge becomes `struck — crowd-upheld fraud`, case file stays public forever.
  - **Cleared:** badge lifts, result re-enters tallies, the false flag stays on
    record (the AI's error is public too — accountability cuts both ways).
  - **Unresolved** (no quorum / no supermajority): stays `disputed`, excluded,
    revisitable if new evidence arrives (one reopen, with a fresh window).
- Resolutions are appended to the ledger; at docket close the full verdict set
  and every resolution are Merkle-batched and **anchored to Rekor** — the
  arbitration is as rollback-proof as the results.

## 5. Why this holds up

- **No trusted arbiter anywhere**: AI flags, crowd decides, ledger remembers,
  Rekor prevents rewrites. Hawkeye operates the venue, not the verdict.
- **Bad actors face compounding cost**: faking a result needs colluding
  verified observers at a real location; surviving arbitration needs a
  supermajority of the *global* verified crowd on a public record they can be
  audited against.
- **Tribunal-ready**: a struck result carries its whole story — report, flag,
  evidence, every verdict, resolution, anchor — in one exportable case file.

## Build map (when green-lit)

| Piece | Where |
|---|---|
| `disputed` status + tally exclusion + badges | `services/aggregate.js`, results/dashboard UI, bot |
| flag events → ledger append | `services/integrity.js` → `services/ledger.js` |
| cases + verdicts tables, docket/case APIs | `db.js`, new `routes/docket.js` |
| docket + case pages (evidence, in-browser proof) | `app/docket.html`, `app/case.html` |
| signed verdict submission (device key reuse) | `app/case.html` + `routes/docket.js` |
| resolution job + docket-close Rekor anchor | `services/anchor.js` |
| whitepaper §3.6 + FAQ + manual updates | `docs/` |
