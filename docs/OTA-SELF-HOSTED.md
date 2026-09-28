# Self-hosted native OTA updates (design D9)

Native JS updates are served from our own Expo Updates server on Cloudflare R2
instead of EAS Update, which bills per device updated in a month (worst case
about $2,449 at 1M observers and $5,200 at 5M for one emergency push in
January). Source: `docs/private/CHEAPEST-ELECTION-NIGHT.html`, D9.

**Status (28 Sep 2026): built and tested locally, not deployed.** The switch
happens with native **1.0.9** (store build due by **20 Nov**). Builds 1.0.8 and
earlier keep reading EAS, because `updates.url` is compiled into the binary.

## Design

```
phone (1.0.9+) --GET https://updates.hawkeye.com.ng/manifest----------> Worker (scripts/ota_worker)
   headers: expo-platform, expo-runtime-version,                         reads R2 manifests/<channel>/<runtime>/<platform>
   expo-channel-name, expo-protocol-version: 1,                          adds expo-protocol-version, expo-sfv-version,
   expo-expect-signature                                                 cache-control: private, max-age=0
phone --GET https://updates.hawkeye.com.ng/assets/<sha256>.<ext>----> R2 bucket hawkeye-updates (public custom domain)
```

**Why static R2 is not enough, and why a Worker is.** Every response body is
static and signed ahead of time: the protocol has no nonce and nothing per
request. Two things are not static:

1. **Selection.** Every build asks one URL. It says which update it can run
   only in request headers (`expo-platform`, `expo-runtime-version`,
   `expo-channel-name`). R2 cannot route on headers. A Cloudflare URL-rewrite
   rule can match a header, but it cannot build a path from a header's value.
   So a new runtime would need new dashboard rules.
2. **Protocol headers.** expo-updates 57 refuses a response without
   `expo-protocol-version` ("Legacy manifests are no longer supported";
   android `UpdateFactory.kt`). R2 cannot set arbitrary response headers.

So the Worker (`scripts/ota_worker/worker.js`, about 100 lines) only maps the
headers to an R2 key and adds the protocol headers. It holds no key and signs
nothing. If it were compromised, it could withhold an update or replay an older
signed one. It could not forge one. It keeps each manifest at the edge for 60 s,
so R2 reads stay near zero while every device checks on launch. Assets are
immutable and content-addressed, and devices fetch them straight from the
bucket's custom domain, without the Worker.

**Response format.** `multipart/mixed` with a `manifest` part (or a `directive`
part) and an `extensions` part. It is the only form that carries the signature
inside the body (`expo-signature` part header) and supports directives.

**Code signing.** The keys are RSA-2048 with `rsa-v1_5-sha256` and keyid `main`.
The certificate is self-signed for code signing, `CN=Hawkeye OTA updates`, valid
28 Sep 2026 to 28 Sep 2036. It was generated with
`npx expo-updates codesigning:generate`.

- Certificate: `native/certs/expo-updates-certificate.crt`, committed. It uses
  `.crt` because `native/.gitignore` ignores `*.pem`. A `.pem` would silently
  stay out of git and break the CI prebuild.
- Private key: `~/hawkeye-secrets/expo-updates/private-key.pem` (mode 600,
  outside the repo, next to a backup copy of the certificate). It goes into the
  GitHub secret `EXPO_UPDATES_PRIVATE_KEY`.
- A build with `codeSigningCertificate` set **rejects every unsigned or
  wrongly signed manifest**. The publish script checks the key against the
  certificate with Expo's own `@expo/code-signing-certificates` before it signs
  anything.

**runtimeVersion.** The `appVersion` policy is unchanged. The phone sends its
`expo.version` as `expo-runtime-version`, and the key path includes it, so an
update still reaches only builds of the same version. The publish script
resolves the runtime with `expo-updates runtimeversion:resolve`, the resolver
prebuild uses. It refuses a mismatch with the config's version, and it refuses
any runtime below 1.0.9.

