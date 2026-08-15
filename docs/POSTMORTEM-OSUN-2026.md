# Post-mortem — Osun governorship, 15 August 2026

**Outcome: Hawkeye received zero result reports.** INEC counted more than half
the votes; the ledger holds nothing.

**Cause: nobody reported.** Not a failure of the software — a failure to have
observers standing at polling units willing and ready to file. Confirmed by the
operator: the 7 incidents and 12 practice runs in the admin console were his own
testing, not public activity.

This document records the evidence that rules out a technical cause, states the
size of the actual gap, and separates the work that matters (getting observers)
from the instrumentation that would have answered this question in seconds
instead of an evening.

---

## 1. The gap, in one line

**12 organic observers. 3,763 polling units in Osun.**

19 accounts exist; 7 of them are the team. Even with flawless software and a
100% reporting rate, 12 people is **0.3%** coverage. The run could not have
produced a meaningful result set under any circumstances. This is an
order-of-magnitude recruitment problem, not a conversion problem, and no amount
of engineering compensates for it.

| | |
|---|---|
| observers registered | 19 — **7 are the team, so 12 organic** |
| result submissions | **0** |
| collation reports | 0 |
| incidents filed | 7 — *operator's own tests* |
| practice runs | 12 — *operator's own tests* |
| saved a unit | 4 |
| units crowd-mapped | 0 |
| first signup | 2026-07-15, i.e. a month of recruitment |

Read carefully, every "activity" number in the console is the team. Nothing in
it is evidence of public use — which is worth stating plainly, because a
dashboard that counts your own testing alongside real usage will flatter you at
exactly the moment you need the truth.

Both numbers have to move, and the second matters more: 12 people signed up over
a month and **zero** reported. That is about who they are and whether they were
ever going to be standing at a polling unit with a reason to file.

---

## 2. The software was verified healthy — so nobody re-litigates it

Checked live on the night, 21:30–22:00:

| Check | Result |
|---|---|
| `POST /api/submissions` | Up — correct `missing_token` / `invalid_token` rejection |
| Contest `GOV` | `open: true` since 08:30 +01:00 |
| Sign-up page | Renders; Telegram / WhatsApp / SMS all offered |
| OTP + accounts | Working — 19 accounts exist, 2 created in the last 24h |
| Anchoring | Alive — 462 anchors, latest 21:27, anchoring an empty ledger |
| Ledger / integrity / incidents | 0 / 0 / 0 |
| The day's two `app.js` deploys | Ruled out — no submit-path line changed |

Sign-up, auth, OTP delivery, incident filing and practice all demonstrably work.
The result path was never exercised by a member of the public.

**Two theories investigated and dropped**, recorded so they are not re-tried:

- *OTP delivery failed, so nobody could sign up* — refuted by 19 accounts, 2 of
  them in the last 24 hours.
- *The 200 m geofence rejected reports from block-shifted coordinates* — the
  register does carry ~33% wrong geocodes in production, but all 1,826
  hard-fenced Osun units are `coords_source: inec_locator`; the corrupt geocodes
  sit in the `approx` tier, which never hard-rejects. Clean theory, wrong.

---

## 3. What actually needs to happen before 2027

Ordered by leverage. The first item is worth more than everything below it.

### A. Recruit observers to a coverage target, and count them weekly

Set the target as a number of **confirmed, contactable people per LGA**, not a
signup count. Osun's 30 LGAs at even 10 units each is 300 observers; the
presidential run is 176k units nationwide, so the model has to be partnership,
not individual signup:

- Civil-society organisations that already field election observers.
- Party agents — they are at every unit by law and already hold the sheet.
  They have the strongest reason to want an independent copy of their own
  result, which is the pitch.
- Student and youth networks in university towns.
- Existing observer bodies (YIAGA, TMG and similar) as institutional channels.

Track weekly against target from ~90 days out. A number that is not moving is a
plan that is not working, and it is visible months ahead rather than on the day.

### B. Convert a signup into a committed observer

12 organic signups over a month produced 0 reports; that ratio is the thing to
attack, and at this N every single person is worth contacting individually:

- Ask, at signup, which unit they will be at. 4 of 19 saved a unit.
- Confirm attendance 48 hours before, by Telegram, and get a yes.
- Require one practice run as part of onboarding — the flow exists and 12 runs
  prove it works.
- Send a reminder at poll-close, when the sheet is actually posted. That is the
  single moment the whole product depends on, and nobody was told.

### C. Make the day-of ask unmissable

An observer who has the app and is standing at a unit still needs to know that
*now* is the moment. Push and Telegram are already wired and free at any volume:
6 Telegram-linked, 7 push-enabled out of 19 is itself too low to rely on.

---

## 4. Instrumentation worth building anyway

None of this would have produced a single report. It would have answered "is it
broken or is nobody using it?" in seconds rather than an evening of probing —
and that question will recur.

### Zero-reports alarm

From poll-open + 2 hours, if `unitsReporting == 0`, notify by Telegram hourly.
One query against the number the leaderboard already renders. Nothing alerted
anyone that the count was zero all day; silence read exactly like no news.

### 4xx counts on `/api/submissions`, by error code

Tonight there was no way to distinguish "attempted and rejected" from "never
attempted" — the two branches with completely different responses. It took the
operator's own knowledge to settle it, which does not scale to a national run.

### Ingest canary that writes nothing

The route validates in a fixed order, so a request valid in every respect
**except carrying no photos** walks auth, contest window, device, duplicate,
rate limit, unit lookup, GPS, accuracy, photo-fix coherence and the geofence —
then stops at `photo_required`:

```
expect: 400 {"error":"photo_required"}     → everything upstream is healthy
otherwise the error names the broken stage:
  invalid_token       canary credential expired
  reporting_not_open  contest window wrong
  unknown_polling_unit register drift
  outside_geofence    unit or canary coordinates moved
  5xx / timeout       backend down
```

Rejection happens before any insert, so it cannot reach the ledger. That
property is non-negotiable here: fabricating a result is the exact harm this
project exists to prevent, so a canary that writes a fake result — even a
flagged one — is not acceptable. It is also idempotent by construction, since
the duplicate-device check keys on completed reports and this never completes
one. Run it every 15 minutes, always, so it is known-green before polls open.

### Pre-election rehearsal on a real device

Install the published APK, sign up on each channel, set a password, sign out and
back in, select a unit by search and by near-me, capture both photos, submit,
confirm it appears in the public log, delete it before polls open. 7 days out and
again at 24 hours, as a stop condition. Practice mode does **not** substitute: it
needs no sign-in and never touches `/api/submissions`.

---

## 5. Fair accounting

What the run did produce, none of which is invalidated by zero reports:

- A verified ingest path, auth, anchoring and public ledger, live under real
  conditions.
- SMS OTP live and confirmed delivering on device.
- Constituency and senatorial map partitions rebuilt at full precision
  (364 + 109) from one offline dissolve implementation.
- A candidate-list parser for 2027, validated against INEC's 2022 publication:
  18 presidential, 1,119 senate, 3,097 reps.
- The register audited as a side effect — ~40 junk constituency values and a
  cross-state ward anomaly found.

The product works. It has not yet been put in front of enough of the right
people, and that is the whole of the 2027 problem.
