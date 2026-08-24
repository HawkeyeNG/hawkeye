# Plan — audience-aware push, deep-linked notifications, and two flow fixes

Written 2026-08-24. Nothing here is built yet. Every claim below was read out of
the working tree; file:line references are given so each can be checked.

---

## 0. Read this first: iOS push does not work at all

The request was "we will sometimes need a different push for iOS users". The
prior problem is that **iOS users receive no push today, of any kind.**

- `device_push_tokens` already has a `platform` column — `'android' | 'ios' |
  'web'` (`backend/src/db.js:303-311`), and all three clients populate it
  correctly (`native/src/lib/push.ts:208-212`, `app/native.js:246`,
  `app/webpush.js:41`).
- **But every send filters on the literals `'android'` and `'web'` only** —
  `broadcast()` at `backend/src/services/push.js:225,231`, and `sendToObserver`
  at `:179,188`. An `ios` row is stored and then never selected by anything.
- Even if it were selected, it could not be delivered: the app calls
  `getDevicePushTokenAsync()`, which on iOS returns a **raw APNs token**, while
  the server sends through **FCM v1**. `push.js:113` already recognises the shape
  and returns false rather than trying.

So iOS segmentation is step two. Step one is making iOS deliverable, and that is
a fork:

| | what it costs | what it means later |
|---|---|---|
| **A. Add the iOS app to Firebase** (recommended) | register the bundle id in project `hawkeye-bd27d`, add `GoogleService-Info.plist`, rebuild. No server change — the token becomes an FCM one and the existing `fcmSend` path just works. | one transport for everything; `isRawApnsToken` becomes permanently false and can eventually be deleted |
| **B. Talk APNs directly** | a second transport in `push.js`, a `.p8` auth key, its own retry/error handling and token-invalidation rules | two transports to keep alive forever |

**A is the recommendation.** The APNs key already exists
(`~/hawkeye-secrets/ios/AuthKey_8LUGC6NGP8.p8`) but it is the App Store Connect
key, used for *submission*, not a push key — B is not as close to done as it
looks.

`push.js:104-126` anticipates exactly this and says so: the shape test "stops
being true exactly when the token stops being an APNs one."

---

## 1. Audience-aware sending in the Push tab

### What exists

`broadcast()` takes `{title, body, data, dryRun, confirm, maxAudience}` and
targets everyone. The admin tab offers a compose pane, a live audience count, a
lock-screen preview, and two presets (*Play Store migration*, *Scanner fix*).

### What to build

1. **`platforms` argument on `broadcast()`** — default all, so nothing changes
   for existing callers. It replaces the two hardcoded literals with a filtered
   `IN (...)`, and returns the per-platform split it already computes.
2. **An audience selector in the Push tab** — Android / iOS / Web, with the count
   updating per selection. The count must come from the same query that sends,
   not a parallel one, or the preview and the send will disagree.
3. **Per-platform copy on one send.** This is the actual ask: the *Play Store
   migration* preset says "Install the Play Store version", which is wrong for an
   iPhone and wrong for someone already on Play.

   Two shapes are possible, and this is a **decision needed**:

   - **(a) Variant fields.** One send, one `title`, and a body/url per platform.
     Simple; keeps "one announcement" as one object; the admin writes two or
     three short bodies.
   - **(b) Separate sends.** The admin composes and fires once per audience.
     Nothing new in the data model; more clicks; no single record of "this
     announcement".

   Recommendation: **(a)**, because the store-link case is precisely "same
   message, different destination", and (b) makes it easy to send the Android
   half and forget the iOS half.

4. **Store-link presets become platform-aware.** `Play` → Play listing on
   Android; `App Store` → `id6804218478` on iOS; on web, the site's own install
   dialog. Note this preset should not fire at all until the App Store listing is
   live — same switch discipline as the badge.

### Guards to keep

The existing three (`dryRun` default, `confirm` string, `maxAudience`) all stay
and must apply per-audience, not to the total — a `maxAudience` that passes on
the combined count could still be a runaway for one platform.

---

## 2. Variant awareness — Play vs Lite vs dev

