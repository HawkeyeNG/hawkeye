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

index, observe, incidents, collation, profile, and the shell chrome menu.js
builds at runtime (tab bar, report sheet). The other 35 pages have no keys yet,
and the five-card first-run tour in menu.js is still English-only.

## What must never be machine-translated

The INEC disclaimer, the non-affiliation notice, privacy, terms, consent
wording, and any "unverified" label. `_meta.englishOnly` in `en.json` is the
list. Those keys are deliberately absent from every bundle, and the English
still in the markup is what renders — which only works because `t(key, english)`
distinguishes a `null` fallback from an `undefined` one. It did not, once, and
printed `index.not-affiliated-with-inec-or-any` where the disclaimer belongs.

## Review state lives in the bundle

`_meta.review` is `machine-draft` | `provisional` | `human`, and the picker
fetches it rather than hardcoding a table, so a reviewer's sign-off reaches the
badge by editing one word in one file. See `app/i18n/GLOSSARY.md` for who has
reviewed what.
