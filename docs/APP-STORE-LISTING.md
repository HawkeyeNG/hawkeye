# Hawkeye — App Store Connect listing package

Ready-to-paste answers for the iOS submission. Bundle ID `ng.com.hawkeye.observer`.
Where Apple asks the same question Google did, the answer is carried over from
`docs/PLAY-STORE-LISTING.md` deliberately — the two listings must not contradict
each other, because reviewers on both sides can see the same website.

---

## 1. App information

- **Name (≤30):** `Hawkeye Election Monitor`  (24)
- **Subtitle (≤30):** `Citizen election transparency`  (29)
- **Primary language:** English (U.K.)
- **Bundle ID:** `ng.com.hawkeye.observer`
- **SKU:** `hawkeye-observer`
- **Primary category:** Utilities · **Secondary:** Reference

  Not **News**. The Play IARC answer already declares this is *not* primarily a
  news product — its function is recording and verifying, not reporting — and
  claiming otherwise invites news-publisher obligations and contradicts the
  other listing.

- **Copyright:** `2026 IniXien, LLC`
- **Support URL:** `https://hawkeye.com.ng/support.html`
- **Marketing URL:** `https://hawkeye.com.ng`
- **Privacy Policy URL:** `https://hawkeye.com.ng/privacy.html`

---

## 2. Keywords (≤100 chars)

```
observer,polling,results,ballot,vote,civic,Nigeria,audit,ledger,integrity,evidence,democracy
```
(92 chars.) Words already in the name or subtitle — election, monitor,
transparency — are deliberately **omitted**: Apple indexes those fields anyway,
so repeating them wastes the budget.

**Do not add `INEC` as a keyword.** It is another organisation's name, and
bidding on it implies exactly the affiliation this listing denies — the same
mistake that got the Android app rejected twice.

---

## 3. Promotional text (≤170, editable without review)

```
An independent, citizen-run record of what happens at Nigeria's polling units. Report what you see, and publish it to a public ledger anyone can verify.
```
(152 chars.)

**EVERGREEN, AND IT HAS TO BE.** This read "Osun governorship, 15 August 2026"
— an election that was over before the listing was ever submitted, advertising a
date in the past to every reader. Promotional text is the one field Apple lets
you change without a review cycle, which makes it the right place for a
time-bound hook and the worst place to leave a stale one: nothing forces you back
to it. Keep it about what the app IS. If you do want to promote a specific
election, set a reminder to clear it the day after.

---

## 4. Description (≤4000)

```
Hawkeye is an independent, citizen-run election transparency tool. It is not affiliated with INEC or any political party — official results always remain INEC's. Hawkeye simply lets ordinary observers record what they see at their own polling unit and publish it to a public, tamper-evident record that anyone can check.

WHAT YOU CAN DO
• Report a polling-unit result — photograph the result sheet and enter the counts.
• Report an incident — violence, ballot snatching, vote-buying, voter intimidation, BVAS failures and more, with an optional photo or short video. A human reviews every incident before it is published.
• Follow a live leaderboard aggregated from citizen reports.
• Verify the public ledger — every published record is anchored to an independent transparency log, so entries cannot be quietly altered after the fact.
• Practise first — a built-in mock election lets you learn the flow before you report anything real.

HOW IT STAYS HONEST
• Every result is tied to the polling unit and, where you allow it, a GPS fix, so reports can be cross-checked for location plausibility.
• Published records are cryptographically anchored — the ledger is auditable by anyone, not just by us.
• Disputed results are excluded from tallies and can be resolved openly in a public docket.

WHO IT'S FOR
Accredited observers, party agents, journalists and everyday citizens who want an independent, verifiable picture of an election alongside the official one.

Your safety comes first — never put yourself at risk to capture evidence.

Hawkeye is a non-partisan transparency initiative. It does not tell you how to vote and does not favour any candidate or party.

Hawkeye is not affiliated with, endorsed by, or acting on behalf of the Independent National Electoral Commission (INEC), any government agency, or any political party. Hawkeye does not represent a government entity and does not declare election results. All figures in the app are unofficial, crowd-reported observations.

Official sources: INEC — https://www.inecnigeria.org · INEC Election Results Portal — https://www.inecelectionresults.ng
```

The on-device scanning sentence from the Play description is dropped here on
purpose: `@capacitor-mlkit/document-scanner` is Android-only, so on iPhone the
sheet capture falls back to the plain camera. Describing auto-flattening in an
iOS listing would be claiming a feature the binary does not have.

---

## 5. Age rating questionnaire

Apple replaced the old band-based questionnaire; the console now asks a list of
named fields and COMPUTES the band from them. Both of this repo's docs still
quoted the retired system and disagreed with each other — one said 12+, the
other said "17+ is the safe answer". Neither is an answer you can enter any
more. Below are the actual field names, read from
`GET /v1/appInfos/{id}/ageRatingDeclaration`, with the answer for this app.

