# Hawkeye Security Whitepaper

*Independent Election Results Monitor · hawkeye.com.ng · v1, July 2026*

> This document describes Hawkeye's security architecture at the design level.
> It contains no source code. Every guarantee below is stated so a third party
> can **verify it independently** — which is the whole point of the system.

---

## 1. Security philosophy: don't trust us, verify

Most systems ask users to *trust the operator*. Hawkeye is built on the opposite
premise: **the operator must not be a trusted party.** An election-integrity tool
whose own database could quietly rewrite results would be worthless. So Hawkeye is
engineered so that neither an attacker, nor a compromised server, nor **the Hawkeye
team itself** can alter a submitted result without the alteration being publicly,
cryptographically detectable.

Everything in this paper follows from that one commitment.

---

## 2. Threat model

**Assets we protect:** the integrity and provenance of each polling-unit result;
the anonymity of observers; the availability of the service on election day.

**Adversaries we design against:**

| Adversary | Capability | Goal |
|---|---|---|
| Ballot manipulator | Files false or altered results | Shift the apparent tally |
| Sybil operator | Creates many identities/devices | Overwhelm corroboration with fakes |
| Malicious insider / compromised server | Full DB + server access | Rewrite or delete past results |
| Network attacker | Intercepts/floods traffic | Forge, replay, or deny service |
| Deanonymizer | Reads stored data | Link a report to a real person (retaliation) |
| Web attacker | XSS/CSRF/injection/upload | Hijack sessions, run code, exfiltrate |

**Explicitly out of scope:** Hawkeye cannot detect fraud that *no observer
witnesses* — it makes what **was** witnessed impossible to quietly erase. It is a
transparency layer over the human process, not a replacement for it.

---

## 3. The integrity core (tamper-evidence)

### 3.1 Hash-chain ledger
Every accepted report is appended to an append-only ledger where each entry's
hash cryptographically commits to the hash of the entry before it. Changing or
deleting any past report changes its hash, which breaks every subsequent hash —
visibly, for anyone who checks.

- **Independently verifiable:** the public "Verify the Ledger" page recomputes the
  entire chain **in the visitor's own browser**. No server cooperation required —
  a verifier who distrusts us entirely still gets a definitive yes/no.
- **Rollback-resistant (external anchoring):** ledger heads are periodically
  signed and published to the **public Sigstore Rekor transparency log** — an
  append-only Merkle log operated by a third party that Hawkeye does not control.
  A full database restore to an earlier state cannot reproduce a Rekor entry that
  already exists at a fixed log index and integrated time, so even total server
  compromise cannot silently "un-happen" recorded results. Anyone can list the
  anchors (`/api/anchors`) and confirm each against Rekor without our cooperation.

### 3.2 Reports are signed on the observer's own device
Each observer's phone generates a cryptographic key pair (ECDSA P-256) whose
private key **never leaves the device**. Every report is signed locally before
submission. Consequences:

- A server-side attacker **cannot forge a report** on an observer's behalf — the
  key isn't on the server.
- The signature is stored in the ledger, so anyone can verify each report was
  signed by the device that claimed it.

### 3.3 Evidence is content-addressed
Each report carries two live in-app photos (result sheet + venue) with GPS and
timestamp. The image's cryptographic hash is committed to the ledger, so a swapped
photo is as detectable as an edited number.

### 3.4 Corroboration before trust
A single report proves little. A count is marked *trusted* only when multiple
**independent** observers at the same unit submit matching numbers. Combined with
one-identity-per-phone and per-device controls (§4), faking a unit requires
recruiting several distinct real people at the same physical location — under the
eyes of everyone else present.

### 3.5 Automated integrity screening
Every result is run through public statistical tripwires — over-voting vs
registered voters, impossible turnout, conflicting counts, collation-vs-unit
mismatches, form-serial and Benford-style outliers — logged openly within minutes,
not buried in a tribunal exhibit months later.

