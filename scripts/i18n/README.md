# Translating the web app

`i18n_extract.mjs` adds `data-i18n` keys to app HTML and writes
`catalogue.json`; `i18n_check.mjs --build-en` turns that into
`app/i18n/en.json` and then checks every other bundle against it.

```
node scripts/i18n/i18n_extract.mjs --write observe.html incidents.html ...
node scripts/i18n/i18n_check.mjs --build-en --control
node scripts/i18n/i18n_control.mjs      # proves the extractor's safety net can fail
```

**These live in `scripts/`, not `tmp/`, on purpose** — `tmp/` is gitignored, and
tooling put there has evaporated before.

## The safety net

The extractor may only ADD attributes. It strips every `data-i18n` from its own
output and asserts byte-identity with the original, and separately asserts the
attribute count grew by exactly the number it inserted — so a transform that
moved, dropped or re-encoded one byte fails both ways. `i18n_control.mjs` plants
three different corruptions and requires all three to be caught. Run it whenever
the extractor changes: a safety net nobody has watched fail is not a safety net.

It also leaves alone any element whose id or class appears in a **selector** in
the page's scripts, because `apply()` writes `textContent` on every language
change and would revert a fetched value to its English placeholder. Matching
bare words rather than selectors was too blunt — `class="btn"` made the whole
report flow "dynamic" and skipped *Take photo*, *Request OTP* and *Sign &
submit report*.

## What is covered

**All 40 pages**, plus the shell chrome menu.js builds at runtime (tab bar,
report sheet). 631 English keys; 588 in each of ha / ig / yo. Still English-only:
the five-card first-run tour in menu.js, and everything the backend sends
(SMS/OTP/Telegram/push).

Roughly a third of the surface is the shared header, menu and footer, which is
why the extractor keys a string seen on two or more pages as `common.*` and
translates it once. It also reuses keys already present in the markup, so a
second pass over a page set that is partly done does not re-key its chrome.

## What must never be machine-translated

Two kinds, both listed in `en.json`'s `_meta`:

- `englishOnly` — the INEC disclaimer (three wordings) and the non-affiliation
  notice.
- `englishOnlyPages` — **`privacy` and `terms` in their entirety.** Every
  sentence of those two documents is legal text, and they are where a
  mistranslation is most expensive. Their header, menu and footer still
  translate, because those strings are `common.*` and live on twenty other
  pages, so the page reads in the chosen language and the policy does not.

Those keys are deliberately absent from every bundle, and the English still in
the markup is what renders — which only works because `t(key, english)`
distinguishes a `null` fallback from an `undefined` one. It did not, once, and
printed `index.not-affiliated-with-inec-or-any` where the disclaimer belongs.

Also never translated, and allowlisted in the checker as legitimately identical:
handles, URLs, `x-admin-secret`, and third-party field names like `App ID` —
which is what the admin is copying out of Facebook's own console.

## Review state lives in the bundle

`_meta.review` is `machine-draft` | `provisional` | `human`, and the picker
fetches it rather than hardcoding a table, so a reviewer's sign-off reaches the
badge by editing one word in one file. See `app/i18n/GLOSSARY.md` for who has
reviewed what.
