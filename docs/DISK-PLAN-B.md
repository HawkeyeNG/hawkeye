# Disk: what to do at 50 GB, and what to do if the plan fails

## The constraint

GO54 confirmed in writing on 2026-09-06:

> The 120 GB disk quota is a **hard cap**. Once reached, uploads will fail. You
> are on our **highest shared hosting plan**, as such we cannot upgrade you.

> If bandwidth or disk space is exceeded, the site will be **throttled or
> suspended until the next cycle**.

Suspension on 16 January 2027 is the worst outcome this project has. Everything
below exists to keep that impossible.

**Today: 2,910.8 MB of 122,880 MB — 2.37%.** At the measured 500 KB per observer
(sheet 218 KB + venue 152 KB, plus a 1.35× allowance because the corpus those
came from is already a downscaled derivative) that is headroom for roughly
**245,000 more observers**.

## Knowing when

`backend/scripts/disk_watch.mjs` reads the DirectAdmin `quota` field — the one
that works; the `bandwidth` field beside it is frozen and has been proven so.

```bash
node backend/scripts/disk_watch.mjs          # or --json for cron
```

| Level | At | Exit | Meaning |
|---|---|---|---|
| OK | < 36 GB | 0 | nothing to do |
| WARN | ≥ 36 GB (30%) | 1 | check weekly; re-verify the R2 path still works |
| **ACT** | **≥ 50 GB (42%)** | **2** | **activate R2 now** |

Run it weekly from cron once WARN is reached, and daily in the month before an
election. **50 GB is not the danger point — it is the point that leaves two
unhurried days.** The danger point is 120 GB, where uploads fail outright.

## Plan A — activate R2 (built, and verified against the real bucket)

Every step below has already been rehearsed end to end
(`backend/scripts/backfill_rehearsal.mjs`, which passes and whose audit is proven
able to fail). Nothing here is theory.

```bash
# 1. credentials are shaped right (a length check once let a placeholder through)
node backend/scripts/r2_check_env.mjs

# 2. the bucket enforces what we rely on
BLOB_DRIVER=s3 node backend/scripts/r2_roundtrip.mjs   # checksum binds (400 on mismatch)
BLOB_DRIVER=s3 node backend/scripts/r2_size_test.mjs   # length binds  (403 on oversize)

# 3. copy what is already on disk
BLOB_DRIVER=s3 node backend/scripts/backfill_blobs.mjs            # dry run first
BLOB_DRIVER=s3 node backend/scripts/backfill_blobs.mjs --apply

# 4. THE GATE. Asks the database what the evidence chain NEEDS and checks each
#    against the bucket — a different question from what the backfill reports.
BLOB_DRIVER=s3 node backend/scripts/backfill_check.mjs --deep     # must PASS
```

Then, and only then:

5. Set `BLOB_DRIVER=s3` in `backend/.env`, restart, submit a test report, confirm
   the photo is readable from the site.
6. Set `UPLOAD_MODE=direct`, restart. The dhash migration runs itself at boot
   (the host has no shell, so this is the only route). Confirm the log does **not**
   say `UPLOAD_MODE=direct requested but NOT ACTIVE`.
7. **Leave the local copies in place for at least a week.** `BLOB_DRIVER=fs` is
   the rollback, and it only works while the files are still there. Deleting them
   is the last step, not part of the switch.

Reclaiming step 7 is what actually returns the disk: everything in `uploads/`
that `backfill_check --deep` has confirmed is in the bucket.

## Plan B — if R2 cannot be activated

The adapter is the whole point: `blobstore.js` speaks plain S3, so a different
provider is **four environment variables**, no code change and no second
migration.

| If | Then | Cost | Lead time |
|---|---|---|---|
| **B1** — R2 billing or account blocked | Any S3-compatible store. Backblaze B2 is the closest match: egress to Cloudflare is free under the Bandwidth Alliance, which is the property that matters | ~$6/TB-month | ~1 hour |
| **B2** — we must leave Cloudflare entirely (the Project Shield contingency) | Same adapter, different endpoint. Egress is no longer free, so budget for reads as well as storage | ~$6/TB + egress | ~1 hour |
| **B3** — object storage ruled out | GO54's own VPS: 1–2 TB, flexible disk. This is a **migration, not a flip** — new host, new deploy path, new TLS | ~$40–80/month | **days, not hours** |
| **B4** — out of time, cap imminent | Emergency reclamation below | free | minutes |

B1 and B2 are config changes. **B3 is not** — if it is ever the answer, it has to
be started weeks ahead, which is the real reason the trigger sits at 50 GB rather
than 100 GB.

### B4 — emergency reclamation, in order of safety

1. **Backfilled photos.** Anything `backfill_check --deep` confirms is in the
   bucket can be deleted locally. This is the big one and the only one that
   scales.
2. **Orphaned bucket-era uploads.** An object can be presigned and PUT and then
   never attached to a submission (the observer abandons the flow, or the submit
   fails after the upload). **Nothing currently reclaims these** — see the gap
   below. They occupy bucket space, not host disk, so they do not help here.
3. **Logs and rotated backups.** Check `logs/` and any `*.db.bak`.
4. **Never delete** a photo referenced by `submissions.image_sha256` or
   `venue_image_sha256` unless it is verified present in the bucket. The
   observer's signature covers the content hash; a verifier fetches the file and
   re-hashes it, and a missing file is an unverifiable report.

## Known gap

**Orphaned objects are never reclaimed.** The presign endpoint will hand out a
URL, the phone will PUT to it, and if the submission never completes the object
stays in the bucket forever, referenced by nothing. Bounded per observer by the
30/min presign limit and the 8 MB signed length, so it is a cost leak rather
than a safety problem — but it should have a sweeper before direct mode carries
real volume: list objects, subtract every hash the `submissions` table
references, delete what is older than a day and matches nothing.

Not built. It needs bucket LIST permission, which the app's Object Read & Write
token deliberately does not have — so it belongs in a separate maintenance
credential, not in `.env`.

## Why the trigger is 50 GB and not higher

- 50 GB ≈ 100,000 observers of photos, against a ceiling near 245,000 from here.
- Being early costs about **$3/month**. Being late costs the site on election day.
- Disk never resets. Bandwidth is monthly; this is not.
- If the answer ever turns out to be B3, days of lead time are needed and 42% of
  the cap is where there is still room to take them.
