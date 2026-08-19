# Deploying the 2027 polling-unit search

The order below is not a suggestion. Each step assumes the one before it has
landed, and two of the orderings have a failure mode that is invisible until an
observer is standing at a polling unit.

Design: [PU-SEARCH-2027.md](PU-SEARCH-2027.md).

## Before anything

**Measure on a real Android Go phone.** Open `/bench.html`, pick the top state
(Lagos, the worst case), tap **Load**, then **Bench 200 queries**. The page
grades itself against the targets. Every timing in the design doc is a laptop
scaled by an assumed 6×, which is a guess — this replaces it with a fact. If the
device fails the cold-load target, the fix is LGA-level sub-packs for the largest
few states, and the generator can already emit them.

## 1. Backend first

```bash
# deploy backend/ as usual, then restart
```

Two migrations run on boot, in this order, and they are why the backend goes
first:

1. **117 damaged names are repaired.** Production still holds mojibake such as
   `"Soâ€™O Primary School"`. The packs ship the repaired spelling, so until this
   runs the API and the packs disagree about what a unit is called.
2. **`name_fold` / `ward_fold` are populated** for all 176,846 rows (~10s once,
   nothing on later boots).

Watch for both lines in the log:

```
[db] repaired 117 damaged polling-unit names …
[db] populated search fold for 176846 polling units
```

**Why first:** the client searches folded text. A client folding against a server
that has not folded yet returns a different page online than offline — the exact
divergence this design exists to prevent.

## 2. The packs

`app/reg/` — 38 files, 1.4 MB — deploy with the rest of `app/` via
`scripts/deploy_app.sh`. Never batch or hand-copy: batching has truncated files
and nested paths have overwritten the homepage, both of which caused real
outages.

Verify from the outside before moving on:

```bash
curl -sI https://hawkeye.com.ng/reg/manifest.json | head -3
curl -s  https://hawkeye.com.ng/reg/manifest.json | head -5
```

The pack files must be served as bytes with **no `Content-Encoding`** — they are
already gzip and are stored compressed on the device. If the server helpfully
re-compresses or transparently inflates them, the client stores ~5 MB instead of
1.4 MB.

## 3. The app

`app/` — `sw.js` is at **v277**, and the pins moved: `app.js?v=151`,
`pu-search.js?v=6`, plus the new `register-store.js?v=1`.

**`sw.js` goes last.** A wrong cache rule is the one mistake installed clients
cannot be told about. The activate handler now preserves any cache named
`hawkeye-reg*`; do not "simplify" that back to deleting everything that is not
the current cache.

## 4. Check it from a phone, not a laptop

- Browse **with aeroplane mode on**: state → LGA → ward should work anywhere in
  the country. That is the headline of this change.
- Search a unit name in your state; then turn the network off and search again.
  The same query must return the same list.
- Search a **unit code** (`24-01-01-001`). That returned nothing offline before
  this work.

## Rolling back

The packs are additive: deleting `app/reg/` and reverting `app/` returns the site
to the API-only path, because every offline route falls through to the server. The
backend migrations are not reversible — but they only repair damaged text and add
two columns, and both are things the old code simply ignores.

## When the register changes

INEC will add and rename units before 2027.

```bash
node backend/scripts/build_register_packs.mjs --verify   # ~2s
node backend/scripts/diff_register_search.mjs            # the gate, ~5 min
```

Delete the superseded `app/reg/*.pack.gz` in the same commit — filenames carry a
content hash, so old ones linger otherwise. `registerVersion` is derived from the
register's contents, so an unchanged register regenerates byte-identical packs
and costs installed clients nothing.

## Still open

Whether the manifest should be **signed** with the keypair the app already has,
so nobody can serve an observer a doctored unit list. It changes the pack header,
so it is best decided before the format is frozen in shipped clients.