**Not recorded today.** There is no package/bundle column, and no client sends
one (`push.js:69-79`). So "update from Play" reaches Lite users, for whom it is
wrong, and dev/test installs, for whom it is noise.

Smallest change that fixes it: **add an `app_id` column** (the package /bundle
id) and have each client send it at registration — the RN app knows its own
`applicationId`, Capacitor knows `Cap.getPlatform()` and its appId, web sends
`'web'`. Then the migration preset can exclude `ng.com.hawkeye.observer` (already
on Play) and target `ng.com.hawkeye.lite` with different words.

Worth doing at the same time as §1, because it is the same table, the same
registration call and the same audience selector.

---

## 3. Deep-linked notifications

### What already works

More than expected. Notification rows already carry a `url`
(`db.js:312-324`), the Alerts row is already a `Pressable`, and
`openNotificationTarget()` (`native/src/lib/push.ts:155-163`) already translates a
website URL into a native route, falling back to an in-app browser tab.
`case.html?id=N` already proves a **parameterised** target survives the hop
(`push.ts:143-148`).

### The three problems

**(a) Three hand-maintained routing tables, and `/race` is in none of them.**

| table | maps | file |
|---|---|---|
| `ROUTES` | notification url → native route | `native/src/lib/push.ts:107` |
| `TARGETS` | App Link → native route | `native/src/app/open.tsx:18` |
| `TARGETS` | App Link → web page | `app/open/index.html:35` |

Three copies of one fact is how the fourth one gets forgotten. **Proposal: one
table, one shape, shared** — a small module both clients read, the way
`seat_lgas.json` and `contests.json` are already shared. Adding a target then
means one edit, and a test can assert all three consumers agree.

**(b) A cold deep link is destroyed by the auth gate.**
`native/src/app/_layout.tsx` redirects a signed-out user to `/welcome` and keeps
no return target — the race/unit/case they tapped is simply gone. Push
registration requires sign-in, so this mainly bites on sign-out, token expiry and
Telegram `/open` links. **Fix: persist the pending destination and resume it
after sign-in.** Small, and it makes every deep link below trustworthy instead of
mostly-working.

**(c) Web is more permissive than native.** A race page is public on the web but
gated in the app, so the same link works for a signed-out web visitor and bounces
a signed-out app user. Worth aligning deliberately rather than by accident.

### The three targets requested

| notification | destination | exists? | work |
|---|---|---|---|
| "vote in this election" | that race's page | route exists (`/race?contest=…&state=…`, and the 1,005 SHA/SEN/REP forms) — **but no routing-table entry** | add `/race` to the shared table with its params; §6 makes the page's own CTA reachable |
| "save your polling unit" | the picker, not the map screen | **no** — profile links to `/map-unit`, which is "stand here and record a GPS fix" | §7 builds the picker; the deep link then targets it |
| "follow this race" | that race page, ready to follow | page exists; `FollowRace` is already on it (`race.tsx:446`) | add a `?follow=1` intent that scrolls to and highlights the control |

---

## 4. Alerts as a send channel

You could not remember the scenario. Two real gaps turned up that would each
produce it:

**(a) A broadcast leaves no trace.** `broadcast()` writes **zero** notification
rows (`push.js:216-276` — no `pushNote`, no INSERT). So an admin announcement
hits the lock screen and, if swiped away or missed with the app closed, is gone
forever. The direction that works is the other one: `pushNote()` writes the row
*and then* fires a push (`services/notifications.js:9-14`).

**(b) The Alerts screen promises something it does not deliver.** Its empty state
says *"Updates on races you follow and reports you file land here"*
(`alerts.tsx:162`) — but race-follow fan-out goes to **Telegram only**
(`routes/subscriptions.js:46-52`) and creates no alert rows. Someone who follows
a race in the app and has no Telegram gets nothing, from a screen that told them
otherwise.

**Proposal, in the order they matter:**

1. **Make race-follow notifications write alert rows** — closes a promise
   already made on screen. Reuses `pushNote`, which pushes for free.
2. **Give `broadcast()` an "also file in Alerts" option** (default on for real
   sends). One row per targeted observer, using the same title/body/url. Two
   caveats: broadcast can target device rows with **no observer**
   (`push.js:225`), which the per-observer table cannot represent — those get the
   push only; and a large broadcast becomes N inserts, so it wants a batch.