**R2 layout** (bucket `hawkeye-updates`):

| Key | What | Cache-Control |
|---|---|---|
| `assets/<sha256-hex>.<ext>` | bundles (`.hbc`) and images/fonts; immutable | `public, max-age=31536000, immutable` |
| `updates/<channel>/<runtime>/<platform>/<id>/manifest.json` | archive: the signed manifest (for republish) | `public, max-age=60` |
| `updates/<channel>/<runtime>/<platform>/<id>/response` | archive: the full signed response | `public, max-age=60` |
| `manifests/<channel>/<runtime>/<platform>` | **the pointer**: what phones get now. No object means 204, "no update" | `no-store` |

Asset `key` is the file's MD5, which is also Metro's packager hash. The phone
therefore recognises fonts and images already embedded in its store build and
downloads only what changed, usually just the bundle. This matters for
observers on mobile data.

## Files

| File | Role |
|---|---|
| `native/app.json` (`updates`) | `url` = `https://updates.hawkeye.com.ng/manifest`, `codeSigningCertificate`, `codeSigningMetadata` |
| `native/certs/expo-updates-certificate.crt` | the embedded certificate |
| `scripts/ota_publish_self.sh` | publish, rollback, republish, unpublish, status, history. **Dry run by default** |
| `scripts/ota_manifest.mjs` | builds, signs and verifies protocol responses; `serve` runs worker.js locally |
| `scripts/ota_worker/worker.js`, `wrangler.toml` | the manifest dispatcher |
| `scripts/ota_test.sh` | local end-to-end test (no R2, no Cloudflare) |

## Owner steps (one time, before the 1.0.9 build)

1. **Bucket.** Cloudflare → R2 → Create bucket **`hawkeye-updates`**. It is a
   separate bucket, so its token can touch nothing else. Never use the evidence
   bucket, and not `hawkeye-tiles` either. Leave the `r2.dev` URL disabled.
2. **Custom domain.** In the bucket, open Settings → Custom Domains → Connect
   and enter **`updates.hawkeye.com.ng`**.
3. **Cache rule.** In the hawkeye.com.ng zone, open Caching → Cache Rules and
   add "OTA assets": `http.host eq "updates.hawkeye.com.ng" and
   starts_with(http.request.uri.path, "/assets/")`. Set Eligible for cache, and
   set Edge TTL to use the cache-control header. Cloudflare does not cache
   `.hbc` by default. Also check that no WAF custom rule or the zone's
   rate-limit rule matches this host: many phones share one carrier IP. Bot
   Fight Mode stays off.
4. **R2 token.** Go to R2 → Manage API tokens → **Create Account API token**
   (an account token, not a user token, because CI will use it). Set Object
   Read & Write, and under "Apply to specific buckets only" choose
   `hawkeye-updates`. Keep the Access Key ID, the Secret Access Key and the S3
   endpoint `https://<account-id>.r2.cloudflarestorage.com`.
5. **Worker.** Run `cd scripts/ota_worker && npx wrangler@4 login && npx
   wrangler@4 deploy`. It deploys `hawkeye-ota-manifest` on the route
   `updates.hawkeye.com.ng/manifest*` with the R2 binding `OTA_BUCKET` →
   `hawkeye-updates`.
   - Set the route's request-limit failure mode to **Fail open**. Past the
     Free plan's 100,000 requests a day, requests then go to the bucket,
     `/manifest` is a 404, and phones simply get no update that day.
   - Each cold start of a 1.0.9+ app is one request. When Workers → Metrics
     approaches 100,000 a day (expected December–January only), switch to
     **Workers Paid: $5 a month**, including 10M requests, then $0.30 per
     million.
   - If a Worker route on the R2 custom domain is refused, deploy the Worker as
     the hostname's **Custom Domain** instead. It then serves `/assets/*` and
     `/updates/*` from the binding too (tested). Every asset download then
     counts as a Worker request.
