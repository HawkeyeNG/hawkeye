# Hawkeye — Security Audit / Penetration Test Scope (RFP)

*Draft brief to send to prospective auditors. The resulting report is a shareable
investor/data-room artifact; source access is provided under NDA.*

## About the system
Hawkeye is a crowd-sourced, tamper-evident election-results monitor for Nigeria:
a PWA (vanilla JS) + Node/Express/SQLite backend, fronted by Cloudflare, with a
hash-chain ledger, device-held ECDSA signing keys, and a Telegram Mini App /
command bot. See the Security Whitepaper for the architecture.

## Objectives
1. Independently validate the **tamper-evidence** claim: can any party (including
   an insider with DB access) alter or delete a recorded result without the
   change being detectable via the public ledger and external anchors?
2. Assess the **anti-Sybil / anti-ballot-stuffing** controls and identify bypasses.
3. Standard **web application penetration test** against OWASP ASVS L2.
4. Review the **cryptographic protocol** (device key generation, signing, canonical
   payloads, ledger construction, anchoring — including the per-race Merkle batching
   and inclusion-proof verification) for design and implementation flaws.
5. Assess **observer anonymity** — can a report be linked to a real identity?

## Scope
- `hawkeye.com.ng` web app + `/api/*` (authenticated & unauthenticated)
- Telegram bot flows (`@HawkEyeNGBot`, test bot)
- Media upload pipeline, admin console, origin-lock + edge configuration (review)
- Source review under NDA (backend is closed; client is open source)

## Out of scope
- Volumetric DoS against production (rate-limit *logic* review only)
- Third-party infra internals (Cloudflare, hosting panel, Telegram, INEC)

## Deliverables
- Findings report (severity-ranked, with reproduction + remediation)
- An **executive summary suitable for public/investor sharing** (no secrets)
- Retest of fixed criticals/highs

## Suggested firms
Trail of Bits, Cure53, NCC Group, Doyensec, or a reputable regional firm with
election-tech / cryptography experience. Prioritize crypto-protocol competence.

## Timeline / budget
Target: pre–2027-campaign hardening window. Budget: line-item this prominently in
the fundraising ask (see pitch deck, "use of funds").