---

## 4. Identity, anonymity & anti-Sybil

- **One phone = one observer.** Phone numbers are stored **only as a salted
  one-way HMAC** — never in readable form. Reports are tied to an anonymous
  observer ID, never to a name or number.
- **Device binding.** A device fingerprint plus the device-held key prevent one
  phone from filing multiple reports for the same race; sessions are short-lived
  and bound to their device, so a leaked token can't be replayed elsewhere.
- **Self-serve deletion with a permanent tombstone.** A user can delete their
  identity; the one-way phone hash is retained as a tombstone so deletion can
  never be used to mint a second identity and double-report.
- **Roadmap — NIN 1-to-1:** national-ID verification will move anti-Sybil from
  "hard" to "cryptographically 1-to-1," the highest-leverage integrity upgrade.

---

## 5. Application & infrastructure hardening

| Vector | Mitigation |
|---|---|
| SQL injection | 100% parameterized queries; no string-built SQL |
| XSS (stored/reflected) | Strict CSP; all user-supplied text HTML-escaped; evidence served under a sandbox CSP + `nosniff` so a polyglot upload can't execute |
| Malicious uploads | Type sniffed from bytes (not client claim); images re-encoded (strips EXIF/GPS + payloads); videos re-muxed to clean MP4; size/count capped |
| Session/token theft | Short-lived, **device-bound** JWTs; token in header (not cookie) → CSRF N/A; deletion/rotation invalidates |
| Credential exposure | Secrets only from environment, never in code; phones HMAC-only; TLS/HSTS everywhere |
| DoS / resource exhaustion | Per-endpoint rate limits + a concurrency guard on CPU-heavy paths; Cloudflare WAF/rate-limiting at the edge |
| Direct-origin attacks | **Origin lock** — only traffic bearing a secret header injected by our Cloudflare edge reaches the origin; direct-IP scans get 403 |
| Info leakage | Global error handler returns generic errors; no stack traces to clients |
| Admin abuse | Timing-safe secret comparison, alert on failed attempts, rate-limited, IP-gateable |

Full detail is maintained in an internal remediation log and is available to
auditors under NDA.

---

## 6. How we *prove* this to a skeptic (verification, not assertion)

Security you can't check is marketing. Hawkeye's is checkable:

1. **Verify the ledger yourself** — recompute the whole chain in your browser at
   `hawkeye.com.ng/ledger.html`.
2. **Check the external anchors** — `hawkeye.com.ng/api/anchors` lists every
   published ledger head with its Sigstore Rekor URL; fetch the Rekor entry
   yourself and confirm it was logged at that time in a log we don't operate. A
   rolled-back DB won't match.
3. **Read the independent audit** — a third-party penetration test / security
   audit report (in progress) is shareable even though the backend source is not.
4. **Break it for a bounty** — a coordinated vulnerability-disclosure program
   (`/.well-known/security.txt`, `SECURITY.md`) invites and rewards attacks.
5. **Read the open client** — the trust-critical signing/verification code is
   client-side and open source (MIT, github.com/HawkeyeNG/hawkeye); the parts that
   matter for trust are the parts you can already inspect.

> **The claim we stand on:** *every security property in this paper is one you, or
> an attacker, can verify without our permission.*

---

## 7. Governance, privacy & compliance

- Aligned with the **Nigeria Data Protection Act** (data-minimization,
  right-to-deletion; ledger entries are anonymous and permanent by design).
- Target conformance to **OWASP ASVS**; OWASP-managed WAF ruleset at the edge.
- No advertising, no third-party trackers, no cookies.
- Documented incident-response and election-day break-glass procedures.
- Independent, non-partisan; Hawkeye never declares results — INEC does. Hawkeye
  produces evidence.

---

*Contact: security@hawkeye.com.ng · Coordinated disclosure:
https://hawkeye.com.ng/.well-known/security.txt*
