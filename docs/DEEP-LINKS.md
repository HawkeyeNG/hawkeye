# Deep links — Telegram (and anywhere else) → the Hawkeye app

A Telegram inline button can only carry `http(s)` or `tg://`, so the app's own
`hawkeye://` scheme is unusable there. Android App Links close the gap: a normal
`https://hawkeye.com.ng/open?...` URL opens the **native app** when it is
installed and falls back to the **website** when it is not — one link, no
"do you have the app?" branch anywhere in the bot.

Telegram **Mini Apps cannot be native** — they are a WebView by definition — so
the in-chat camera/signing flow stays on `app/`. This is only about the handoff.

## The link format

    https://hawkeye.com.ng/open?to=<target>[&pu=…&contest=…&votes=…]

`to` is the only required parameter. Everything else is passed through untouched,
so the existing `?pu=&contest=&votes=` handoff from `/report` keeps working.

| `to`       | native route         | web fallback      |
|------------|----------------------|-------------------|
| `report`   | `/report/result`     | `observe.html`    |
| `collation`| `/report/collation`  | `collation.html`  |
| `incident` | `/report/incident`   | `incidents.html`  |
| `mapunit`  | `/map-unit`          | `map-unit.html`   |
| `ledger`   | `/ledger`            | `ledger.html`     |
| `results`  | `/(tabs)/results`    | `results.html`    |
| `activity` | `/profile`           | `profile.html`    |
| `ask`      | `/assistant`         | `index.html`      |

Anything unknown lands on the site's home page rather than erroring.

## The three pieces

1. **`app/.well-known/assetlinks.json`** — served from the site root. Android
   fetches it and only honours the association if a fingerprint here matches the
   installed app's signing certificate.
2. **`native/app.json` → `android.intentFilters`** — declares the domain and the
   `/open` path prefix, with `autoVerify: true`.
3. **`app/open/index.html`** — the fallback the browser lands on when the app is
   not installed. Also what desktop users always get.

   It is a DIRECTORY (`/open`), not `open.html`, on purpose: the site has no
   extensionless-URL rewrite, and adding an `.htaccess` was rejected as too
   risky (the server's own may be what routes `/api` to the Node backend). A
   directory gives a real 200 at `/open` with no server config, and — the part
   that matters — `/open` is a valid Expo Router route name, whereas
   `/open.html` would not resolve to `app/open.tsx` on the native side.
   Apache 301s `/open` → `/open/`, preserving the query string.

   > A `/open.html` from the first deploy is still on the server as a working
   > alias. `/open` is canonical; don't add new links to the alias.

Scoped to `/open` on purpose: verifying the bare domain would make *every*
hawkeye.com.ng link — every share, every search result — try to open the app.

## The fingerprints, and why there are three

`assetlinks.json` carries:

- `DE:AC:3A:94:…:D2:62` — the **Play app signing** certificate. Google re-signs
  every AAB with its own key, so this is the fingerprint a Play-Store install
  actually presents, and the only one that makes App Links work in production.
- `8E:6F:AF:F5:…:56:3F` — the **upload** certificate
  (`hawkeye-secrets/hawkeye-release.keystore`). Covers **sideloaded** release
  builds, i.e. the team APK.
- `FA:C6:17:45:…:3B:9C` — the standard Android **debug** certificate, for native
  dev builds.

All three are legitimate simultaneously; Android accepts a match against any
entry in the array.

> Where the Play one comes from, since it is not obvious: Play Console →
> **Test and release → App signing** (URL slug `/keymanagement` — the
> "App integrity" nav item now just redirects to *Protected with Play* and does
> NOT contain it). That page renders a ready-made Digital Asset Links JSON
> snippet with the value already in place.

## iOS — blocked

Universal Links need `apple-app-site-association` containing an Apple **Team ID**,
and no Apple Developer team is configured yet (`native/app.json` has no
`appleTeamId`, `eas.json` has no `ascAppId`). Once the team exists, add:

```json
{ "applinks": { "details": [
  { "appID": "<TEAMID>.ng.com.hawkeye.observer", "paths": ["/open", "/open/*"] } ] } }
```

at `app/.well-known/apple-app-site-association` (no extension, served as JSON),
plus `"associatedDomains": ["applinks:hawkeye.com.ng"]` under `ios` in app.json.

## Verifying

```bash
curl -s https://hawkeye.com.ng/.well-known/assetlinks.json | head
adb shell pm get-app-links ng.com.hawkeye.observer.dev
adb shell am start -a android.intent.action.VIEW -d "https://hawkeye.com.ng/open?to=ledger"
```

`pm get-app-links` should report `verified` for hawkeye.com.ng. Android only
re-verifies on install/update, so reinstall after changing the JSON.
