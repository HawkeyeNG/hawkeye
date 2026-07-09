# Hawkeye — Mobile App Design Architecture

*Design for native iOS + Android apps. Goal: reuse the existing web codebase and
backend, add native camera / secure-key / push, and ship to both stores without a
ground-up rewrite. Status: design only — not yet built.*

> **Rendered version:** https://claude.ai/code/artifact/68f470eb-8060-42b0-86f5-d4e7213dc12e

## 1. Guiding principle — wrap, don't rewrite

Hawkeye is already a PWA (installable today) whose trust model lives in the
**client**: WebCrypto ECDSA P-256 device keys, live `getUserMedia` capture, GPS
stamping, hash-chain signing. The backend is a stateless-ish JSON API. So the
mobile app is **another client of the same API**, not a new system.

**Recommended path: Capacitor** (capacitorjs.com) wrapping the existing `app/`
web bundle. It compiles the same HTML/JS/CSS into a real iOS (Swift shell) and
Android (Kotlin shell) app, exposes native plugins to the same JS, and produces
`.ipa` / `.aab` for the stores. ~weeks, not months; one codebase for web + both
apps.

Rejected alternatives:
- **React Native / Flutter** — full rewrite of a working UI + the crypto/capture
  pipeline. Only worth it later if the camera/OCR pipeline needs deep native perf.
- **Android TWA (Trusted Web Activity)** — cheapest Android path (wraps the PWA
  via Digital Asset Links) but iOS has no equivalent, and a pure web wrapper risks
  Apple 4.2 rejection. Fine as a *stopgap Android listing*, not the strategy.

## 2. Layers

```
┌ Native shell (Capacitor) ──────────────────────────────┐
│  iOS (WKWebView, Swift)      Android (WebView, Kotlin)  │
│  ├ Camera plugin — live capture only, no gallery        │
│  ├ Geolocation plugin — high-accuracy GPS at capture    │
│  ├ Secure key storage — iOS Keychain / Android Keystore │  ← hardware-backed
│  ├ Push — APNs (iOS) / FCM (Android)                    │
│  └ App bundle: the existing app/ PWA (HTML/JS/CSS)      │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS (same JSON API)
┌ Backend (unchanged) ─▼──────────────────────────────────┐
│  Node/Express + better-sqlite3 on GO54 (Passenger)      │
│  /api/* — register, submissions, ledger, anchors, tg    │
│  Cloudflare edge (origin lock, rate limits, WAF)        │
└──────────────────────────────────────────────────────────┘
```

## 3. What changes vs the web app

- **Signing key → hardware-backed store.** Today the ECDSA key lives in
  IndexedDB. On device, move it to iOS Keychain / Android Keystore (Secure
  Enclave / TEE where present) via a Capacitor plugin. Stronger tamper story for
  the audit and investors; same signature format, so the ledger is unchanged.
- **Camera → native.** Replace the `getUserMedia` overlay with the native camera
  plugin configured **camera-source only** (no gallery), keeping live-capture +
  GPS-stamp + expiry. Better reliability on low-end Android than WebView cameras.
- **Push → FCM/APNs** for "my polling unit" and race alerts, complementing (not
  replacing) the existing Telegram alerts. Backend adds a `device_push_tokens`
  table + a send helper; everything else reuses the existing notify path.
- **Offline queue.** Election-day networks are hostile. Native background sync +
  an on-device encrypted outbox: reports are captured, signed, and queued
  offline, then flushed when connectivity returns (idempotent on `entry_hash`).

## 4. Backend — where it lives

- **MVP / beta: stays on GO54** (current shared hosting). The API is already the
  contract; the app just calls it. No backend rewrite to launch.
- **Election-day scale is the real constraint, not the app.** GO54 shared hosting
  + SQLite + local image storage will not absorb a national spike (hundreds of
  thousands of photo submissions in hours). Funded scale path (roadmap):
  - Images → S3-compatible object storage (not the app server's disk).
  - App tier → a horizontally scalable host (VPS/managed container) behind
    Cloudflare; keep Cloudflare for edge/rate-limit/anti-DDoS.
  - DB → Postgres (SQLite is single-writer; fine for beta, not for peak).
  - The ledger + Rekor anchoring are storage-agnostic and port unchanged.
- This is a *scale* migration, decoupled from the mobile build — the app ships
  against GO54 first and points at the scaled backend later by base-URL swap.
- **On-prem option (intended: NVIDIA DGX Spark + Starlink):** a self-owned DGX
  Spark appliance (128 GB unified memory) hosts the full stack **and** the local
  text + EC8A-vision models on one box, on Starlink via Cloudflare Tunnel — hot
  backup now, potential primary at scale; off-grid-capable, can't be deplatformed.
  Setup + costs: [Self-Hosted AI](SELF-HOSTED-AI.md).

## 5. App Store (Apple) implications

- **Apple Developer Program** — $99/yr; a legal entity strengthens an
  elections/civic listing.
- **Guideline 4.2 (minimum functionality)** — a thin website wrapper is rejected;
  Hawkeye passes because it uses **native camera, Keychain-backed signing, GPS,
  and push** — genuine device functionality.
- **Elections/political scrutiny** — allowed for legitimate, **non-partisan**
  civic tools; framing must stay factual ("evidence, not results; INEC declares
  winners"). Expect extra review time.
- **Privacy** — nutrition labels + `NSCameraUsageDescription`,
  `NSLocationWhenInUseUsageDescription` (only "when in use"; no background
  location). Disclose phone-hash + location collection. **Account deletion is
  mandatory** — already have self-serve "Delete my ID".
- Privacy-policy URL required — already live (`/privacy.html`).

## 6. Play Store (Google) implications

- **Google Play Developer** — $25 one-time.
- **Data safety form** — declare phone-hash, location, photos; encryption in
  transit; deletion path (have it).
- **Sensitive permissions** — camera + fine location justified by capture; **no
  background location** (avoids the hardest review). Target the required API
  level; foreground-only.
- **Elections policy** — Play permits non-partisan election tools; keep
  transparency + no misrepresentation; may require an org/verification.
- Android alt-path: a **TWA** could list fast (wraps the PWA) while the Capacitor
  build matures — but standardize on Capacitor for parity with iOS.

## 7. Build & release

- **Capacitor + GitHub Actions** to produce `.ipa` / `.aab`; **Fastlane** for
  signing + store upload. Same `app/` bundle synced via `npx cap sync`.
- Versioning tied to the PWA cache version so web + app ship together.
- Phased rollout: (1) installable PWA — **done**; (2) Capacitor Android (+ TWA
  stopgap) with native camera/keystore/push; (3) Capacitor iOS; (4) optional
  native camera/OCR module if perf demands.

## 8. What we explicitly keep

Ledger format, Rekor anchoring, per-race Merkle proofs, phone-hash identity,
JWT device binding, geofence, incident review, Telegram bot — **all unchanged**.
The mobile app is a stronger *shell* around the same verifiable core.
