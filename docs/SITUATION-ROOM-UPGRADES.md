# Situation Room upgrades — scope

**Written 2026-09-19.** Target: make the room something a party needs on
election day, including a party that is winning. Presidential election is
**16 Jan 2027**.

## The premise

A room framed as *catching rigging* has one customer: whoever expects to lose.
A room framed as **command and control** has every customer, because every
party — incumbent or not — has the same blind spot on the day: **they do not
know what their own agents are doing.** 176,846 units, an agent nominally at
each, and headquarters learns what happened hours later down a phone tree.

So the sale is the operations tool. The integrity machinery — the ledger, the
hash chain, crowd arbitration — stops being the pitch and becomes the
credibility layer underneath it. The public record is the by-product. Same
inversion that made the receipt card work: the observer gets their copy, the
public record happens anyway.

Today the room's headline is *"0 of 176,846 units reported · 0% coverage"*.
That is an **observer-coverage** metric on a national denominator, and to a
party with 3,100 agents in one state it reads as noise. Every item below
re-points the same machinery at a denominator the customer owns.

---

## What already exists

Worth stating plainly, because it changes the effort estimates a lot.

| Table | Carries | Matters because |
|---|---|---|
| `group_members` | `group_id, observer_id, assigned_pu, assign_state, assigned_by, assigned_at, joined_at` | **Assignment is already modelled.** Attendance is one column away. |
| `campaign_groups` | `id, name, kind, contest, scope, created_by` | Rooms are already typed (campaign / CSO) and scoped to a contest. |
| `group_managers` | `observer_id, role, scope_kind, scope_value` | Role ladder + geographic scoping exists. |
| `submissions` | `pu_code, observer_id, contest, votes_json, location_verified, entry_hash, created_at` | Every report already knows who filed it, where, and whether the location held up. |
| `results` | `pu_code, contest, votes_json, status, matching_reports, confidence` | Per-unit aggregation with an arbitration status already runs. |
| `result_pairs` | `pu_code, contest, ours_json, theirs_json, doc_url, presence, state` | **Ours-vs-IReV comparison already exists**, with `pair_panels` for review. |
| `polling_units` | coords, `ward, lga, state, senatorial, federal_constituency, registered_voters` | Rollups and maps need no new geography. |
| `discrepancies` | `type, severity, pu_code, contest, state, detail, status` | An alerting spine already exists. |

Nothing below needs a new subsystem. Three of the four are a column, a query
and a tab.

---

## 1. Agent attendance, live — *build first*

**The pitch.** Not results. *Presence.* A state chairman opens one screen at
08:00 and sees 2,400 of 3,100 agents confirmed at their unit, and which 700
wards are dark — while there is still time to send somebody.

**Why first.** Smallest change, and it is the only one that delivers value
**before polls close**, which is what turns the room from a results viewer into
something open all day. It also produces the roster view that items 2–4 read
from.

### Data

```sql
ALTER TABLE group_members ADD COLUMN checked_in_at   INTEGER;
ALTER TABLE group_members ADD COLUMN check_in_pu     TEXT;    -- where they actually are
ALTER TABLE group_members ADD COLUMN check_in_lat    REAL;
ALTER TABLE group_members ADD COLUMN check_in_lng    REAL;
ALTER TABLE group_members ADD COLUMN check_in_status TEXT;    -- verified | plausible | unverified
```

`check_in_pu` is deliberately separate from `assigned_pu`: **an agent standing
somewhere other than their assignment is the single most useful thing this
screen can tell a manager**, and collapsing the two columns hides it.

### Endpoint

`POST /groups/:id/check-in` — `{ pu_code, lat, lng, accuracy }`.
Reuse the **submission geofence** (`services/scope.js`, the same distance test
that sets `location_verified`) so `check_in_status` means exactly what it means
on a report. A check-in from a bedroom is not a check-in, and inventing a
second, looser standard for it would make the number a lie the day it matters.

Idempotent per member per contest-day. Never overwrite an earlier verified
check-in with a later unverified one.

### UI

