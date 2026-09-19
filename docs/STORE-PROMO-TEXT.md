# Store promotional text

Written WITH each build, never at submission time. Apple's promotional text is
the one field that can be changed without shipping a new version, which is
exactly why it gets forgotten until a review is already in flight.

Limits: **App Store promotional text 170 characters**, **Play short description
80 characters**. Both are counted below; a number that is wrong here is a
rejection or a truncation on the listing.

## 1.0.4 (39) — 2026-09-19, native, TestFlight

**App Store — promotional text**

> Report the result at your polling unit and keep your own signed copy of it.
> Practise any time — the rehearsal now works exactly like the real thing.

**Play — short description**

> Report your polling unit's result and keep your own signed copy.

What the build carries: the practice run is framed like the real report screen
(it was presented as a sheet and sat under a gap), and a practice run now saves
its card to the phone the way a real one does — labelled PRACTICE four times
over so the copy cannot pass for a result.

## 1.0.4 (40) — 2026-09-19, native, TestFlight

**App Store — promotional text**

> Report the result at your polling unit and keep your own signed copy — a card with the hawk on it, yours to send on. Practise any time.

**Play — short description**

> Report your polling unit's result and keep your own signed copy.

Play's line is unchanged from (39) and deliberately so: the build is visual
polish, and rewriting a short description that is already right costs the
listing its consistency for nothing.

What the build carries: the receipt card draws the hawk before the wordmark
(inlined, so it survives the capture), and six screens that hand-roll their own
header stopped drawing the opaque badge — practice, result, incident,
collation, page, terms.

## 1.0.4 (41) — 2026-09-19, native, TestFlight

**App Store — promotional text**

> Report the result at your polling unit and keep your own signed copy. Party agents can tell their coordinator they have arrived, right from the report screen.

**Play — short description** (unchanged)

> Report your polling unit's result and keep your own signed copy.

Carries: the invite section on the profile, check-in inside the report flow
(shown only to observers on a roster), the practice card and its full-screen
framing, the hawk on the receipt card, and cards sorted by count.

## Lite 1.4 (23) — 2026-09-19, TestFlight + Play closed testing

**App Store — promotional text**

> Report the result at your polling unit and keep your own signed copy. Invite the next observer from your profile — one unit covered is one fewer left dark.

**Play — short description** (unchanged)

> Report your polling unit's result and keep your own signed copy.

Lite bundles the website's app directory, so this build picks up the invite
card, the styled check-in aside and the whole session's web work without a port.
Android versionCode 11.
