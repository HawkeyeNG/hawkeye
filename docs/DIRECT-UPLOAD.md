# Direct-to-R2 uploads — when to switch, and what it costs

## Why this exists

GO54/WhoGoHost confirmed in writing on 2026-09-06:

> Uploads from users (e.g., photos, POST requests) **do count** toward your
> monthly bandwidth. This is because providers measure traffic at the network
> interface level, not just what is served out.

> The 120 GB disk quota is a **hard cap**. Once reached, uploads will fail. You
> are on our **highest shared hosting plan**, as such we cannot upgrade you.

> If bandwidth or disk space is exceeded, the site will be **throttled or
> suspended until the next cycle**.

Suspension on 16 January 2027 is the worst operational outcome this project has.
Everything below exists to keep that impossible.

**Their suggestion to "use Cloudflare" only fixes outbound.** Cloudflare never
caches a POST body; uploads are proxied straight to the origin.

## The trap in what we already built

`services/blobstore.js:putBlob()` sends bytes from the **server**:
`submissions.js` receives the photo into memory (`multer.memoryStorage()`), then
PUTs it onward. So with `BLOB_DRIVER=s3` every photo crosses the origin twice —
inbound from the observer, outbound to the bucket.

**It fixes the disk cap and roughly doubles the bandwidth problem.** Anyone
flipping that switch expecting relief would get the opposite. That is why the
presigned path below exists.

## Measured cost per observer

Replicating `app.js:compressCapture` exactly (sheet 1500px/q0.76, venue
1280px/q0.72) over 40 real sheets from the Osun corpus:

| | mean | median | p90 |
|---|---|---|---|
| Sheet photo | 218 KB | 220 | 271 |
| Venue photo | 152 KB | 153 | 186 |
| **One observer** | **369 KB** | | |

This is a **lower bound**: the corpus is already INEC's 1500px derivative, so a
phone photo of the same sheet starts from a 12 MP frame and lands larger. Plan
on **~500 KB per observer** (a 1.35× allowance).

## When to activate

At 500 KB/observer, against a 120 GB disk cap (≈115 GB usable) and 150 GB/month:

| Constraint | Ceiling | Resets? |
|---|---|---|
| Disk | ~235,000 observers | never — cumulative |
| Bandwidth, uploads only | ~307,000 / month | monthly |
| Bandwidth, uploads + one cached read each | **~153,000 / month** | monthly |
| Bandwidth, uploads + uncached reads | as low as ~75,000 | monthly |

Allowing ~15% for HTML/JS/API traffic, the realistic ceiling is **~130,000
observers in an election month** — and only if the Cloudflare cache rules in
`cloudflare-rules.md` are live. Today they are not: the `Vary: User-Agent`
header means every asset read reaches the origin, which puts the ceiling in the
bottom row instead.

### The trigger

**Activate R2 at 75,000 registered observers.** Whichever of these fires first:

| Trigger | Why this one |
|---|---|
| **75,000 registered observers** | ~58% of the 130k ceiling — the requested margin, and it leaves room for the gap between registering and actually submitting |
| **Disk ≥ 50 GB** (42% of cap) | Directly observable *today*: the DirectAdmin `quota` field works. Assumes nothing about views |
| **Cache rules still not live at 40,000 observers** | Without them outbound is unbounded and the ceiling roughly halves |

Being early costs about **$5/month**. Being late costs the site on election day.
The asymmetry is the whole argument; do not optimise this number downward.

**Lead time to allow:** bucket + credentials (1 h), the client change and its
test (½ day), backfilling existing objects (minutes at current volume), and a
real end-to-end round trip from a phone. Call it two days of unhurried work —
which is exactly what the 75,000 trigger buys.

## Who we pay

**Cloudflare.** R2 is their S3-compatible object storage — the same account that
already runs our DNS and CDN, so no new vendor and no migration.

