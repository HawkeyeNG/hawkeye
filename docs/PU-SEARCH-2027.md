# Polling-unit search for 2027 (176,846 units)

**Status: BUILT.** Steps 1–7 are done and their gates pass; `register-osun.json`
and its crawler are deleted. The one thing still outstanding is the **real-device
measurement** (step 2's gate) — every timing below is extrapolated from a laptop.
See "Build status".

## The problem

For Osun 2026 we shipped one state (3,763 units) as a 1.7 MB nested JSON that the
client fetched, parsed and flattened in memory. 2027 is the whole federation:
**176,846 units across 37 states, 768 LGAs, 8,432 ward names.** The same approach
scaled 47x does not work.

It matters more than it did in 2026, because **near-me is effectively gone**:
only **8** of 176,846 rows have a real coordinate. 117,159 come from the
`geocoded_inec.csv` corpus that is ~33% wrong and still live in production
(`hawkeye-geocode-corruption`), and 59,679 have nothing at all. Search is no
longer the fallback for near-me — it is the primary way an observer reaches
their unit, standing at the unit, on a cheap phone, on election-day networks.

## What we measured first

Wire size was never the blocker. Whole-register encodings, measured on the real
`polling_units` table:

| Encoding (all 176,846 units) | Raw | Gzip | Brotli |
|---|---|---|---|
| Naive objects (today's shape, scaled) | 19.4 MB | 1.97 MB | 1.58 MB |
| Nested tree (`register-osun.json` shape) | 19.5 MB | 2.06 MB | 1.65 MB |
| Columnar + dictionary | 9.3 MB | 1.72 MB | 1.27 MB |
| Codes only | 2.2 MB | 0.40 MB | 0.14 MB |

The blocker is **parse and memory**, not download: `JSON.parse` of 9–19 MB of
text on a 1 GB Android Go phone in a WebView, and today's code does it *twice*
(`app.js` keeps the nested tree, `pu-search.js` independently fetches the same
file and flattens it into a second copy).

## The design

**Tier-0 national index (precached) + 37 on-demand state packs (IndexedDB,
compressed at rest).** One shared `app/register-store.js` owns
fetch → verify → inflate → index → search for web, Lite and native.

### Pack format

- **Group key is the 8-char `pu_code` prefix, not the ward name.** Ward names are
  ambiguous — 8,432 distinct names but 8,793 real (state, lga, ward) triples.
  Verified: every one of the 176,846 codes matches `DD-DD-DD-DDD` and all are
  unique, so a pack stores prefix-per-group (u32) + serial-per-unit (u16, max
  observed 282) and **no code strings at all**.
- Per-row payload is one thing: the unit name, in an LF-separated **UTF-8** blob
  (verified: no name contains LF or CR). Ward / LGA / senatorial / federal are
  per-group. `registered_voters` is dropped — verified 100% NULL.
- Packs ship the **display** name; the client folds once at index-build time.
  Shipping both forms would double the name bytes for no gain.
- Group metadata is **columnar and delta-coded**, not row-interleaved. Measured on
  the national index: 47.4 KB → 12.5 KB, which is what brings the precached index
  under its budget.
- **No coordinates ship.** GPS is used only to guess *which state pack to
  prefetch* (state polygons dwarf the geocoding error). It never ranks or
  asserts a unit.

### Measured sizes — REAL, from the built generator (gzip, level 9)

These replace the earlier brotli estimates. **Gzip, not brotli, is the format**:
the client inflates with `DecompressionStream`, which supports `gzip`/`deflate`
only — there is no brotli in that API — and we cannot lean on `Content-Encoding`
because packs are deliberately stored *compressed at rest*. Gzip costs ~15% more
than brotli; that is the price of being able to inflate it offline.

- Index pack **55.6 KB** — the only thing added to the install.
- State packs: median **32.0 KB**, Bayelsa 16.4 KB, **Lagos 113.4 KB** (worst).
- All 37 states + index: **1.39 MB** gz, stored compressed on disk.

### Measured load (Lagos, worst state, on a laptop)

gunzip 1.4 ms + latin1 decode 1.1 ms + LF offset scan 3.4 ms = **5.9 ms**;
substring search 0.27 ms for "PRIMARY SCHOOL" (225 hits). At an assumed 6x
Go-phone penalty: ~35 ms cold, ~2 ms per keystroke. **The 6x multiplier is an
extrapolation, not a measurement — step 2 of the build plan exists to replace it
with a real device number.**

## Three constraints adopted from the adversarial critiques

1. **Compressed at rest.** `fetch()` transparently inflates, so Cache Storage
   would hold ~5 MB. Packs are served as `application/octet-stream` with no
   `Content-Encoding`, stored as raw gz bytes in IndexedDB, inflated with
   `DecompressionStream('gzip')` (fflate on Hermes, which has neither
   `DecompressionStream` nor V8's SIMD `indexOf`). All 37 states on disk = 1.3 MB.
2. **Never a spinner, never a wrong list.** Every pack carries a 32-byte header
   (magic, format version, registerVersion, state code, unit count, byte length,
   CRC32). Short read or bad CRC = reject, delete, re-fetch, and say so. This is
   the `never-cache-unvalidated-responses` rule: a truncated binary pack silently
   renders the **wrong unit**, which is worse than an error.
3. **Offline and online must agree.** The fold (NFKD, uppercase, non-alphanumerics
   to space) must exist on the server too, or the same query gives two different
   answers at the same polling unit. Server gets `name_fold` / `ward_fold`
   generated columns + nocase indexes; the client mirrors the server's existing
   rank tiers (exact code, prefix, contains) in one shared ranker.

## File changes

| File | Change |
|---|---|
| `backend/scripts/build_register_packs.mjs` | **NEW.** Reads `hawkeye.db` directly via better-sqlite3, replacing `scripts/build_register_bundle.mjs` (which crawls prod with one HTTP GET per ward — 8,793 requests, hours, self-DDoS). Emits `app/reg/index.<sha8>.pack.gz`, `app/reg/<state>.<sha8>.pack.gz` ×37, and `manifest.json`. Has a `--verify` mode that round-trips all 176,846 codes and folded names against the DB. |
| `app/register-store.js` | **NEW, the only owner.** Manifest cache, IDB store of raw gz bytes, header/CRC validation, inflate, LF-offset index build in a Worker, `search(term,{state,lga})` returning the shape `pu-search.js` already consumes, and `materialise()` rebuilding full rows (`pu_code = prefix + '-' + pad3(serial)`) for the ≤25 displayed. Kills today's double parse. |
| `app/pu-search.js` | Delete `loadFlatRegister()` / `flatRows` / `localSearch` (~41–108); route through the store. Add explicit readiness states (ready / downloading / not-downloaded / offline-and-absent) instead of falling through to a fetch that hangs. Add the state prefilter + shared ranker so "PRIMARY SCHOOL" doesn't return 50 Abia rows nationally. Keep the 280 ms debounce, 3-char minimum and `seq` guard exactly as they are. |
| `app/app.js` | `loadRegisterBundle()` / `registerFromBundle()` / `refApi()` (911–957) read the tier-0 index, so the state→LGA→ward cascade works offline **nationwide from install**; drop the `register-osun.json` fetch and the `hk_ref2` localStorage layer (which could never fit 8,432 ward payloads in a ~5 MB quota anyway). Add "Download my state (26 KB)" on observe/profile + opportunistic wifi backfill. `btn-locate` stops asserting a unit: GPS picks the state pack, copy says "confirm your unit". |
| `app/sw.js` | SHELL gains `/reg/manifest.json` + `register-store.js`; LAZY loses `register-osun.json`. `manifest.json` becomes network-first-with-cache-fallback so a register correction doesn't need a CACHE bump. **The activate handler currently deletes every cache whose name !== CACHE — it must preserve `/^hawkeye-reg-/`** or a shell deploy evicts the register on election eve. |
| `backend/src/routes/pollingUnits.js` | Add `GET /api/register/manifest`. Swap `/register/search` LIKE targets to the fold columns. Keep the prefix-seek-then-contains-scan and rank CASE untouched — it is already fast and is now the spec the client mirrors. Near-me SQL unchanged; only its copy and `locationTier` semantics change to stop implying unit-level precision. |
| `backend/src/db.js` | `name_fold` / `ward_fold` columns + nocase indexes. |
| `native/src/lib/register.ts` | Same store over fflate; drop the `require()` of the bundled `register-osun.json` copy (Metro inlines it into the JS bundle). The four screens hard-coding `${BASE}/api/register` (`report/result.tsx:62`, `incident.tsx:52`, `map-unit.tsx:132`, `collation.tsx:35`) get the index-pack fallback so browse stops being network-only. |
| `mobile/` (Lite) | Bundle **only** `index.<sha>.pack.gz` (+53 KB install). State packs always fetched. `cap sync` must not pick up the per-state packs. |

## Build plan (staged to de-risk)

1. **Generator + verifier first, zero app changes.** Gate: 176,846/176,846 codes
   reconstructed byte-identical, every folded name matches the DB. If the
   encoding is wrong, nothing downstream matters — cheapest place to find out.
2. **Store + bench page on a real phone.** `/bench.html` loads Lagos and reports
   inflate/decode/index/search timings. Gate: the 6x extrapolation holds on an
   actual 1–2 GB Go device. Do not trust laptop numbers into production.
3. **Correctness diff before cutover.** Ship the Osun pack alongside the existing
   `register-osun.json` behind `?reg=pack`. Run a 500-query corpus (real names,
   codes, prefixes, "Sch." vs "School") through both the pack and
   `/api/register/search`. Gate: identical top-10 for every query. This is where
   fold divergence surfaces, while a known-good path still exists.
4. **Server side.** Fold columns + manifest endpoint. Deploy before any client
   depends on them.
5. **Client cutover.** `pu-search.js`, then the `app.js` cascade on tier-0, then
   the pin/download UI, then `sw.js` last — a wrong cache-sweep rule is the one
   mistake installed clients cannot be told about.
6. **Native + Lite.**
7. **Delete** `register-osun.json`, `build_register_bundle.mjs`, the `hk_ref2`
   layer — only after step 3 runs green across all 37 states.

## Acceptance targets

**Bytes** (re-baselined on the real gzip build). Shell grows ≤ 60 KB — **actual
55.6 KB**. User's own state: median **32 KB**, worst case **Lagos 113 KB**. All 37
on disk ≤ 1.4 MB — **actual 1.39 MB**. Lite install delta ≤ 60 KB; a register
revision costs one state re-pull, not a full rebuild.

Lagos is 3.5x the median and is the one target the gzip build misses (113 KB vs a
90 KB brotli-era goal). Accepted for now: it is still ~18 s on a dying 50 kbit
link and the design already names LGA-level sub-packs for the top 3 states as the
escape hatch, to be built only if a real measurement demands it.

**Time to first result** (1–2 GB Android Go, airplane mode):

- State pack present: **≤ 150 ms** keystroke → rendered list, cold.
- Warm per-keystroke: **≤ 20 ms** (invisible inside the 280 ms debounce).
- State pack absent, no network: ≤ 300 ms to a ward/LGA-level answer from the
  index pack, plus an explicit "unit list for *state* not downloaded". **Never an
  indefinite spinner — that failure mode is a regression, not a degradation.**
- Congested network (50 kbit, 1 s RTT): state pack lands and search becomes
  unit-level within 10 s, UI usable throughout.

**Correctness.** All 176,846 codes round-trip byte-identical. Offline top-10 ==
online top-10 across the 500-query corpus. A truncated or corrupt pack is
rejected and re-fetched, never rendered.

**Memory.** Peak heap during Lagos load ≤ 3 MB (blob ~395 KB + Uint32 offsets
~53 KB; no per-row objects except the ≤25 displayed).

## Build status

| Step | State |
|---|---|
| 1. Generator + verifier | **done** — 176,846/176,846 round-trip byte-identical |
| 2. Store + bench page | **built**; the on-device measurement is still owed |
| 3. Correctness diff | **done** — 7,291/7,291 identical top-10 across 37 states |
| 4. Server fold + manifest | **done** — `name_fold`/`ward_fold`, `/api/register/manifest` |
| 5. Client cutover | **done** — cascade offline nationwide, verified with the network cut |
| 6. Native + Lite | **done** — pure TS decoder, checked unit-for-unit in Node |
| 7. Delete the old path | **done** |

**What still has to happen before this ships:**

1. **Measure on a real Android Go phone** (`/bench.html` → Load → Bench). Every
   number here is a laptop extrapolated by an assumed 6×. That multiplier is a
   guess and step 2 exists to replace it.
2. **Run the name repair on production** —
   `HAWKEYE_DB=… node backend/scripts/fix_register_mojibake.mjs --apply`. The API
   and the packs must return identical strings.
3. **Decide the authoritative register snapshot**, then generate and commit the
   packs (they are gitignored today, see below) and deploy them *before* any
   client that expects them.
4. **Deploy order matters**: server fold columns first (a client folding against
   an unfolded server disagrees), then the packs, then the app.

**Step 1 — generator + verifier: DONE.** `backend/scripts/build_register_packs.mjs`
(`--verify`). Runs in ~2 s against `backend/storage/hawkeye.db`, replacing the old
`scripts/build_register_bundle.mjs`, which crawled production with one HTTP GET
per ward (8,809 requests nationally, no resume — we would have been DDoSing our
own API to read data we already hold).

Gate results:

```
units reconstructed byte-identical : 176846/176846
DB rows never emitted              : 0
index groups                       : 8809/8809
corruption rejected                : 2/2      (flipped body byte, truncated tail)
VERIFY OK
```

Three corrections the build forced on the design — this is exactly why step 1
runs before any app code:

1. **UTF-8, not latin1.** 121 unit names contain characters above U+00FF; a
   latin1 blob would have silently corrupted them. UTF-8 costs a few hundred
   bytes nationally.
2. **Gzip, not brotli** — `DecompressionStream` has no brotli. All sizes above
   are re-measured accordingly.
3. **Columnar + delta group metadata** (47.4 KB → 12.5 KB on the index).

**Data-quality finding, not fixed here:** 86 unit names are **mojibake** — UTF-8
read as latin1, e.g. `"Absu Park â€“ Absu"` (`01-08-10-008`), where `â€“` should
be `–`, and `Soâ€™O` should be `So'O`. The generator reports them and does **not**
repair them: the server must return the same strings the packs ship, so a
client-side repair would break the offline == online guarantee. Fix the register,
then regenerate.

## Explicitly not doing

- **No trie, FST, succinct structure or WASM.** Measured substring scan over the
  folded blob is 0.27 ms on the worst state; anything cleverer buys nothing and
  adds a class of silent-corruption bugs.
- **No per-unit coordinates, no offline near-me.** Ward centroids derived from the
  ~33%-wrong corpus would rank a block-shifted ward first with no confidence
  signal. Laundering bad data as a ranked answer is worse than not offering it.
- **No national monolith on first launch.** The full 1.13 MB set is a wifi-only
  opt-in, never a blocking path.
- **No binary delta patching.** A whole state is 26 KB; a diff format is a second
  parser and a second corruption surface for a saving that rounds to nothing.
- **No rewrite of `/api/register/search` or the near-me bounding box.** Both are
  already fast and stay as the online path and the correctness oracle.
- **Not fixing the corrupt production geocode here.** Real bug, different clock;
  this design is built so search does not depend on it.

## Settled during the build

- **The fold cannot ship in the pack.** Precomputing it was measured and rejected:
  it nearly doubles a state pack (Lagos 113 → 214 KB). It is built on the client,
  deferred to idle, and forced only if the user types first — so it costs once,
  never per keystroke.
- **Whole-blob folding is slower than per-name**, not faster: one regex over
  400 K characters loses to 13,325 small ones. It is the obvious optimisation to
  reach for; don't.
- **Both sides must break name ties on `pu_code`.** Units really do share names
  ("13, Agboyele Street" twice in one ward) and SQLite leaves a tie unordered, so
  without it the two paths return the same rows in a different order.
- **The prefix-narrowing shortcut in the search box is gone.** It was a third
  definition of "matches" beside the pack and the API, and those two are now
  proved identical. With a pack loaded a search costs ~0.5 ms, so it bought
  nothing.
- **`registerVersion` must come from the register, not the clock**, or unchanged
  data regenerates as new filenames and every client re-downloads 1.4 MB.

## Open questions

1. **Which register snapshot is authoritative for 2027?** The pack carries a
   `registerVersion` derived from the register's own contents, and INEC will add
   or rename units before election day. Who signs off on a regeneration — and
   should the manifest be **signed** (the app already has an IndexedDB keypair)
   so nobody can serve an observer a doctored unit list? This is the one open
   question that changes the pack header, so it wants deciding before the format
   is frozen in shipped clients.
2. **Request `navigator.storage.persist()`?** Without it a low-storage Go phone
   can silently evict IDB. Default: request silently at pin time, treat denial as
   "pack may vanish, re-check on launch".
3. **Is 6x the right Go-phone multiplier?** Step 2 replaces it with a measurement.
4. **Should the fold index senatorial/federal names?** Server currently matches
   name/code/ward only; adding them changes both sides and needs its own diff run.
5. **Lagos at 89.8 KB is 3.4x the median.** If real 2027 links make that
   unacceptable, the same generator can emit LGA-level sub-packs for the top 3
   states — but not until a measurement demands it.
