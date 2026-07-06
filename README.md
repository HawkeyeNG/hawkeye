# Hawkeye — crowd-verified election results monitoring (Nigeria / INEC)

Hawkeye is a **parallel results verification** platform. Observers physically present
at a polling unit photograph the official result sheet (EC8A) as it is announced,
enter the per-party counts, and submit both from their phone. Independent matching
reports from different observers raise a public **confidence score** for that unit's
result. Every accepted submission is appended to a **tamper-evident hash chain**
whose head can be anchored on a blockchain, so history cannot be quietly rewritten —
not even by the people running the server.

This is a transparency layer, not a replacement for INEC — the official result
remains INEC's. It works the same way as proven parallel vote tabulation efforts
(e.g. Yiaga Africa's PRVT), but crowdsourced and evidence-backed.

## What is enforced right now (MVP)

| Threat | Countermeasure in this codebase |
|---|---|
| Reporting for a distant polling unit | **Two location tiers.** Units with verified coordinates: hard geofence — only listed within `GEOFENCE_RADIUS_M` (200 m) of the device, re-checked server-side on every submission. Units without verified coordinates (most of the register — see "Coordinates" below): reachable via register browse, but the observer's GPS is recorded as a *claim*, the result is publicly badged **location unverified**, and it can never reach `verified` status until ≥ `MIN_LOCATION_REPORTS` (3) independent observers report from within `CLUSTER_RADIUS_M` (150 m) of their common median point — at which point the location becomes **provisional** and the median becomes the unit's crowd coordinate (bootstrapping the geofence for everyone after). A robust median is used so a minority of colluding liars cannot drag the cluster. |
| Blurry/undefined location | Submissions with GPS accuracy worse than `MAX_GPS_ACCURACY_M` (100 m) are rejected. |
| Uploading an old/downloaded photo | The PWA has **no file picker** — photos come only from live `getUserMedia` camera captures. The server rejects any photo whose capture timestamp is older than `PHOTO_MAX_AGE_S` (10 min) or in the future. |
| Reporting a unit you never visited | Every submission requires **two live photos**: the EC8A result sheet AND the polling unit/building/surroundings, each time-stamped, **GPS-stamped at capture time**, and bound (by hash) into the signed payload and the ledger. All three fixes (sheet photo, venue photo, submission) must agree within `PHOTO_GPS_COHERENCE_M` (750 m) — photographing in one place and submitting from another fails, and via the submission fix both photos are transitively checked against the geofence/approximate envelope. |
| Reusing someone else's photo | Exact duplicates are blocked by SHA-256 and re-encodes/crops by perceptual dHash (Hamming ≤ `DHASH_HAMMING_THRESHOLD`) — across **both** photo types, so a sheet photo can't reappear as someone's venue photo. Two *genuinely different* photos of the same sheet/building by different observers pass — that's the desired behaviour. |
| One person reporting many times | One verified phone number = one observer identity. A `UNIQUE(pu_code, observer_id)` constraint (and the smart contract's `hasSubmitted` mapping) enforces **one report per observer per unit, forever**. |
| Impersonating an observer | Each device generates a **non-extractable ECDSA P-256 keypair** (WebCrypto). Every submission is signed client-side; the server verifies the signature against the key registered at OTP verification. |
| Server operator tampering with history | Every accepted submission is chained: `entry_hash = SHA256(prev_hash + payload)`. `GET /api/ledger/verify` lets anyone re-verify the whole chain, and the head hash can be anchored on-chain via `HawkeyeLedger.anchorLedger()`. |
| A single liar flipping a result | Confidence = weight of the largest identical-votes group ÷ total weight. A unit is only marked **verified** with ≥ `MIN_REPORTS_FOR_VERIFIED` (3) matching reports **and** ≥ `MIN_CONFIDENCE_FOR_VERIFIED` (66 %). Conflicting reports mark it **disputed** for human review. |

## Honest limitations — read this before trusting it

No web app can make browser GPS unspoofable. A technical user with a mock-location
app or devtools **can** fake coordinates. The geofence raises the bar and defeats
casual/remote manipulation, but hard location assurance requires the roadmap items:

1. **Native app wrapper** (Capacitor) with Google Play Integrity / Apple App Attest +
   mock-location detection.
2. **Observer accreditation** — cross-check registrations against party-agent and
   civil-society observer lists so weight concentrates in vetted identities.
3. **Statistical anomaly detection** — units whose result diverges wildly from their
   ward/LGA pattern get flagged regardless of confidence score.
4. **OCR cross-check** of the photographed EC8A against the typed numbers.
4b. ~~Venue-photo scene matching~~ — **shipped** (`backend/src/services/scene.js`):
   ORB keypoints + Lowe ratio test + RANSAC homography (WASM OpenCV, fully
   offline). A venue-photo pair is `confirmed` only when ≥ `SCENE_MIN_INLIERS`
   (15) matched points **and** ≥ `SCENE_INLIER_SHARE` (50 %) of good matches
   agree on one geometric transform — two different buildings essentially never
   do. Confirmed pairs surface as `venueMatches` on results and the dashboard
   (🏫). Deliberately corroborative-only for now: it never rejects (different
   angles legitimately fail to match) and doesn't yet change trust tiers —
   thresholds should be validated on real venue photos first. CLIP-style
   embeddings were considered and deferred: their false-positive mode (two
   *similar-looking* school buildings scoring as a match) is the common case
   among polling venues, and they'd add a ~90 MB runtime model download. The
   scorer is pluggable if that trade-off changes.
5. SMS OTP is a stub in dev (`devOtp` is returned/logged). Wire a real provider
   (Termii, Africa's Talking, Twilio) before any deployment.
6. Reputation weighting exists in the data model but every observer currently
   weighs 1.0. The intended loop: reputation rises when your reports match final
   consensus, so serial liars decay.

The system's real strength is **redundancy**: rigging a unit requires simultaneously
faking location, capturing a fresh forged photo, and out-numbering honest observers —
per polling unit, at scale, on election day.

## Repo layout

```
Hawkeye/
├── contracts/HawkeyeLedger.sol   on-chain registry: observers, one-report-per-unit,
│                                 weighted tally groups, ledger anchoring
├── backend/                      Node 22 + Express + SQLite (swap to Postgres later)
│   ├── src/server.js             entry point — serves API + PWA on :8430
│   ├── src/routes/               observers (OTP), polling-units (geofenced), submissions
│   ├── src/services/             geo/oracle, image hashing, signatures, ledger, scoring
│   ├── src/data/                 18 registered parties + SAMPLE polling units
│   └── scripts/                  load real INEC PU data · end-to-end smoke test
└── app/                          observer PWA + public dashboard (vanilla JS, no build)
```

## Quick start

```bash
cd backend
npm install
npm start                    # http://localhost:8430  (API + observer app)
# in another terminal:
node scripts/smoke_test.js   # full E2E: 3 observers report, attacks get rejected
```

Open `http://localhost:8430` for the observer app and
`http://localhost:8430/dashboard.html` for the public confidence dashboard.

**Testing on a phone:** camera and GPS require a *secure context*. `http://localhost`
works on the dev machine; for a phone use an HTTPS tunnel
(`cloudflared tunnel --url http://localhost:8430` or ngrok).

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/observers/register` `{phone}` | Sends OTP (dev: returns `devOtp`) |
| `POST /api/observers/verify` `{phone, otp, publicKeyJwk}` | Registers device key, returns JWT |
| `GET /api/polling-units?lat=&lng=` | Units within the geofence only |
| `GET /api/parties` | Registered parties |
| `POST /api/submissions` (multipart, Bearer) | photo + votes + GPS + client signature |
| `GET /api/results` / `GET /api/results/:puCode` | Aggregated results + confidence |
| `GET /api/ledger/verify` | Public audit: re-verifies the entire hash chain |
| `GET /uploads/<sha256>.jpg` | Evidence photos (public audit artifacts) |

## Real data

### Polling-unit register (loaded)

The **full official register — 176,846 polling units** with their real INEC
delimitation codes (`SS-LL-WW-PPP`), names, wards, LGAs and states — is loaded from
the community scrape of INEC's IReV portal
([Emeka-Onwuepe/Polling_Units_in_Nigeria](https://github.com/Emeka-Onwuepe/Polling_Units_in_Nigeria)),
kept locally at `backend/storage/raw/nigeria_polling_units.csv`:

```bash
node scripts/load_inec_register.js storage/raw/nigeria_polling_units.csv --replace
```

### Coordinates — read this

**INEC's polling-unit GPS database has never been publicly released**, and the
community-geocoded files circulating from 2023-election analyses are town-level
accurate at best — useless (and dangerous) for a 200 m geofence: a wrong fix either
blocks honest observers at the real unit or plants the fence where a fraudster
happens to stand. So Hawkeye treats coordinates as a **separately-verified layer**:

- register units load with `lat/lng = NULL`; they are reachable through the
  in-app register browse (state → LGA → ward), their reports are badged
  **location unverified**, and GPS clustering can promote them to **provisional**
  (crowd-located) — see the threat table;
- a third layer of **approximate locations** (`approx_*` columns) is built from
  open GRID3 data by `scripts/fetch_grid3_data.js` + `scripts/build_approx_locations.js`:
  fuzzy name-matching against schools (25,841 PUs @600 m), typed landmarks —
  markets/churches/health facilities/halls/police (2,880 @600 m), settlement
  points for village open-space units (24,332 @900 m, ward-anchored to dodge
  duplicate village names), and ward centroids for the rest (109,329, km-scale
  radius from ward area; 91.5 % of register wards matched). Coverage: **162,382
  of 176,846 PUs, 53k at few-hundred-meter scale**. These envelopes **never
  geofence** — they flag tier-2 GPS claims (`location_plausible` per submission)
  and veto crowd clusters that form outside the unit's plausible area
  (`location_plausibility`, ⚠ on the dashboard) — a coherent-but-planted cluster
  from colluders is exactly what this catches;
- every tier-2 result carries a fused **location evidence score** (0–100,
  `location_score`): GPS cluster tightness (≤30) + independent reporter count
  (≤25) + agreement with the approximate envelope (25 for landmark-scale, 15 for
  ward-scale, 5 with no envelope, **hard 0 if inconsistent**) + ORB-confirmed
  same-venue photo pairs (≤20). Capped at 95 — only field-verified coordinates
  score 100. One transparent number fusing where observers stood, where open
  data says the unit is, and whether their photos show the same place;
- `scripts/attach_coordinates.js <csv> --source <label>` merges vetted coordinate
  batches (CSV: `pu_code,lat,lng[,source]`), bbox-validated, provenance-tagged;
- `GET /api/coverage` reports how many units are geofence-ready, by source;
- `src/data/sample_coordinates.csv` carries demo fixes for 8 real Lagos Island
  units (`source=sample`) so dev/demo works — **never ship those live**.

Building the verified layer is a field exercise: observer organisations capture a
GPS fix at each unit they cover (the app itself can bootstrap this in a pre-election
"mapping mode"), or an official/GRID3 release lands. Load what you can verify;
coverage grows unit by unit.

Refresh `parties.json` from INEC's registered-party list ahead of the election —
registrations change.

### Contests (multiple elections per polling unit)

Election day carries several contests at each unit. Observers pick which election
they are reporting (`data/contests.json` → `/api/contests`; presidential, Senate,
House of Reps, governorship, state assembly) and may submit **one report per
contest** per unit — each with its own fresh photos of that contest's results
sheet (the near-duplicate photo guard is relaxed for the *same observer at the
same unit*, since their venue shots minutes apart legitimately look alike; it
stays strict across observers, and self-submissions never ORB-corroborate each
other). Votes aggregate per contest; the location axis (clusters, plausibility,
evidence score) pools every report at the unit regardless of contest. Update
`contests.json` against INEC's official timetable, and extend it with per-party
candidate names once nominations are formally announced.

### National leaderboard (`/results.html`)

Tentative, explicitly-unofficial national tallies per contest: an SVG map of
Nigeria (self-built from GRID3 state boundaries — `scripts/fetch_states_geo.js`)
showing the **leading party's emblem on each state**, plus a ranked party table
(votes, share, states led), auto-refreshing from `/api/national/:contest`.
Party emblems: `scripts/fetch_party_logos.js` pulls what Wikipedia exposes
(most major-party logos are "non-free" files it will not serve); every party
without a downloaded file renders as a colour-branded monogram badge. Drop
official artwork into `app/logos/` and list it in `app/logos/manifest.json`
to upgrade any party's marker.

## SMS OTP delivery

`SMS_PROVIDER=console` (default) logs codes for development. For real delivery set:

```
SMS_PROVIDER=termii
TERMII_API_KEY=<your key from termii.com>
TERMII_SENDER_ID=N-Alert   # or your registered sender ID
TERMII_CHANNEL=dnd         # delivers to Do-Not-Disturb-listed SIMs (most of Nigeria)
```

[Termii](https://termii.com) is Nigeria-focused (the `dnd` channel matters — generic
international gateways silently drop DND-listed numbers). The server refuses to start
in production with the console provider, and OTP codes are never echoed in responses
outside dev. Adding Africa's Talking/Twilio is one new case in
`backend/src/services/sms.js`.

## Smart contract

`contracts/HawkeyeLedger.sol` (Solidity 0.8.24) mirrors the backend rules on-chain:
accredited observers, oracle-signed location attestation verified with `ecrecover`,
one submission per observer per unit, weighted tally groups with a leading-result
confidence view, and `anchorLedger()` for committing the backend hash-chain head.
Deploy with Hardhat/Foundry to a permissioned PoA network where each validator is an
independent organisation (CSOs, media houses) — that, not a public mainnet, is the
right trust model here. The backend runs standalone without a chain; anchoring is
additive.

## Privacy & legal notes

- Phone numbers are stored **only as salted HMAC hashes** (NDPR-friendly).
- Result-sheet photos are treated as public audit evidence — that is the point of
  the system; make this explicit in the observer terms.
- Posted EC8A results are public documents; photographing them is standard observer
  practice, but review current INEC guidelines on conduct at polling units.
