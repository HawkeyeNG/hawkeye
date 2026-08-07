# Capture-first reporting flow

Status: spec. Freshness window already changed (see §5); everything else is to build.

## 1. The decision

Reporting moves from **select-then-capture** to **capture-then-confirm**.

On election day the EC8A sheet is the perishable thing — an INEC agent may display
it briefly, a crowd forms, and access closes. Everything else an observer needs to
supply (which unit, which race, the counts) is *still true five minutes later, from
somewhere safer*. The old order made the durable steps block the perishable one.

Two independent wins:

- **Evidence.** The camera is one tap from cold, so nothing is lost to a picker.
- **Safety.** Photograph, then leave. Counts, unit and race get confirmed away from
  the crowd. This matters most for incidents (§6).

### What this does NOT change

The observer signature is a single ECDSA sign over the whole canonical payload at
submit time — `puCode`, `contest`, `votes`, both photo hashes, both timestamps, all
GPS fixes (`backend/src/services/signatures.js`). Nothing is signed incrementally,
so **step order is cryptographically free**. The ledger, the hash chain, the anchor
and every server-side gate stay exactly as they are.

## 2. Target order

Current → target, per flow:

| Flow | Now | Target |
|---|---|---|
| Result | unit → race → sheet → venue → votes → send | **sheet → venue → confirm(unit·race·votes) → send** |
| Collation | scope → race → form → venue → votes → send | **form → venue → confirm(scope·race·votes) → send** |
| Incident | unit → report | **report → locate** (§6) |
| Practice | mirrors Result | mirrors Result — must move in lockstep, it is the rehearsal |

Two rules behind the shape:

1. **Both photos back-to-back.** Sheet then venue, same physical position, one
   context switch. The originally-proposed order interleaved camera → typing →
   camera, which spends the freshness budget on typing *between* two photos and
   makes the observer re-settle in the crowd.
2. **Resolve early, confirm late.** Unit and race are *determined* while the
   observer is shooting (OCR + GPS, §3/§4) and merely *confirmed* on the review
   card. This keeps the fail-fast behaviour of the old order without making anyone
   tap first.

### Why "confirm late" is not the same as "validate late"

Five gates reject on unit/contest: `reporting_not_open`, `contest_not_applicable`,
`device_already_reported_race` (409 — one device, one race, ever),
`outside_geofence`, `unknown_polling_unit`.

If unit/race are genuinely unknown until the end, an observer can shoot the sheet,
type 18 counts, shoot the venue, and *then* be told this device already filed that
race. The work is gone and the sheet is no longer in front of them.

So the resolution ladder (§4) must run **in the background during capture**, and any
gate that can be evaluated locally must be evaluated then — not at submit. The
review card shows the outcome; it does not discover it.

## 3. OCR polling-unit extraction

### 3.1 What we are reading

Every code in the register is exactly 12 characters, `NN-NN-NN-NNN` —
state, LGA, ward, unit. Verified against production: **176,846 rows, all length 12,
no exceptions.** Osun is state `29` (e.g. `29-01-01-009`, Town Hall Iwara).

The EC8A header carries both the delimitation code and the unit name, so both are
available as signals.

> Note: the `/report` how-to video uses `25-01-05-012` as its example while naming an
> Osun ward. Osun codes start `29`. Cosmetic, but worth fixing before the video is
> pushed further.

### 3.2 Current state

`native/src/lib/ocr.ts` already returns the **full raw recognised text** but parses
only party counts out of it:

```ts
type SheetRead = { text: string; numericLines: number; counts: Record<string, number> };
```

The unit code is almost certainly already sitting in `text`. Web has the equivalent
via Tesseract.js (`app/app.js`, self-hosted WASM under `vendor/tesseract`). **No new
OCR dependency is needed on either platform** — this is a parser over text we
already have.

### 3.3 Algorithm

Runs on-device, on `SheetRead.text`.

**Step 1 — harvest candidates.** Scan for 2-2-2-3 digit groups with tolerant
separators. Accept OCR-confusable glyphs in digit positions:

```
[0-9OoDQIl1SsBZzGT]{2} SEP{0,2} [..]{2} SEP{0,2} [..]{2} SEP{0,2} [..]{3}
SEP = - – — . / _ space
```

**Step 2 — normalize.** `O o D Q → 0`, `I l i | ! → 1`, `S s → 5`, `B → 8`,
`Z z → 2`, `G → 6`, `T → 7`; all SEP → `-`.

**Step 3 — shape-validate.** `/^\d{2}-\d{2}-\d{2}-\d{3}$/`. Reject otherwise.

**Step 4 — register-validate.** *The register is the arbiter; OCR is never trusted
on its own.* Exact lookup of the canonical code.

**Step 5 — single-substitution repair.** On no exact hit, try one substitution at a
time from the confusion set. **Accept only if exactly one repair resolves to a real
code.** Two or more candidates → ambiguous → fall through to Tier B. Silence beats
a confident wrong unit.