- Free tier: 10 GB storage, 1M Class A (writes)/month, 10M Class B (reads).
- Beyond it: ~$0.015/GB-month storage, ~$4.50/million writes, **zero egress**.
- At 350,000 observers ≈ 130 GB ≈ **under $10/month**, all in.

Zero egress is the part that matters: it means the analysis worker below can
pull every photo back out for free, and public viewing costs nothing.

*Verify current pricing before committing — these figures are from memory and
Cloudflare changes them.*

**If we ever leave Cloudflare** (the Project Shield contingency), R2 is
S3-compatible: the adapter re-points with four environment variables. No code
change, no re-migration.

## The path

```
  phone                         origin (shared host)              R2
    │                                  │                           │
    │ 1. compress, sha256              │                           │
    │─── POST /api/uploads/presign ───▶│  (a few hundred bytes)    │
    │◀── presigned PUT + checksum ─────│                           │
    │                                                              │
    │ 2. PUT the photo ───────────────────────────────────────────▶│
    │    (bytes NEVER touch the origin)      R2 verifies checksum  │
    │                                                              │
    │─── POST /api/submissions ───────▶│  metadata + hashes only   │
    │                                  │── HEAD (no body) ────────▶│
    │                                  │   confirm it exists       │
    │                                  │  append ledger, enqueue   │
    │                                  │  analysis job             │
```

### Integrity is not weakened

The presigned URL is signed for **one key and one checksum**. The key is the
content hash (`<sha256>.jpg`), and `x-amz-checksum-sha256` is a *signed* header,
so the client cannot drop or alter it without invalidating the signature. R2
verifies the body against it and rejects a mismatch with 400.

**An object cannot exist at key X unless its bytes hash to X.** That is exactly
the property the ledger depends on, now enforced by the storage layer instead of
by the origin having read the file. The observer's signature still covers
`imageSha256`/`venueImageSha256` — content hashes, never paths — so verification
is byte-for-byte the same operation it always was.

### What genuinely changes: analysis, not integrity

The origin no longer has the pixels, so it cannot at submission time:

- compute the perceptual **dhash** used for duplicate detection,
- extract **ORB venue features**,
- run **OCR** (already off the request path — `ocr_jobs`).

These move to a worker that pulls from R2 (egress is free) and writes results
back. **Duplicate detection becomes a prompt asynchronous flag rather than a
synchronous rejection.**

That is a real behaviour change and the one decision here that is not purely
technical. It is defensible — the ledger is append-only, every submission is
recorded and reviewable, and a duplicate flagged a minute later is still caught
before collation — but it converts an enforcement point into a detection point
and should be an explicit choice.

*The alternative that preserves synchronous rejection is to have the client also
send a small greyscale thumbnail. Reject it: a client that supplies its own
duplicate-detection input can defeat the check, which is worse than detecting
late.*

## Status

| Piece | State |
|---|---|
| `presignPut()`, `headBlob()` in `blobstore.js` | **written**, `tests/presign.test.mjs` passing with controls on every signing input |
| `POST /api/uploads/presign` route | not written |
| `UPLOAD_MODE=proxy\|direct` flag (default `proxy`) | not written |
| `submissions.js` direct branch | not written — touches the ledger path, wants review |
| Analysis worker (dhash/ORB/OCR from R2) | not written |
| Backfill of existing objects | not written |

Nothing above is active. `BLOB_DRIVER` stays `fs`; `putBlob` is untouched and
still the only write path. The new functions are additive and unreferenced.

## Before switching, in order

1. Fix `Vary: User-Agent` and land the cache rules — that alone roughly doubles
   the observer ceiling and is free.
2. Get a Cloudflare API token (Analytics: Read) so consumption is *measurable*.
   The DirectAdmin bandwidth counter is frozen — 25.9 MB of verified traffic
   moved it 0.0 MB over 9 hours while `disk` changed in the same response.
3. One real round trip: presign → PUT from a phone → HEAD → fetch → compare
   hashes.
4. Backfill, then flip `UPLOAD_MODE=direct`. `proxy` remains the rollback.