| Field | Answer | Why |
|---|---|---|
| `userGeneratedContent` | **Yes** | observers publish results and incidents |
| `messagingAndChat` | **No** | no user-to-user messaging anywhere in the app |
| `socialMedia` | **No** | no profiles, no feed, no following, no comments |
| `violenceRealistic` | **Infrequent/Mild** | incident *categories* name violence and ballot snatching, and submitted photos may show real events; nothing is depicted for its own sake and every item is human-reviewed before publication |
| `violenceRealisticProlongedGraphicOrSadistic` | **None** | |
| `violenceCartoonOrFantasy` | **None** | |
| `gunsOrOtherWeapons` | **Infrequent/Mild** | the field asks about *depictions*, not subject matter — an incident photo from a polling unit may show a weapon, and this app exists to publish exactly that kind of evidence. Answering None here while answering Infrequent to `violenceRealistic` for the same reason would be inconsistent |
| `unrestrictedWebAccess` | **No** | links open fixed official destinations; there is no in-app browser to navigate freely |
| `advertising` | **None** | no ads, no ad SDK, no Ad ID |
| `contests`, `gambling`, `gamblingSimulated`, `lootBox` | **None / No** | |
| `sexualContentOrNudity`, `sexualContentGraphicAndNudity` | **None** | |
| `horrorOrFearThemes` | **None** | this field is about content *designed* to evoke dread — a genre, an intent. Distressing real footage is already declared under `violenceRealistic`; declaring it twice inflates the rating for one thing |
| `profanityOrCrudeHumor`, `matureOrSuggestiveThemes` | **None** | |
| `alcoholTobaccoOrDrugUseOrReferences` | **None** | |
| `medicalOrTreatmentInformation`, `healthOrWellnessTopics` | **No / None** | |
| `parentalControls` | **No** | |
| `ageAssurance` | **No** | no age verification is performed |
| `kidsAgeBand` | leave empty | not a Kids Category app |
| `ageRatingOverride` | **NONE** | do not override a computed rating |

**The line these two fields sit on.** `horrorOrFearThemes` asks about INTENT —
content built to frighten — and Hawkeye never does that, so it is None.
`gunsOrOtherWeapons` and `violenceRealistic` ask about PRESENCE, and observer
media from a polling unit can carry both, so they are Infrequent/Mild. Answer by
what the field asks, not by how upsetting the subject is.

**Do not write down the resulting band.** Apple computes it from the answers
above, and that is the only number that will ever be correct — which is exactly
what went wrong when this file claimed 12+ and APP-STORE-SUBMISSION.md claimed
17+. Answer the fields honestly and accept whatever it returns; user-generated
content alone will keep it well clear of 4+.

---

## 6. App Privacy (nutrition label)

Mirrors the Play Data safety declaration. **Used to Track You: nothing.**
**Shared with third parties: nothing.** No ads, no analytics SDK, no Ad ID.

| Data | Collected | Linked to identity | Purpose |
|---|---|---|---|
| Contact Info → Phone Number | Yes | Yes | App Functionality |
| Identifiers → User ID | Yes | Yes | App Functionality |
| Identifiers → Device ID | Yes | Yes | App Functionality |
| Location → Precise Location | Yes (optional) | Yes | App Functionality |
| User Content → Photos or Videos | Yes | Yes | App Functionality |
| User Content → Other User Content | Yes | Yes | App Functionality |

Phone numbers are stored hashed. Account deletion route:
`https://hawkeye.com.ng/privacy.html`.

---

## 7. Guideline 1.2 — user-generated content

Apple requires all four; all four already ship, so answer plainly if asked:

1. **Filtering objectionable material** — every incident is human-reviewed before
   publication; nothing user-submitted appears unmoderated.
2. **Reporting mechanism** — "⚑ Report This Content" on published incidents and
   results (`POST /api/incidents/flags`), open to signed-out readers, with
   reasons: abusive, false, privacy, other.
3. **Blocking abusive users** — observers can be suspended from the admin
   console. Note if asked: Hawkeye has no user-to-user messaging, feed or
   comments, so there is no per-user block surface to build; abuse is handled by
   removing the contributor.
4. **Published contact information** — `info@hawkeye.com.ng`, on
   `https://hawkeye.com.ng/about.html`. **Do not remove it.**

---

## 8. App Review Information

- **Sign-in required:** Yes, for EVERYTHING. This said "browsing needs no
  account", which is false and would have been a Guideline 2.1 rejection: the
  root layout redirects every route except `/welcome` and `/sign-in` to
  `/welcome` while signed out (`native/src/app/_layout.tsx:163-168`). A reviewer
  following the old note would have got as far as the welcome screen and no
  further.
- **Demo account:** `+2348167000004` — international format, including the `+`.
  Password is the one stored in Play Console → App content → App access.
  **Re-verify it works before submitting**, exactly as on the Android side; a
  password that was never set server-side caused a rejection there.
- **Contact:** osas@inixien.com

**Notes (paste into App Review Notes):**

```
Hawkeye is an independent civic transparency tool. It is not a government app and is not affiliated with INEC or any political party; every screen that presents government-sourced information carries a visible notice saying so and linking the official INEC site.

The app requires an account throughout — there is no signed-out browsing. Please sign in first with the demo account below.

Sign in with the demo account above (phone + password — please do not use the OTP option, as codes go to a physical SIM).

Result and incident reporting is date-gated to election day. To review the full reporting flow on any date, sign in with the demo account and open More > Practice Run — a complete mock election that can be run end to end on any date, with no real report filed.

All figures shown in the app are unofficial, crowd-reported observations from citizen observers. Official results are declared by INEC and are linked from within the app.

Note: the automatic document-scanner used on Android is an Android-only library, so on iOS result-sheet capture uses the standard camera.
```

---

## 9. Screenshots

Generated by `scripts/ios_screenshots.mjs` into `app/ios-shots/`:
- **6.7"** 1290 × 2796 (iPhone 15 Pro Max)
- **6.5"** 1242 × 2688 (iPhone 11 Pro Max)

Every frame is checked to have the "Not government or INEC affiliated" bar
**inside the viewport**, not merely in the DOM.

**Use:** `01-home`, `02-how`, `03-integrity`, `07-about`, `08-faq`, `06-guide`.
**Skip `05-incidents`** — it reads "No published incidents yet" over an empty
panel before an election. `04-ledger` is usable only after the "Invalid Date"
fix is deployed and it is re-shot.
