# App Store submission — Hawkeye (native)

Everything App Store Connect will ask for, decided in advance. Apple account:
`dev.inixien@gmail.com`. Bundle id `ng.com.hawkeye.observer` (matches Play).

## 0. Blocking prerequisite

The account is a **free** Apple Developer account. Without a paid Apple
Developer Program membership there is no App Store Connect, no distribution
certificate and no upload. Enrolment is a purchase — it must be done by the
account owner at <https://developer.apple.com/programs/enroll/>.

- **Individual** enrolment: no D-U-N-S, usually approved in hours–48h. Seller
  name is the individual's legal name.
- **Organization** (Inixien Limited): needs a D-U-N-S for the **Nigerian**
  entity — the 08-079-9830 number belongs to IniXien, LLC (Atlanta), a
  different legal entity — then Apple verifies the company. Days to weeks.
- Apple supports converting individual → organization later.

## 1. Build and upload (once enrolled)

```bash
cd ~/hawkeye/native
npx eas-cli login                 # Expo account, interactive
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

EAS builds iOS in the cloud — no Mac needed. It will offer to create the
distribution certificate and provisioning profile; let it. The Apple ID prompt
is the enrolled `dev.inixien@gmail.com`, and app-specific passwords are **not**
needed (EAS uses the App Store Connect API key it generates).

`eas.json` profiles: `development` (dev client), `preview` (internal),
`production` (store).

## 2. TestFlight

Internal testing (up to 100 people on the team) needs **no** Beta App Review —
this is the fastest route to the app on a real iPhone. External testing does
need a review pass.

## 3. App Privacy answers

| Apple category | Collected | Linked to identity | Used for tracking | Purpose |
|---|---|---|---|---|
| Contact info → Phone number | Yes | **No** | No | App functionality — stored only as a one-way HMAC hash so one number equals one observer |
| User content → Photos or videos | Yes | No | No | App functionality — the EC8A sheet and venue photos are the published evidence |
| User content → Other user content | Yes | No | No | App functionality — vote counts, incident descriptions |
| Location → Precise location | Yes | No | No | App functionality — proves a report came from the polling unit it claims |
| Identifiers → Device ID | Yes | No | No | Fraud prevention — one device may report each race once |
| Diagnostics / Usage data | No | — | — | No analytics SDK, no third-party trackers |

Everything published (counts, photos, location) is tied to an anonymous
observer ID, never to a name or number — that is why "linked to identity" is No
throughout. Source of truth for the wording: `app/privacy.html`.

## 4. Answers Apple asks for

- **Export compliance**: already answered in the binary —
  `ITSAppUsesNonExemptEncryption: false` (HTTPS and platform crypto only).
- **Privacy manifest**: declared in `app.json` → `ios.privacyManifests`
  (UserDefaults CA92.1, file timestamp C617.1, boot time 35F9.1, disk space
  E174.1).
- **Content rights**: the app publishes user-submitted content; moderation and
  reporting are in place (below).
- **Age rating**: answer the FIELDS, do not pick a band. Apple's questionnaire
  is field-based now and computes the band itself; this file used to say "17+ is
  the safe answer" while APP-STORE-LISTING.md said 12+, and neither is enterable.
  The field-by-field answers live in `docs/APP-STORE-LISTING.md` §5, taken from
  the live `ageRatingDeclaration` schema. One source, not two.

## 5. Guideline 1.2 (user-generated content) — what a reviewer looks for

| Requirement | Where it is |
|---|---|
| Filter objectionable material | Incident media is human-reviewed before it appears publicly (`status='published'`) |
| Report offensive content | `components/report-content.tsx` → `POST /api/flags`, on every evidence block in the case file; same queue as the web |
| Block abusive users | Observer suspension, server-side (`backend/src/routes/admin.js`) |
| Published contact | About page: `info@hawkeye.com.ng`, in-app under More → About |

## 6. Listing copy

- **Name**: Hawkeye — Election Monitor
- **Subtitle**: Crowd-verified polling unit results
- **Support URL**: <https://hawkeye.com.ng/about.html>
- **Privacy policy URL**: <https://hawkeye.com.ng/privacy.html>
- **Category**: News (secondary: Reference)
- **Description**: reuse the Play listing, minus any Android wording.

Reviewers must be able to use it: elections are not always running, so the
review notes should say that **Practice Run** (More → Practice Run) walks the
entire reporting flow without an active election, and that "no active election
in <state>" is expected behaviour, not a failure. Provide a Nigerian test
number only if Apple asks — sign-in is OTP-based and a reviewer cannot receive
Nigerian SMS.

## 7. Screenshots

Required: 6.9" or 6.5" iPhone. Take them from TestFlight on a real device once
enrolment lands — the review notes above depend on showing the practice flow,
the ledger verification screen and the reports log.
