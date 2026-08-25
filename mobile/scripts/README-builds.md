# Building Hawkeye Lite

**Use `mobile/scripts/build_aab_lite.sh`. It produces BOTH artifacts:**

- `~/Downloads/hawkeye-lite-release.aab` — what Play gets
- `~/Downloads/hawkeye-lite-release.apk` — installable, for testing on a phone

It runs `bundleRelease assembleRelease`, so there is no separate "just the APK"
build to keep in step.

## Do NOT use `tmp/build_cap_release.sh`

It is an older Capacitor APK script that lives in a **gitignored** directory,
and it strips only `vendor/tesseract` and `opencv.js`.

`npx cap sync` copies **everything under `app/`** into the bundle, and `app/`
contains `download/` — the public APK download page's payload. On 2026-08-25
that was six ~30 MB builds, so the script produced a **173 MB "Lite"**: an app
whose whole purpose is being small enough for a cheap phone on metered data,
carrying six copies of a different app.

`build_aab_lite.sh` strips `download/` (along with the geo layers, the store
screenshots and the unused fonts) and then GATES the result:

- every emblem the manifest names still exists after the strip
- `styles.css` does not reference a font the strip deleted
- `results.html` and `race.js` still route geo through `window.fetchData`, or
  the stripped layers would never load
- the estimated per-device download stays under 10 MB
- `versionCode` is above the floor, so a build cannot collide with one already
  in Play review

None of those gates exist in the tmp script, which is the real argument: the
size was only the symptom that made it obvious.

## Native (Expo/RN) is a different app

`native/scripts/build_dev_apk.sh` — `ng.com.hawkeye.observer.dev`, a dev client
that loads JS from Metro. Unrelated to Lite beyond sharing a backend.