3. **Then** an admin authoring path is nearly free: there is exactly one INSERT
   in the codebase (`notifications.js:9`), so "compose an alert" is a thin route
   over `pushNote`, and a preview is the same rendering.

---

## 5. Race page: pin the report CTA

**There is no "Report from your unit" button on a race page in either client.**
What exists is:

- Web (`app/race.js:511-517`): *Follow this race* / *Become an Observer* →
  `observe.html?intent=observe` / *See Live Results*
- Native (`race.tsx:456-478`): *Become an observer* → **`/report/result`** /
  *Live results*

So the two clients say the same words and do different things — native already
goes to the report flow, web goes to a recruitment page. **Decide which is
right** (for a signed-in observer on a live race, native's is), then make them
agree and rename the button to what it does.

**Pinning.** Native has an established pattern and a written rule: the footer
`View` is a **sibling** of the ScrollView, never inside it, and stays within any
KeyboardAvoidingView. Two live examples to copy — `report/result.tsx:2010-2012`
and `map-unit.tsx:1271-1274`, both gated to appear when the action becomes usable.

**Web has no sticky action-bar pattern at all.** It needs one built, and it must
clear the existing fixed `.tabbar` (`styles.css:1251`, with
`body.has-tabbar { padding-bottom: … }`). This is the larger half of the work.

Also worth keeping: the existing rule that **a finished race asks for nothing**
(`race.js:501-506`) — a pinned recruitment CTA must not appear on a completed
race.

---

## 6. Profile: choose a unit, do not map one

Today `profile.tsx:501-522` sends "My Polling Unit" to `/map-unit`, a screen
titled *"Map a polling unit"* whose instruction is *"Stand at the polling unit
and record one GPS fix"* and whose primary button is *"I am standing here —
record fix"*. Saving is a secondary row. You are right that this is the wrong
destination: the user wants to **choose**, not to survey.

**This is mostly assembly, not new code.** Everything needed exists:

- `UnitSearch` (`native/src/components/unit-search.tsx:41`) is already written to
  be dropped into any host and is mounted in four screens
  (`report/result.tsx:1937`, `report/incident.tsx:1289`, `map-unit.tsx:1204`,
  `practice.tsx:1178`). It works offline from the register packs.
- Near-me: `findNearby` exists in `result.tsx:1796` and `map-unit.tsx:1086`,
  hitting `/api/mapping/nearby`.
- `ModalCard` is the shell, with its own rules about capped height and a footer
  that is a sibling of the scroll area.
- The write is one call: `POST /api/observers/my-unit`
  (`routes/observers.js:468-478`). One saved unit per observer —
  `saved_units.observer_id` is the PRIMARY KEY, so saving replaces.

**Plan:** a `ChooseUnitModal` = near-me row + `UnitSearch` + save, opened from
Profile. `/map-unit` stays exactly as it is, for people who really are standing
at a unit contributing a coordinate. Web gets the same via
`window.puSearch.mount()` (`app/pu-search.js:181`), already used at
`app/app.js:852`.

This modal is also the deep-link target for the "save your polling unit"
notification in §3.

---

## Suggested order

1. **§5 and §6** — self-contained UI, no schema change, immediately useful, and
   §6 creates the target §3 needs.
2. **§3(a) shared routing table + §3(b) deferred deep link** — makes every
   notification destination trustworthy before any are advertised.
3. **§0 option A** — put iOS on Firebase, so iOS push exists.
4. **§1 + §2** — audience selector, per-platform copy, variant column. One pass
   over the same table and the same admin tab.
5. **§4** — Alerts durability, starting with the race-follow promise.

Everything in 1–2 ships in versionCode 7, which is deliberately being held open.
Steps 3–5 touch the server and can land independently of a store release.

## Decisions needed

- **§1.3** — per-platform variant fields on one send (recommended), or separate
  sends per audience?
- **§0** — Firebase for iOS (recommended) or a direct APNs transport?
- **§5** — should the race-page CTA be "report from your unit" (native's current
  behaviour) or recruitment (web's)? They currently disagree.