6. **GitHub secrets.** In repo Settings → Secrets and variables → Actions, add:
   - `EXPO_UPDATES_PRIVATE_KEY`: set it with `gh secret set
     EXPO_UPDATES_PRIVATE_KEY < ~/hawkeye-secrets/expo-updates/private-key.pem`.
     This pipes the file; never paste the key anywhere.
   - `OTA_R2_ACCESS_KEY_ID`, `OTA_R2_SECRET_ACCESS_KEY`, `OTA_R2_ENDPOINT`: the
     R2 Account API token from step 4.
   - Variable `OTA_R2_BUCKET` = `hawkeye-updates`.

   No workflow uses them yet; publishing runs from WSL with the same names
   exported.
7. **Back up the key offline** (password manager or an encrypted USB drive).
   - **Lost key or expired certificate (2036):** no OTA update reaches 1.0.9+
     until a store build ships a new certificate.
   - **Leaked key plus write access to the bucket or Worker:** someone can push
     code to every 1.0.9+ phone. Rotate by a store build with a new certificate.
8. **The switch (by 20 Nov).**
   - Bump `native/app.json` `version` to **1.0.9**, plus buildNumber and
     versionCode as usual. Do not build again as 1.0.8: that build would share
     runtime 1.0.8 with EAS builds, and the publish script refuses runtime
     1.0.8.
   - Commit `native/certs/` and the `updates` block.
   - Build through the normal workflows, to TestFlight and Play internal first.
   - Check the **artifact**, not app.json:
     - iOS: `Expo.plist` must have `EXUpdatesURL =
       https://updates.hawkeye.com.ng/manifest` and
       `EXUpdatesCodeSigningCertificate`.
     - Android: the manifest's `expo.modules.updates.EXPO_UPDATE_URL` and
       `expo.modules.updates.CODE_SIGNING_CERTIFICATE` meta-data.
9. **First real-device test** (1.0.9 on a test phone, before any store review):
   - `scripts/ota_publish_self.sh --platform android --message "OTA smoke
     test"`, then add `--apply`.
   - Relaunch twice: one launch downloads, the next applies. Confirm the change.
   - Then run `--rollback-embedded --apply` and relaunch twice. Confirm the
     phone is back on its built-in bundle.

   This is the one step the local test cannot do.

## Publishing

```bash
export OTA_R2_ENDPOINT=... OTA_R2_ACCESS_KEY_ID=... OTA_R2_SECRET_ACCESS_KEY=...   # never echoed
scripts/ota_publish_self.sh --platform all --message "fix: results table wraps"    # DRY RUN: export, sign, verify, plan
scripts/ota_publish_self.sh --platform all --message "fix: results table wraps" --apply
scripts/ota_publish_self.sh --status                                               # what phones get now, verified
scripts/ota_publish_self.sh --history --platform ios                               # every published update (ids)
```

`--apply` writes in this order: assets (existing content-addressed keys are
skipped), the archive, then **the pointer last**. A phone can never see a
manifest whose assets are not there yet. The script then polls the live URL for
up to 2 minutes (the edge copy lives 60 s) until it serves the new id with the
headers a phone sends. It checks the signature against the certificate in the
repo and every asset's SHA-256. If that fails, it exits 1 and prints the exact
command that puts the previous state back.

A phone checks on each cold start (`ON_LOAD`), downloads in the background and
applies the update on the **next** launch (`fallbackToCacheTimeout: 0`).

## Rollback

| Situation | Command (then add `--apply`) | Effect |
|---|---|---|
| Bad update, the previous one was good | `scripts/ota_publish_self.sh --republish <previous-id> --platform ios` | Re-issues it with a new id and createdAt (phones only move to NEWER updates), same assets |
| Bad update, go back to the store build | `scripts/ota_publish_self.sh --rollback-embedded --platform all` | Signed `rollBackToEmbedded` directive: phones return to the bundle inside their binary |
| Stop serving anything | `scripts/ota_publish_self.sh --unpublish --platform all` | Pointer removed, 204: phones keep what they run (does NOT undo a bad update) |
| Update crashes at launch | none needed first | expo-updates' error recovery returns a phone that crashes before the first render to the previous update; then republish or roll back so no more phones take it |

