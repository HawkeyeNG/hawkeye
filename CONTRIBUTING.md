# Contributing to Hawkeye

Thanks for helping. Hawkeye is a free, open-source, non-partisan tool: people standing
at a Nigerian polling unit photograph the announced result sheet, sign their report on
their own phone, and add it to a public, hash-chained record that anyone can check.
Read [GOVERNANCE.md](GOVERNANCE.md) first — it says who reviews what, and the one rule
that overrides every other: **no change may favour or disadvantage any candidate, party
or region.** Contributions are judged on whether they make the record more accurate,
more verifiable, or easier to use for an observer on a cheap phone and a weak network.

## What is here, and what is not

| Path | Stack | How to run it |
|-|-|-|
| `app/` | Website + observer web app. Vanilla JS, no build step | `python3 -m http.server 4173 --directory app`, then open http://127.0.0.1:4173 |
| `native/` | Hawkeye app, React Native / Expo | `cd native && npm install && npx expo start` (`npm run lint`, `npx tsc --noEmit`) |
| `mobile/` | Hawkeye Lite — Capacitor around `app/` | See [mobile/README.md](mobile/README.md) |
| `tests/` | Node tests (`tests/*_test.mjs`) and Playwright UI checks (`tests/ui/`) | `bash tests/run_all.sh`; `cd tests/ui && npx playwright test` |
| `shared/` | The design spec all three apps are checked against | — |

The server is **not** in this repository (see "What is private, and why" in the
[README](README.md)). You do not need it: the web app runs against the live public API
for reading, and anything that needs a backend says so in its test. The independent
verifier is public too: **[hawkeye-verify](https://github.com/hawkeye-ng/hawkeye-verify)**.

## Making a change

1. Open an issue (or comment on one) before large work, so we can agree the shape.
2. Branch from `main`; keep a pull request to one purpose.
3. Run the tests for what you touched. A UI change on `app/` should pass
   `tests/ui` — if a screenshot baseline changes on purpose, say so in the PR.
4. **Every user-visible string is translated.** Web strings live in `app/i18n/*.json`,
   app strings in `native/src/lib/i18n/*.json` — English, Hausa, Igbo and Yoruba. Add
   the key to all four; if you cannot write one of the languages, add the English and
   say so in the PR so a reviewer can supply it. Error messages count.
5. In `app/`, a changed script or stylesheet needs its `?v=` pin bumped on every page
   that loads it, and the service-worker `CACHE` name bumped (`app/sw.js`). The UI
   checks enforce the pins.

## Good first contributions

Issues labelled **good first issue** are small and self-contained. Translation review
(Hausa, Igbo, Yoruba) is always welcome and needs no code.

## Talking to us

Questions and ideas: [GitHub Discussions](https://github.com/HawkeyeNG/hawkeye/discussions).
Bugs and planned work: GitHub issues. For private matters, email
osaretin@hawkeye.com.ng. Security reports go through [SECURITY.md](SECURITY.md), never
a public issue.

## Google Summer of Code

