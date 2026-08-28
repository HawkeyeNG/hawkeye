# Hawkeye Lite — App Store Connect listing package

Sibling of `APP-STORE-LISTING.md` (the native app). Everything here is written
to be **visibly a different product from the same publisher**, because App Store
Guideline **4.3 (spam / duplicate apps)** is stricter than Play's Repetitive
Content rule and this account will hold two election apps at once. The
differentiation has to be legible in the *listing*, not just true in the code.

Submit **after** `Hawkeye Election Monitor` clears review — the same native-first
order used on Play. Two similar apps in front of one reviewer is the avoidable
risk.

---

## 1. App information

- **Name (≤30):** `Hawkeye Lite: Election Monitor`  (**30 — exactly at the cap**)

  Identical to the Play title, deliberately: someone who meets one store listing
  should recognise the other. It has *no* slack, so any wording change breaks it.

- **Subtitle (≤30):** `For older phones and slow data`  (30)

  Says who it is FOR, which is the 4.3 argument in six words. Native's subtitle
  is `Citizen election transparency` — the two must not read interchangeably.

  **No download size in here.** "Under 5 MB" would be true today and stale after
  any release, and nothing forces you back to a subtitle. Same reasoning as the
  promotional-text note in the native listing.

- **Primary language:** English (U.K.) — matches native.
- **Bundle ID:** `ng.com.hawkeye.lite`
- **SKU:** `hawkeye-lite-ios`
- **Primary category:** Utilities · **Secondary:** Reference

  Same as native, and for the same reason: **not News.** The function is
  recording and verifying, not reporting. Claiming News invites publisher
  obligations and contradicts the Play IARC answer already on file.

- **Copyright:** `2026 IniXien, LLC`
- **Support URL:** `https://hawkeye.com.ng/support.html`
- **Marketing URL:** `https://hawkeye.com.ng`
- **Privacy Policy URL:** `https://hawkeye.com.ng/privacy.html`

---

## 2. Keywords (≤100 chars)

```
observer,polling,results,ballot,vote,civic,Nigeria,audit,ledger,integrity,evidence,offline
```
(90 chars.)

Native's list with `democracy` swapped for `offline`, which is both true of this
build and a term someone on a poor connection actually searches. Words already in
the name or subtitle — election, monitor, lite, phones, data — are **omitted**:
Apple indexes those fields anyway and repeating them wastes the budget.

**Do not add `INEC`.** It is another organisation's name, and bidding on it
implies exactly the affiliation this listing denies — the mistake that got the
Android app rejected twice.

---

## 3. Promotional text (≤170, editable without review)

```
The small-download version of Hawkeye. Report what happens at your polling unit, and publish it to a public record anyone can check — on any phone, on any connection.
```
(166 chars — counted by `tmp/count_listing.mjs`, not by eye; my first estimate
said 164.)

**Evergreen on purpose.** This is the one field Apple lets you change without a
review cycle, which makes it the right place for a time-bound hook and the worst
place to leave a stale one. If you promote a specific election here, set a
reminder to clear it the day after.

---

## 4. Description (≤4000)

```
Hawkeye Lite is the small-download version of Hawkeye, built for phones with little storage and for people watching their data.

It does the same job as the full app: it lets ordinary Nigerians record what actually happens at their polling unit, and publishes those records somewhere anyone can check them.

WHICH VERSION SHOULD YOU INSTALL?
If your phone is recent and storage is not a concern, install Hawkeye Election Monitor instead — it is the full native app. Choose Lite if you are short on space, on a metered connection, or using an older handset. Both file into the same public record.

WHAT YOU CAN DO
• Photograph a result sheet at your polling unit and file it with the time and place it was taken
• Check the figures before you submit — nothing is sent until you confirm it
• Follow a race and watch results as observers report them
• Browse polling units, wards and local government areas across the federation
• Practise the entire reporting flow before election day, with nothing published

HOW A RECORD IS VERIFIED
Every submission is signed on your own device and added to an append-only record, which is periodically anchored to an independent public transparency log. A published record can therefore be checked by anyone — including you — without having to trust Hawkeye. If a record were altered after the fact, that check would fail.

PRACTICE ANY TIME
Practice mode is a complete run-through of reporting a result, available whenever you want it. Nothing you do in practice is published or counted.

WHAT THIS APP IS NOT
Hawkeye is not affiliated with, endorsed by, or connected to the Independent National Electoral Commission (INEC), any government body, any political party, or any candidate. Figures shown in Hawkeye are unofficial crowd reports from observers — they are not official results. Only INEC declares official results.

Official sources:
https://www.inecnigeria.org
https://www.inecelectionresults.ng

Hawkeye is published by IniXien Limited.
```

The closing block is not boilerplate. The **non-affiliation statement**, the
**figures-are-unofficial statement** and the **official source link** are the
three claims `mobile/scripts/build_aab_lite.sh` gates the build on, because Play
rejected this app twice over them. Keep all three, in the description as well as
in the app.

---

## 5. Screenshots

Six captioned shots per display size, in
`Downloads/hawkeye-screenshots/lite-ios-{6.5,6.7,6.9}`:

```
1-capture  2-home  3-published  4-result  5-map  6-practice
```

Produced by `tests/ui/capture_lite_shots.mjs` → `backend/scripts/make_store_screenshots.mjs`
— the **same compositor as the native set**, so plate, caption size and canvas
are identical. Captured **light**, where the native set is dark; that is a
listing decision, so the two read as distinct products in search results.