Ids come from the publish output, `--status` or `--history`. Every rollback
reaches phones within 60 s at the edge, plus two cold starts on the phone.

## If the self-hosted server breaks

- **404, 5xx, timeout, DNS failure, malformed or wrongly signed response:** the
  phone logs an error and keeps running what it has, whether the embedded
  bundle or the last good update. With `fallbackToCacheTimeout: 0` the launch
  never waits on the server. Nothing breaks; OTA delivery simply stops until
  it is fixed. The fallback is a store build.
- **Worker over the Free limit:** same as a 404 (fail open). Fix it with
  Workers Paid.
- **A signed update with bad JS:** this is the real danger, the same as on EAS.
  See Rollback.
- **Replay of an old signed update or directive:** ignored by any phone
  already running something newer.
- Manifests carry the **public** app config (`expo config --type public`), as
  EAS does. It includes no Maps key and no signing configuration; checked on
  the export.

## EAS for 1.0.8 and earlier: do not run it from this tree

After this change, `eas update` in `native/` either **rewrites app.json**
(eas-cli logs "Overwrote updates.url") or fails for lack of
`--private-key-path`. A rewritten URL would ship in the next store build and
cut it off from this server. For an EAS update to 1.0.8 builds:

```bash
git worktree add /tmp/hawkeye-1.0.8 <the 1.0.8 release commit>   # its app.json still has the EAS block
cd /tmp/hawkeye-1.0.8/native && npm ci
# cherry-pick the JS fix, then run tmp/ota_publish.sh's eas command from here (it cd's to ~/hawkeye/native)
```

After any eas-cli run, `git diff --exit-code native/app.json` must be empty.
`ota_publish_self.sh` refuses to run while `updates.url` is not the
self-hosted one.

## Testing

`scripts/ota_test.sh` does a real `expo export` of both platforms, a few
minutes. `OTA_TEST_DIST=<dir>` reuses one. It touches no R2 and no Cloudflare,
and checks the following, each with a control that must fail:

- **What prebuild embeds:** Expo's own config-plugin code (`@expo/config-plugins`
  Updates) yields the URL, the certificate, `codeSigningMetadata` and the
  channel header.
- **Dry-run publish** of both platforms. A foreign key is refused before
  signing. Runtime 1.0.8 is refused.
- **The real `worker.js`**, served on localhost over the bucket layout (the
  `serve` subcommand), answers `curl` sending the exact headers expo-updates 57
  sends:
  - The signature verifies against `native/certs` with an independent verifier
    on Node's crypto.
  - Every asset's SHA-256 matches.
  - iOS and Android get different updates.
- **Controls:** each is refused:
  - one changed byte in the manifest
  - a well-formed signature by another key
  - a missing `expo-signature`
  - a wrong id or runtime
  - one byte appended to the bundle in the bucket
  - `expo-platform: web`: 400
  - no protocol header: 406
  - a non-multipart accept: 406
  - a runtime of `../manifests`: 400
- **No-update and deployment option B:**
  - An unknown runtime or channel gets 204 with the protocol header.
  - Option B (the Worker serves every path) returns the same bytes.
- **Rollback paths:** a `rollBackToEmbedded` directive is served and verifies.
  A republish goes live as a new id with the same bundle hash. Unpublish gives
  204.
- **`--apply` against a stand-in `aws`** whose bucket is a directory:
  - upload order (assets, archive, pointer last)
  - the second publish skips all 28 assets
  - the R2 secret never appears in argv or output
  - republish, rollback and unpublish go live
  - a corrupted live pointer fails the run and prints the rollback command
