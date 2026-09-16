# Hawkeye — crowd-verified election results for Nigeria

Hawkeye is a **parallel results verification** platform. Observers physically present
at a polling unit photograph the official result sheet (EC8A) as it is announced,
enter the per-party counts, and submit both from their phone. Independent matching
reports from different observers raise a public **confidence score** for that unit's
result. Every accepted submission is appended to a **tamper-evident hash chain**
whose head is published to a public transparency log, so history cannot be quietly
rewritten — not even by the people running the server.

This is a transparency layer, not a replacement for INEC — the official result
remains INEC's. It works the same way as proven parallel vote tabulation efforts
(e.g. Yiaga Africa's PRVT), but crowdsourced and evidence-backed.

Live at [hawkeye.com.ng](https://hawkeye.com.ng).

## What is in this repository

| Path | What it is |
|---|---|
| `app/` | The website and the observer web app — vanilla JS, no build step |
| `native/` | The Hawkeye app for iOS and Android (React Native / Expo) |
| `mobile/` | Hawkeye Lite, the lightweight Android and iOS app built around `app/` |
| `contracts/HawkeyeLedger.sol` | The on-chain ledger registry |
| `shared/` | The design spec the three apps are checked against |
| `tests/` | App and UI tests |
| `docs/` | The security whitepaper, the audit scope and the manual |

## What is private, and why

The server, its fraud-detection rules and our election audits live in a private
repository. Detection only works if the people it is aimed at cannot read the rules
and tune a forged report to pass just under them.

Nothing you need in order to *trust* Hawkeye depends on that code. The checks below
work without trusting our server.

## Verify it yourself

**[hawkeye-verify](https://github.com/hawkeye-ng/hawkeye-verify)** runs all of these checks in one command:

```bash
git clone https://github.com/hawkeye-ng/hawkeye-verify && node hawkeye-verify/bin/hawkeye-verify.mjs
```

It is MIT-licensed and has no dependencies. It checks Rekor's own proofs and signatures as
well, and it re-runs the checks against hawkeye.com.ng every day in public. You can also run
each check by hand:

- **The ledger.** Every accepted report is chained:
  `entry_hash = SHA-256(prev_hash + payload)`. `GET /api/ledger/verify` re-checks the
  whole chain, and [the ledger page](https://hawkeye.com.ng/ledger.html) re-verifies it
  in your browser.
- **The anchors.** Each ledger head is signed and published to the public
  [Sigstore Rekor](https://rekor.sigstore.dev) transparency log. `GET /api/anchors`
  lists them with their Rekor entries and our public key. Rolling back our database
  would contradict a Rekor entry we cannot edit.
- **One race at a time.** `GET /api/anchors/:id/races/:raceKey` returns a Merkle
  inclusion proof, so one disputed race can be checked without replaying the rest.
- **The evidence.** Result-sheet photos are public at `/uploads/<sha256>.jpg`, named
  by their own hash.

How each of these holds up against a dishonest operator is set out in
[docs/SECURITY-WHITEPAPER.md](docs/SECURITY-WHITEPAPER.md).

## Honest limitations

No app can make phone GPS impossible to fake, and no single check stops a determined
forger. Hawkeye's strength is redundancy: rigging a unit means faking a location,
capturing a fresh forged photo *and* out-numbering the honest observers there — per
polling unit, at scale, on election day.

## Security

Report vulnerabilities to **security@hawkeye.com.ng** — see [SECURITY.md](SECURITY.md).

## Licence

The code in this repository is MIT-licensed ([LICENSE](LICENSE)). The Hawkeye name
and marks are not — see [TRADEMARKS.md](TRADEMARKS.md).
