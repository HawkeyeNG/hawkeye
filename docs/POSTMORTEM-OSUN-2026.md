# Post-mortem — Osun governorship, 15 August 2026

**Outcome: Hawkeye received zero result reports.** INEC counted more than half
the votes; the ledger holds nothing.

This document separates what was measured from what is still unknown, and
defines the checks that would have caught it. It is deliberately blunt: the
software was healthy all day, which is the least comfortable version of this
result, because it means the failure was upstream of anything a test suite was
watching.

---

## 1. What was verified working (21:30–22:00, election night)

| Check | Result |
|---|---|
| `POST /api/submissions` reachable | Up — returns `missing_token` / `invalid_token` correctly |
| Contest `GOV` open | `open: true`, `opensAt` 2026-08-15T08:30+01:00 |
| Submissions in ledger | **0** — "Ledger intact — 0 entries" |
| `/api/integrity/summary` | `total: 0, reports: 0, unitsFlagged: 0` |
| Incidents | 0 |
| Anchoring job | Alive — 462 anchors, latest 21:27 and 19:43, anchoring an empty ledger |
| Sign-up page | Renders; all three OTP channels offered (Telegram / WhatsApp / SMS) |
| `smsOtp` flag | `true` in production health |

**Ruled out: the day's deploys.** `app.js` shipped twice on 15 Aug (v148, v149).
The diff since the previous build touches only the auth/OTP block, the near-me
copy, and `resetReportState` / `prepareReportUI` / `bindUnit`. No line in the
submit path changed and the `/api/submissions` call is intact.

**Conclusion:** the API was never reached by an authenticated client all day.
The break is upstream of the server.

---

## 2. What is still unknown

Two facts settle the root cause and both need the admin console:

1. **Were there any sign-ups today?**
   Registered-but-never-reported and never-registered are different failures
   with different fixes.
2. **Were OTPs delivered?** `/api/admin/otp-diag`.
   SMS went live only on 14 August. If delivery failed, nobody could create an
   account and everything downstream follows.

Until those are read, root cause is a ranked hypothesis, not a finding.

### Ranked candidates, each with the check that discriminates it

| # | Hypothesis | Discriminating check |
|---|---|---|
| 1 | Agents never completed sign-up (OTP not delivered, or the missing password step blocked them) | otp-diag + observer count for 15 Aug |
| 2 | Agents signed up but never reached the report screen | observer count > 0 with zero submissions |
| 3 | The APK never got into working hands in time | ask the agents directly; check download counts for `hawkeye-1.2-8.apk` |
| 4 | Reports were attempted and rejected | server logs for 4xx on `/api/submissions` — **currently unobservable, see §3.C** |

Note on #1: the sign-up flow on the native team APK was **never exercised
end to end before agents received it**. The password step was missing until
`f94e19a`, built at 15:46 — after any morning install. That is the only part of
the chain that reached real users untested.

---

## 3. The checks to build

### A. Pre-election device rehearsal — *the one that would have caught this*

A scripted run on a real phone, on the real production backend, no earlier than
7 days before polls and repeated 24 hours before. Practice mode does **not**
substitute: it requires no sign-in and does not touch `/api/submissions`, so it
exercises neither auth nor the ingest route.

Pass criteria, each recorded with a screenshot:

1. Install the published APK from `hawkeye.com.ng` (not a local build).
2. Sign up with a real number — **on each channel in turn**: Telegram, WhatsApp, SMS.
3. Set a password; sign out; sign back in with phone + password.
4. Reach the report screen and select a unit by **search** and by **near me**.
5. Capture both photos, enter votes, submit.
6. Confirm the report appears in the public log and in the ledger.
7. Delete the test report via admin before polls open.

If any step cannot be completed, the election-day plan is not ready — that is
the whole point of the check, and it is a stop condition, not a warning.

### B. Ingest canary — proves the pipeline without writing anything

The submission route validates in a fixed order. A request that is valid in
every respect **except that it carries no photos** walks the entire chain and
stops one step short of persistence:

```
auth → contest known → reporting open → device header → not duplicate
     → rate limit → unit known → contest applies → GPS present → accuracy
     → photo GPS present → photo/fix coherence → geofence   ✅ all pass
     → photos                                               ⛔ photo_required
```

**Expected response: `400 { error: "photo_required" }`.** Anything else is a
real failure, and the error names the broken stage:

| Response | Meaning |
|---|---|
| `photo_required` | healthy — everything upstream passed |
| `invalid_token` / `missing_token` | canary credential expired |
| `reporting_not_open` | contest window wrong (this would have been visible from 08:30) |
| `unknown_polling_unit` | register/unit drift |
| `outside_geofence` | canary coordinates or unit coordinates moved |
| 5xx / timeout | backend down |

Properties that make this safe to run continuously:

- **Nothing is ever written.** Rejection happens before any insert, so the
  ledger, tallies and public log cannot be polluted. This matters more here than
  in an ordinary system: fabricating a result is the exact harm Hawkeye exists to
  prevent, so a canary that writes a fake result — even a flagged one — is not
  acceptable.
- **Idempotent by construction.** The duplicate-device check keys on completed
  reports; the canary never completes one, so it can run forever without
  tripping `device_already_reported_race`.
- **Negligible load.** The rate limit is 500 per 10 minutes; a canary every 15
  minutes is noise.

Needs: one dedicated observer account, its token in the server environment, and
a designated canary polling unit with verified coordinates.

Run it every 15 minutes always — not only on election day. The value is that it
is already known-green before polls open.

### C. Zero-reports alarm — independent of the canary

The canary proves the pipeline is *able* to accept reports. It says nothing
about whether any arrived. **Nothing alerted anyone that the count was zero all
day**, and silence was indistinguishable from "no news". That is arguably the
single biggest finding here.

Alarm: from poll-open + 2 hours, if `unitsReporting == 0`, notify by Telegram
every hour. Escalate wording after 4 hours. It is one query against the same
number the leaderboard already renders.

Also add: 4xx counts on `/api/submissions` by error code, exposed on an admin
endpoint. Tonight I could not tell whether reports were attempted and rejected,
or never attempted — the two most important branches of the diagnosis, and both
invisible.

### D. Distribution deadlines

The tool worked and did not reach working hands in time. Treat that as a
schedule requirement, not a comms afterthought:

- Published APK frozen and downloadable **7 days** before polls.
- Every agent confirms install **and one practice run** 48 hours before.
- A named list of agents with confirmed sign-ups, checked 24 hours before —
  a count, not an assumption.

---

## 4. Fair accounting of what this run produced

Not everything here is a loss, and the post-mortem is more useful if it says so:

- A verified ingest path, auth, anchoring and public ledger, all live.
- SMS OTP live and confirmed delivering on device.
- Constituency and senatorial map partitions rebuilt at full precision
  (364 + 109), off the network, from one dissolve implementation.
- A candidate-list parser for the 2027 general, validated against INEC's 2022
  publication: 18 presidential, 1,119 senate, 3,097 reps.
- The register audited as a side effect — ~40 junk constituency values and a
  cross-state ward anomaly identified.

The gap was never the software. It was that nobody exercised the whole chain as
a user, on a real device, before it mattered — and nothing was watching to say
so.
