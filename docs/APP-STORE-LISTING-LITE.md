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

## 6. Everything else

Age rating, App Privacy, Guideline 1.2 and App Review Information are **the same
answers as the native listing** — same app behaviour, same data, same UGC
surface. Copy §§5–8 of `APP-STORE-LISTING.md` rather than re-deriving them, and
in particular:

- Answer the age-rating **fields**, never pick a band. Apple computes it; the
  native answers produced **12+**.
- Guideline 1.2 has **no form** — it is a paragraph in App Review Information.
- Review notes must say that **browsing requires an account**. The native notes
  once claimed otherwise and a reviewer following them reaches the sign-in
  screen and stops. That cost a full 2.1 cycle.
