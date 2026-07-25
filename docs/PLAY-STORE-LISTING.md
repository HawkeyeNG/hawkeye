# Hawkeye — Google Play store-listing package

Ready-to-paste answers for every Play Console setup task. Fill the app record
the moment account verification clears. Package name: `ng.com.hawkeye.observer`.
Privacy policy URL: `https://hawkeye.com.ng/privacy.html`.

---

## 1. App details (Create app dialog)

- **App name (≤30):** `Hawkeye Election Monitor`  (24 chars)
- **Default language:** English (United Kingdom) — en-GB
- **App or game:** App
- **Free or paid:** Free
- **Declarations:** tick the Developer Program Policies + US export laws boxes.

---

## 2. Main store listing

**App name:** `Hawkeye Election Monitor`

**Short description (≤80):**
`Citizen-led election monitoring — report results & incidents to a public ledger.`
(79 chars)

**Full description (≤4000):**
```
Hawkeye is an independent, citizen-run election transparency tool. It is not
affiliated with INEC or any political party — official results always remain
INEC's. Hawkeye simply lets ordinary observers record what they see at their
own polling unit and publish it to a public, tamper-evident record that anyone
can check.

WHAT YOU CAN DO
• Report a polling-unit result — photograph the result sheet and enter the
  counts. On-device scanning flattens the sheet and reads the numbers to help
  you fill them in quickly.
• Report an incident — violence, ballot snatching, vote-buying, voter
  intimidation, BVAS failures and more, with an optional photo or short video.
  A human reviews every incident before it is published.
• Follow a live, national leaderboard aggregated from citizen reports.
• Verify the public ledger — every published record is anchored to an
  independent transparency log, so entries cannot be quietly altered after the
  fact.
• Practise first — a built-in mock election lets you learn the flow before you
  report anything real.

HOW IT STAYS HONEST
• Every result is tied to the polling unit and, where you allow it, a GPS fix,
  so reports can be cross-checked for location plausibility.
• Published records are cryptographically anchored — the ledger is auditable by
  anyone, not just by us.
• Disputed results are excluded from tallies and can be resolved openly in a
  public docket.

WHO IT'S FOR
Accredited observers, party agents, journalists and everyday citizens who want
an independent, verifiable picture of an election alongside the official one.

Your safety comes first — never put yourself at risk to capture evidence.

Hawkeye is a non-partisan transparency initiative. It does not tell you how to
vote and does not favour any candidate or party.
```

**App icon:** 512×512 PNG — Hawkeye crest (source: `mobile/assets/icon-only.png`,
upscale to 512 if needed).
**Feature graphic:** 1024×500 PNG (to design — crest + wordmark on green #00331e).
**Phone screenshots:** 2–8, min 320px, 16:9 or 9:16 — see §6 (to capture).

---

## 3. Store settings

- **App category:** News & Magazines  (alt: Tools)
- **Tags:** election, news, civic, government (pick from Play's tag list)
- **Contact email:** osas@inixien.com  (or security@hawkeye.com.ng)
- **Contact website:** https://hawkeye.com.ng
- **Contact phone:** (your number — optional but recommended)
- **External marketing:** leave off unless you want Google promo emails.

---

## 4. App content declarations

### Privacy policy
`https://hawkeye.com.ng/privacy.html`

### Ads
**No**, the app does not contain ads.

### App access
Some features require sign-in (device verification via phone OTP). Provide Google
a **test path**: either the built-in **Practice Run** (no login) OR test
instructions describing OTP sign-in. Recommended: point reviewers at Practice Run
so no credentials are needed. Add an "All functionality" instruction noting that
reporting opens only on election day (reporting is date-gated).

### Content rating (IARC questionnaire)
- Category: **Reference, News, or Educational** (utility/news app).
- Violence: **References only** — incident categories name violence/ballot
  snatching; the app does not depict or glorify it. Answer "yes, references" to
  the mild-violence question; **no** to graphic/realistic violence, blood, gore.
- Sexual content: **No**. Nudity: **No**. Profanity: **No**. Drugs/alcohol/
  gambling: **No**.
- **Users interact / user-generated content: YES** — users submit reports and
  photos that can be shown publicly; there is a moderation + reporting process.
- **Shares user location: YES** (optional GPS on reports).
- **Digital purchases: No.**
- Expected outcome: PEGI 12 / ESRB Teen-ish; fine for the app's audience.

### Target audience & content
- **Target age group:** 18+ (adults). The app is aimed at observers/agents; do
  not target children.
- **Appeals to children:** No.

### Data safety — see §5.

### Government apps
If asked "is this a government app?" — **No.** It is an independent civic tool.
Do not imply official/government status anywhere.

### News app
You *may* declare it a **News app**. If you do, be ready to state the publisher
(IniXien / Hawkeye) and that content is citizen-sourced + moderated.

---

## 5. Data safety form

**Does your app collect or share user data?** YES (collect). **Share** (transfer
to third parties): NO. **Processed ephemerally:** no.
**Encrypted in transit:** YES (HTTPS via Cloudflare).
**Users can request deletion:** YES — provide the deletion route described in the
privacy policy (contact email / in-app). Also declare an account-deletion URL if
required: `https://hawkeye.com.ng/privacy.html`.

Data types to declare as **Collected** (not shared):

| Data type | Collected | Required/Optional | Purpose | Notes |
|---|---|---|---|---|
| Phone number | Yes | Required | App functionality; Account management | Stored **hashed** for OTP verification |
| Precise location | Yes | Optional | App functionality | GPS fix attached to a report if user allows |
| Approximate location | Yes | Optional | App functionality | Plausibility cross-check |
| Photos and videos | Yes | Optional | App functionality | Evidence; can be shown publicly |
| Device or other IDs | Yes | Required | App functionality; Fraud prevention/security | Device id de-dupes/limits abuse |
| App activity (reports the user makes) | Yes | Optional | App functionality | The reports themselves |

Do **not** declare: name, email, address, financial info, contacts, browsing
history, health — none are collected.

Note for the reviewer/policy: photos and location a user attaches to a public
report become publicly visible by design; this is disclosed in the privacy
policy. (This is not third-party "sharing"; it is user-published content.)

---

## 6. Screenshots to capture (phone, 9:16)

Capture from the app at a phone viewport (e.g. 1080×1920). Suggested set:
1. Home / hero.
2. National leaderboard (results.html).
3. Report a result — the capture/scan screen.
4. Report an incident (incidents.html).
5. Verify the ledger (ledger.html).
6. Public docket or Practice Run.

Claude can generate these from the live site at a phone size on request.

---

## 7. Release (closed testing → production)

Personal accounts must run **closed testing with ≥12 testers for ≥14 days**
before production access unlocks. Plan:
1. Create a **Closed testing** track, add ≥12 tester emails.
2. Upload the **signed release AAB** — rebuild fresh right before upload:
   `cd mobile/android && ./gradlew bundleRelease` (reads keystore.properties;
   keystore at `~/hawkeye-secrets/hawkeye-release.keystore`). Bump `versionCode`
   first.
3. Complete all §2–§5 tasks (they gate the release too).
4. Roll the closed test, keep ≥12 testers opted-in for 14 days.
5. Apply for production.

App signing: opt into **Play App Signing** (recommended). Keep the upload
keystore backed up off-machine (loss = cannot update the app).
