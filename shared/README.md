# shared/ — Hawkeye's single source of truth

The three frontends drift because values are copy-pasted between them
(`native/tailwind.config.js` even *claims* it is "kept in sync with
app/styles.css" — it was false in every row). This directory ends that: one
canonical spec, and a guard that fails when a codebase drifts from it.

**`native/` is the reference implementation. `app/` (web + PWA + Capacitor)
converges toward it.** They are two separate rendering pipelines — native
consumes RGB *triplets* via `rgb(var(--x))`, web consumes *hex* raw via
`var(--x)` — so they cannot share a runtime stylesheet. They share this **spec**
instead, and each is verified against it.

## Files

| File | Role |
|---|---|
| `tokens.mjs` | **Canonical.** Brand marks, semantic palette (light+dark), type, radius, and the web→canonical convergence map. The only file you edit to change a token. |
| `verify.mjs` | The guard. `node shared/verify.mjs` from the repo root. |

## The rule

1. To change a design token, edit `tokens.mjs` **and** the matching native
   definition (`native/src/global.css` for semantic triplets,
   `native/tailwind.config.js` for `hawk.*` brand) in the **same commit**.
2. `node shared/verify.mjs` **hard-fails (exit 1)** if native ever diverges
   from the spec. It **reports** the web's remaining gaps but does not fail on
   them — that list is the parity worklist and shrinks as `app/` catches up.
3. Never hand-edit two codebases into agreement. Edit the spec, then make each
   codebase match it.

## Wiring the guard into CI

There is no root `package.json`; run the script directly. Add to
`.github/workflows/ui-checks.yml` (runs on GitHub, where Node is present — the
UI Playwright job no-ops under WSL):

```yaml
  tokens:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node shared/verify.mjs
```

## Scope today

`tokens.mjs` covers the **design-token** contract (colour + type), the input to
the web restyle. The other contracts named in the parity plan — the tier
palette+vocabulary, the 1,499-seat race catalogue, gate thresholds, integrity
checks, explainer copy — get added here **just-in-time** as the phase that
consumes each one arrives, not speculatively.