**`1-capture.png` is the native iOS one, reused.** Confirmed on device
2026-08-28: native and Lite present the **same** capture screen on iPhone —
both reach Apple's VisionKit document camera, and the only difference is the
prompt text. So the native image is accurate for Lite and drops straight in;
plate, caption and canvas are already identical. Copy per display size, not one
image stretched across three.

(The Android Lite set reuses the **ML Kit** scanner shot instead, because that
is what Android shows. Never put that one in an App Store listing.)

Verify before uploading:
```bash
node tests/ui/check_caption_fit.mjs lite-ios-6.5 lite-ios-6.7 lite-ios-6.9
```

---

## 6. App Review Information

- **Sign-in required:** Yes, with **two exceptions that matter to a reviewer** —
  the auth funnel (`observe.html`) and **Practice** (`practice.html`) stay open
  signed out. `app/authgate.js`: in the app shell, "only the auth funnel +
  practice stay open". This is *different from native*, where every route except
  `/welcome` and `/sign-in` redirects — do not copy native's "no signed-out
  browsing" line, it is wrong here and understates the app.
- **What a reviewer sees on first launch:** the Verify Your Phone screen with a
  card reading **"New to Hawkeye? — Run a practice election first — no sign-up,
  and nothing you enter is published."** (`observe.html:189`). It is visible in
  sign-up mode, which is the default. Naming a control that is actually on
  screen is the whole point; native's notes once named a flow the reviewer could
  not reach and that cost a full 2.1 cycle.
- **Demo account:** `+2348167000004` — international format, including the `+`.
  Password as stored in App Store Connect. **Re-verify it works before
  submitting**; a password never set server-side caused a rejection on Android.
- **Contact:** osas@inixien.com

**Notes (paste into App Review Notes):**

```
Hawkeye Lite is an independent civic transparency tool. It is not a government app and is not affiliated with INEC, any government body, or any political party. Every screen presenting government-sourced information carries a visible notice saying so and links the official INEC site.

WHY THERE ARE TWO HAWKEYE APPS
Hawkeye Election Monitor is the full native app. Hawkeye Lite is a much smaller build for older phones and metered data connections. Same purpose, different target device, and each listing says which one to choose.

YOU DO NOT NEED TO SIGN IN TO REVIEW THE CORE FLOW
On first launch, tap the card reading "New to Hawkeye? Run a practice election first". Practice is a complete mock election that runs end to end on any date: photograph a result sheet, enter the figures, submit. Nothing is published and no real report is filed. No account is required for this.

DEMO ACCOUNT (for the signed-in experience)
Phone: +2348167000004
Password: as supplied in App Store Connect

Please sign in with phone and password. Do not use the OTP option - those codes are sent to a physical SIM.

Apart from that first screen and Practice, the app requires an account.

Real result and incident reporting is date-gated to election day. Practice is the way to review the full reporting flow on any other date.

All figures shown in the app are unofficial, crowd-reported observations from citizen observers. Official results are declared by INEC and are linked from within the app.

USER-GENERATED CONTENT (Guideline 1.2)

Incident reports are reviewed by a human before they appear publicly; nothing user-submitted is published unmoderated.

Every published item carries a "Report this content" control, open to any reader, with reasons (abusive, false, privacy, other). Reports enter a moderation queue.

Abusive contributors can be suspended server-side, which removes their content from public view. Hawkeye has no user-to-user messaging, feed, comments or profiles, so there is no per-user block surface to build - abuse is handled by removing the contributor.

Contact for content concerns is published in-app under About and on the website: info@hawkeye.com.ng
```

**Guideline 1.2 has no form in App Store Connect** — it is four capabilities the
reviewer verifies by using the app, and the only text you write is the block
above. All four ship in `app/`, checked rather than assumed:

| Requirement | Where |
|---|---|
| Filter objectionable material | published only at `status = 'published'` (`backend/src/routes/incidents.js`) |
| Report offensive content | `incidents.html` **and** `incident-reports.html` → `POST /api/flags` |
| Block abusive users | observer suspension, server-side (`backend/src/routes/admin.js`) |
| Published contact | `info@hawkeye.com.ng`, About page — **do not remove it** |

`incident-reports.html` was **missing** the report control until 2026-08-28; it
renders observer descriptions, so the claim above would have been false on one
of the two pages. Found by checking each capability against `app/` instead of
copying native's table, which describes RN components Lite does not contain.

---

## 7. Everything else

**Age rating** and **App Privacy** are the same answers as the native listing —
same behaviour, same data collected. Copy §§5–6 of `APP-STORE-LISTING.md`.

- Answer the age-rating **fields**, never pick a band. Apple computes it; the
  native answers produced **12+**.
- Two that look alike and are not: `horrorOrFearThemes` = **None** (it asks about
  intent to frighten; distressing real footage is declared under
  `violenceRealistic`, and declaring it twice inflates the rating for one thing).
  `gunsOrOtherWeapons` = **Infrequent/Mild** (it asks about presence, and an
  incident photo may contain one).

**Do NOT copy native's §§7–8.** Guideline 1.2 and App Review Information are in
**§6 above**, written for this app. Native's differ in two ways that matter:

- its 1.2 table cites React Native components (`report-content.tsx`) that do not
  exist in Lite;
- its notes say **"there is no signed-out browsing"**, which is false here —
  `authgate.js` leaves the auth funnel and Practice open in the app shell. Copying
  that line would understate the app to a reviewer who could in fact try the whole
  reporting flow without an account.