**Step 6 — name corroboration.** Fuzzy-match the OCR text against the resolved
unit's `name`. Raises confidence, and breaks ties in step 5.

**Step 7 — GPS corroboration.** If a fix exists and the resolved unit is beyond
`discoveryRadiusM`, **downgrade to suggestion, never auto-select.** This is the
guard against reading a code off a sheet that did not come from here.

### 3.4 Output

Extend `SheetRead` (mirror the same shape in `app/app.js`):

```ts
unit?: {
  code: string;                    // canonical NN-NN-NN-NNN, register-verified
  source: 'exact' | 'repaired';
  nameMatch: boolean;
  gpsAgrees: boolean | null;       // null = no fix available
  confidence: 'high' | 'low';
}
```

`high` = `(exact || (repaired && nameMatch)) && gpsAgrees !== false`.

### 3.5 Confidence → behaviour

| Confidence | UI |
|---|---|
| `high` | Auto-select. Chip reads **"From sheet"**, one tap to change. |
| `low` | Pre-select inside the near-me list. Never auto-commit. |
| absent | Tier B. |

### 3.6 Offline

Step 4 needs the register. The outbox exists because election-day networks fail, so
Tier A must work offline: steps 1–3 and 5–7 are pure local computation, and step 4
resolves against **the near-me slice already cached for Tier B**. Full-register
resolution via the server is the online-only enhancement, not the baseline.

## 4. Resolution ladder

Each tier is the previous one's failure path. **Tiers B and C already exist** — this
is glue plus Tier A, not new subsystems.

- **Tier A — from the sheet.** §3. Zero taps when it works.
- **Tier B — near me.** `GET /api/polling-units?lat&lng` — distance-sorted, radius
  `discoveryRadiusM`, capped at `discoveryMaxRows` (40), returns a `truncated` flag.
  Already built and already tuned against real register density.
- **Tier C — search.** `GET /api/register/search` plus the state → LGA → ward → unit
  browse, and partial name/code typing. Already built. This is the no-GPS,
  no-OCR floor, and it must always be reachable in one tap from A and B — never a
  dead end.

## 5. Freshness window — DONE

`PHOTO_MAX_AGE_S` raised **600 → 3600** (`backend/src/config.js`). One change covers
Result and Collation; Incidents deliberately have no freshness check at all.

`isFresh` measures capture → **server receipt**, so this value is also the offline
outbox's usable life. At 10 minutes a queued report could not survive a single
election-day outage — the exact scenario the outbox exists for — and came back
`photo_not_fresh`.

Widening is cheap because freshness was never load-bearing: `capturedAt` is signed
by the *observer's own key*, so an observer can put any value there. What actually
binds a photo to a place and a moment is live in-app capture, the 750 m coherence
envelope across sheet/venue/submission fixes, the dhash duplicate guards, and the
one-race-per-device fingerprint. All hold at 60 minutes.

## 6. Incidents — safety first

Incidents are the flow where the old order is most wrong. Today it is
`unit → report` (`native/src/app/report/incident.tsx`): an observer witnessing
violence must stand there and pick a polling unit from a list **before** they can
photograph or describe anything.

Invert it:

1. **Report first.** Camera/description immediately on entry. Media is already
   optional (`empty_report` accepts a photo/video *or* a description), and there is
   already no freshness clock — so the backend already permits filing from safety.
   Only the UI is holding it wrong.
2. **Locate after.** GPS is stamped silently at capture. Unit attribution runs the
   §4 ladder afterwards and is **skippable** — an incident with a GPS fix and no
   unit is still a valid, useful report. Never block filing on attribution.
3. **Category after.** Classification is a calm-moment task, not a scene task.

Design rule for this flow: **nothing between opening the app and capturing.** An
observer in danger should never meet a picker.

## 7. Platform checklist

Capacitor wraps `app/` (`webDir: "../app"`), so web changes carry into the APK — no
separate work, but it does need a rebuild and an SW cache bump.

| | Result | Collation | Incident | Practice |
|---|---|---|---|---|
| Native | `report/result.tsx` | `report/collation.tsx` | `report/incident.tsx` | shares result path |
| Web / Capacitor | `observe.html` + `app.js` | `collation.html` | `incidents.html` | `practice.html` + `practice.js` |

Practice is a full product on its own chain and is how observers rehearse — if it
teaches the old order, the training is wrong. It moves with the others.

The parser has one canonical implementation mirrored across `ocr.ts` and `app.js`,
following the existing `canonicalPayload` convention (`signatures.js` header:
"must produce byte-identical output to their mirrors in app/app.js").

## 8. Build order

1. Freshness window — **done**.
2. Incident inversion — smallest change, largest safety payoff, no OCR dependency.
3. §3 parser + `SheetRead.unit`, native and web, behind the ladder's Tier A.
4. Result and Collation reorder, consuming the ladder.
5. Practice, in lockstep.
6. Capacitor rebuild + SW cache bump; native rebuild.
