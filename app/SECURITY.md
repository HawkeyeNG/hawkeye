# Security Policy

Hawkeye is election-integrity infrastructure. We take security seriously and we
would rather hear about a vulnerability from you than from an attacker.

## Reporting a vulnerability

**Email:** security@hawkeye.com.ng
Please include: a description, steps to reproduce, impact, and (if possible) a
proof of concept. Encrypt sensitive reports if you can.

- We acknowledge reports within **72 hours** and aim to give a remediation
  timeline within **7 days**.
- Please give us reasonable time to fix an issue before public disclosure
  (**coordinated disclosure** — 90 days is the default window).
- Act in good faith: don't access or modify other users' data, don't degrade the
  service for real users (no volumetric DoS testing against production), and don't
  exfiltrate data beyond what's needed to demonstrate the issue.
- We will not pursue legal action against researchers who follow this policy.

## In scope

- `hawkeye.com.ng` and its API (`/api/*`)
- The Telegram bot flows (`@HawkEyeNGBot`)
- The open-source client + cryptographic protocol in this repository

## Out of scope

- Denial-of-service / volumetric flooding against production
- Social engineering of staff or observers
- Third-party services (Cloudflare, the hosting panel, Telegram, INEC sources)
- Findings requiring a rooted/compromised victim device

## Rewards

A formal bug-bounty program with monetary rewards is being stood up. Until then,
valid reports receive public acknowledgement (with your consent) and priority
triage. High-impact reports may be rewarded retroactively when the program
launches.

See also: [`/.well-known/security.txt`](app/.well-known/security.txt) ·
[Security whitepaper](docs/SECURITY-WHITEPAPER.md)
