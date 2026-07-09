# Hawkeye — System Manual

*Independent Election Results Monitor · hawkeye.com.ng · v1, July 2026*

---

## 1. Why Hawkeye exists

Nigerian election results are most vulnerable in the gap between the polling
unit and the collation centre. Votes are counted publicly, in front of
ordinary citizens, at 176,846 polling units — and the count announced there,
recorded on the EC8A result sheet, is witnessed by everyone present. What
happens to that number afterwards is not: results transit through ward, LGA,
state, and national collation, where sheets have historically been altered,
swapped, "lost", or overridden — and the public has no independent record to
compare against.

Hawkeye closes that gap. It turns every phone at a polling unit into an
independent witness, and every witnessed count into a permanent, public,
tamper-evident record — captured *before* the results enter the collation
pipeline. If a number changes between the polling unit and the declaration,
Hawkeye's record makes the change visible.

**Hawkeye does not declare results.** Official results are INEC's alone.
Hawkeye produces evidence.

## 2. What makes it rig-evident

Rigging thrives on three conditions: records that can be quietly edited,
witnesses that can be isolated, and evidence that can't be checked. Hawkeye
removes all three.

### 2.1 A hash-chain ledger nobody can edit — including us
Every accepted report is appended to a public ledger where each entry
cryptographically commits to every entry before it. Change or delete any past
report and every later hash breaks, visibly, for anyone who checks. The
"Verify the Ledger" page recomputes the entire chain **in the visitor's own
browser** — trust requires no permission from us, and periodic head-anchors
are published externally so even a full database rollback would be detectable.

### 2.2 Reports signed on the observer's own device
Each observer's phone generates a cryptographic keypair that never leaves the
device. Every report is signed locally, stamped with GPS and time. Nobody —
not Hawkeye, not an attacker with our server — can forge a report from an
observer, because nobody else has the key.

### 2.3 Independent corroboration before trust
A single report proves little; one person can lie. A count is only marked
trusted when multiple **independent** observers at the same unit submit
matching numbers. One phone number = one observer identity (phone numbers are
stored only as one-way hashes), one report per unit per race, and device
fingerprinting resists multi-account abuse. Rigging a Hawkeye count means
recruiting several strangers at the same polling unit to upload the same
false photo evidence — under the eyes of everyone else present.

### 2.4 Photographic, geolocated evidence — public by default
Reports carry two live photos (the EC8A sheet and the venue), captured
in-app — not uploaded from the gallery — with GPS and timestamps. Evidence is
content-addressed (its hash is in the ledger), so a swapped image is as
detectable as an edited number. Everything is public: counts, photos,
locations, hashes.

### 2.5 Automated integrity screening
Every report also passes through statistical tripwires, logged in the open on
the Election Integrity page: over-voting against registered voters,
impossible turnout, conflicting counts between observers, collation-vs-unit
discrepancies, form-serial anomalies, and Benford-style outlier scans. Flags
are for scrutiny, not verdicts — but they are public within minutes, not
buried in a tribunal exhibit months later.

## 3. Use-cases

| Who | What Hawkeye gives them |
|---|---|
| **Citizen at their unit** | Two minutes with a phone to make the count they witnessed permanent. |
| **Party agents** | An evidence trail their candidate can take to a tribunal — timestamped, geolocated, hash-chained. |
| **Journalists** | A live, unit-level, independently verifiable feed on election night (leaderboard, maps, charts). |
| **Observer missions (domestic & international)** | Corroborated coverage at a scale no deployed mission can match, plus raw data access. |
| **INEC itself** | An independent mirror that *confirms* clean results — credibility, not opposition. |
| **Researchers** | A permanent public dataset of unit-level results with evidence attached. |
| **Voters before election day** | Candidate tracker, seat-composition data, polling-unit locator (128,000+ units with verified GPS), and Telegram alerts for the races they care about. |

## 4. Feature tour

- **Report a Result** — guided capture: verify phone (SMS OTP, or one-tap
  inside Telegram), geofence to your unit, photograph the EC8A, enter counts
  (OCR cross-checks the photo), sign and submit.
- **National Leaderboard** — live tallies with leading-party maps at state,
  senatorial-district (109), and federal-constituency (358, ward-resolution)
  levels; vote-share and coverage charts.
- **Unit Reports Log** — every report, with confidence from corroboration.
- **Verify the Ledger** — one click re-verifies the full hash chain client-side; a
  "Verify a Single Race" panel folds one contest's Merkle proof to the anchored root.
- **Election Integrity** — the public anomaly log.
- **Report an Incident** — violence, vote-buying, BVAS failure; human-reviewed
  before publication.
- **Map a Polling Unit** — crowd-verify unit GPS before election day.
- **2027 Candidates & Political Data** — declared candidates, incumbents,
  Senate/House/governorship composition.
- **Telegram** — the whole app runs as a Telegram Mini App + hybrid command bot
  (@HawkeyeNGBot): OTP-free sign-in via Telegram-verified phone, alert
  subscriptions, and a chat-native `/report` that collects the polling unit and
  vote figures in chat, then hands off to the Mini App for the live photo +
  on-device signature (gallery uploads stay impossible).
- **Races are labelled by cycle** ("2027 General Elections", with INEC dates —
  Presidential/National Assembly 16 Jan 2027, Governorship/State Assembly 6 Feb
  2027); a finished cycle archives to a per-race folder tree on the backend.
- **Built for election-day reality** — offline-capable, **one-tap installable**
  PWA (installs to phone home screen / desktop taskbar; native iOS/Android apps
  are on the roadmap), self-hosted assets, CGNAT-aware rate limits, works on
  low-end Android.

## 5. Why this points at true democracy — and a future national voting system

Democracy's core transaction is trust: citizens accept outcomes because they
believe the count. Every rigged or merely *disputed* election taxes that
belief. Hawkeye's answer is structural, not rhetorical — **replace "trust the
referee" with "anyone can check"**:

- **Radical verifiability.** No privileged observers. The ledger, evidence,
  and anomaly flags are equally inspectable by a voter, a party, or INEC.
- **Distributed witness.** Power to attest is spread across millions of
  phones instead of concentrated in collation officers.
- **Permanence.** Evidence cannot be quietly withdrawn after the news cycle.

The same primitives — device-held keys, signed submissions, independent
corroboration, a public append-only ledger, client-side verification — are
exactly the building blocks of end-to-end verifiable (E2E-V) elections. A
future national system could let each voter verify their own ballot was
**cast as intended, recorded as cast, and counted as recorded**, without
revealing their vote, while the whole tally stays publicly recomputable.
Hawkeye is deliberately the conservative first step on that road: it doesn't
replace the paper process, it *shadows* it — proving at national scale that
Nigerians will participate, that the cryptography holds on ordinary phones,
and that transparency changes behaviour at the point where rigging happens.

A ballot everyone can verify is the difference between being asked to trust
democracy and being able to see it. That is what Hawkeye is for.

## 6. Privacy & safety

Phone numbers exist only as salted one-way hashes; reports are tied to
anonymous observer IDs, never names. No ads, no trackers, no cookies. Codes
expire in minutes. Observers are told: never put yourself at risk for
evidence. Ledger permanence applies to evidence, not identity.

## 7. Governance & limits

Hawkeye is an independent, non-partisan transparency initiative. Its numbers
are always partial (coverage grows with participation) and always labelled
unofficial. It cannot detect what no observer witnesses; it makes what *was*
witnessed impossible to quietly erase. Code: github.com/HawkeyeNG/hawkeye
(MIT). Contact: info@hawkeye.com.ng · @HawkEyeNGBot.