The room's **Team** tab becomes a live roster: `assigned / checked in / at the
wrong unit / dark`, filterable to the manager's own `scope_value`. Header
counters flip from national coverage to **the room's own denominator**.

### Risk

Attendance data is a management tool and therefore a pressure tool. State the
retention rule in the room's own copy before shipping, and keep check-in
coordinates out of any export a room can download — the roster is enough.

**Effort:** 1 migration, 1 endpoint, 1 tab rewrite, ~2 days with tests.

---

## 2. Deployment map — *build second*

**The pitch.** Where the party has agents and where it does not, weeks before
the day, over its own vote history. Useful during the period when budgets are
actually spent — which is what makes the room a habit rather than a one-day
gadget.

Mostly **UI over data that already exists**: `group_members.assigned_pu` joined
to `polling_units` coords, drawn on the ward maps already shipped
([[hawkeye-ward-maps-live]]). Add `registered_voters` as the weight so "800
units unassigned" becomes "**410,000 registered voters unassigned**", which is
the number that moves a budget.

**Effort:** ~2 days, no schema change.

---

## 3. Discrepancy alerts, pointed at their own defence — *build third*

**The pitch.** *"Your agent at 37-06-02-141 recorded APC 118; the IReV upload
says 81."* The difference between finding out in court in six weeks and
catching it at the LGA collation centre that night.

**This is the item an incumbent buys.** Errors and theft run in every
direction, and a party that is winning has more results to protect than one
that is losing.

`result_pairs` already holds `ours_json` vs `theirs_json` per unit. What is
missing is only: **filter to the room's own units, rank by margin, and push.**

```sql
-- room-scoped, worst first
SELECT p.pu_code, p.ours_json, p.theirs_json, pu.ward, pu.lga
  FROM result_pairs p
  JOIN group_members m ON m.assigned_pu = p.pu_code AND m.group_id = ?
  JOIN polling_units pu ON pu.pu_code = p.pu_code
 WHERE p.contest = ? AND p.presence = 'both'
```

Severity by **absolute vote delta**, not percentage: a 40-vote swing matters
the same whether the unit polled 400 or 4,000, and percentages make small units
scream.

Push through the existing channel ([[hawkeye-notification-channels]]), capped
per room per hour — an alert stream nobody can keep up with is an alert stream
nobody reads.

**Hard rule:** the alert states **what two sources say** and never who is at
fault. The moment the room asserts fraud on its own, it is a partisan
instrument and the ledger underneath it is worth nothing.

**Effort:** 1 query, 1 tab, 1 push template, ~3 days.

---

## 4. The party's own tally, before INEC's — *build last*

**The pitch.** Agents already collect EC8A copies. Aggregating them gives a
party its own projected count hours before collation — for its own planning,
not for publication.

**Last, deliberately**, for two reasons.

*Honesty of the denominator.* A tally over the units a party actually covers is
not a projection of the state, and a screen that lets someone forget that will
be screenshotted and posted. Every number ships with its coverage beside it —
**"LP 203,441 across 12% of units"** — and the room refuses to roll up above a
coverage floor rather than printing a number it cannot stand behind.

*It is the most dangerous data in the product.* A party's private projected
tally is worth a great deal to its opponents and to the state. `group_managers`
scoping already exists and is not enough on its own; this needs a deliberate
decision about export, retention and who in a room can see a state-level
number, taken **before** the feature exists rather than after.

**Effort:** rollup service + coverage gate + tab, ~4 days, plus the security
decision above, which is not a coding task.

---

## Sequence

```
1. Attendance        ~2d   ← value before polls close; unlocks the roster
2. Deployment map    ~2d   ← no schema change; sells in the pre-election weeks
3. Discrepancy alerts ~3d  ← the item that sells to an incumbent
4. Own tally         ~4d   ← most valuable, most dangerous, needs 1–3 first
```

Roughly **eleven working days** of build. The gating item is not code; it is
the data-protection decision in §4.

## The one thing to settle first

The moment a party's roster and projected tallies live in Hawkeye, the project
is holding data that is valuable to that party's opponents **and to the state**,
about identifiable people, in a country where that has consequences.

Room roles and scoping exist, but this is a different order of risk from an
observer's own reports. Settle it deliberately — retention window, export
limits, what a compelled disclosure would actually hand over — before pitching
anyone, not after the first room is full.

Related: [[hawkeye-campaign-dashboard]], [[hawkeye-room-roles-and-roster]],
[[hawkeye-irev-comparison-chain]], [[hawkeye-osun-2026-zero-reports]].
