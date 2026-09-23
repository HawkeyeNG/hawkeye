# Governance

Hawkeye is a public record of Nigerian election results, filed by observers and
checkable by anyone. This document says who decides what, and how someone
outside the project can rely on that.

## Maintainers

| Role | Who | Contact |
|---|---|---|
| Lead maintainer | Osaretin Jerry Osagie ([@HawkeyeNG](https://github.com/HawkeyeNG)) | osaretin@hawkeye.com.ng |
| Security lead | Osaretin Jerry Osagie | security@hawkeye.com.ng |

**There is currently one maintainer, and pretending otherwise would be the
wrong thing to write here.** It is the project's main structural risk: a single
person is a single point of failure for review, for release signing and for
responding to a disclosure. The mitigations below are what exist today, not
aspirations.

## What is open, and what is not

- **Open** — the apps, the website, the verification path, and
  [`hawkeye-verify`](https://github.com/hawkeye-ng/hawkeye-verify), the library
  that independently checks a published report's signature and ledger position.
  Anyone can confirm a result was not altered after filing without trusting us.
- **Closed** — the backend's fraud-detection rules. Publishing the exact
  thresholds that flag a suspicious report tells anyone wanting to file one
  how to stay under them. Nothing in the trust path depends on that code being
  secret: a report's integrity is verifiable from the open library alone.

## Decisions

Changes land by pull request against `main`. The lead maintainer reviews and
merges. Where a change alters what observers see or what the ledger records,
the reasoning goes in the commit message rather than a separate document — the
repository's history is the decision log.

Three classes of change carry a higher bar and are never made close to an
election without a stated reason:

1. **The ledger format or signing scheme.** Breaking verification of existing
   reports would break the project's central claim.
2. **What is published.** Result sheets are public; the surroundings photograph
   and an observer's identity are not.
3. **Anything that changes a published figure.** Corrections are appended, never
   overwritten.

## Releases

Android and iOS builds are produced by GitHub Actions from `main`, signed with
keys held outside the repository, and go to internal testing or TestFlight
before any store review. Web deploys are per-file with a verification step. No
release is cut from a working copy.

## Reporting a vulnerability

See [SECURITY.md](SECURITY.md). Private vulnerability reporting is enabled on
this repository; that or security@hawkeye.com.ng are both fine. Please do not
open a public issue for a security problem.

We will acknowledge a report within 72 hours. Because the project has one
maintainer, a fix may take longer than that, and we would rather say so than
publish a response time we cannot meet during an election period.

## Contributing

Issues and pull requests are welcome. The project is non-partisan and does not
accept changes whose purpose is to favour or disadvantage any candidate, party
or region; contributions are judged on whether they make the record more
accurate, more verifiable or more usable to an observer standing at a polling
unit.
