# Growing Hawkeye through the Play Store

Audited 2026-08-22 against the live listings and the Play Console.

Read [POSTMORTEM-OSUN-2026.md](POSTMORTEM-OSUN-2026.md) first. Osun produced
**12 organic observers and zero reports** across 3,763 polling units. Installs
were never the binding constraint, and multiplying zero by a hundred is still
zero. This document is about the Play Store because the Play Store is worth
getting right — not because it is the answer to that.

---

## 1. Where the listings actually stand

| | Hawkeye Election Monitor | Hawkeye Lite |
|---|---|---|
| package | `ng.com.hawkeye.observer` | `ng.com.hawkeye.lite` |
| status | **Production** since 18 Aug 2026 | **Draft — in review** since 19 Aug 2026 |
| installs | **0** | 0 |
| ratings | **none** | none |
| category | **Tools** | — |
| content rating | Teen (Users Interact) | — |

**It is indexed.** Searching `hawkeye election` returns it first, above the
unrelated `HAWKEYE` by Exly. Nothing is broken.

**It ranks for nothing else.** Searching `nigeria election results` — its exact
purpose — does not return it in the top 30. On the **Nigerian** storefront
(`gl=NG`), `election results` returns just **eight apps** and Hawkeye is not
among them.

That combination is diagnostic. The keywords are not the problem: the short
description already reads *"Nigerian election results from polling units"*,
containing the query verbatim. The problem is that Play has **no ranking signal
to work with** — no installs, no ratings, no retention, no uninstall data. A
four-day-old app with zero of everything cannot rank against apps that have
some of it, however well written its listing is.

### The field is nearly empty, which is the opportunity

Eight results for `election results` in Nigeria. The apps that do rank:

| app | developer | rating |
|---|---|---|
| myINEC: Official app of INEC | mrbinitie | 3.9 |
| Naija VOTER App | OrderPaper Nigeria | — |
| Nigeria Electoral Act 2026 | LUMOS GLOBAL STUDIO | — |
| Election Check | CryptoEdu | — |

`myINEC` is the incumbent for INEC-shaped search and is **not** published by
INEC. `Naija VOTER App` is from OrderPaper, a real civic organisation — a
plausible partner rather than a rival.

Ranking in a field of eight needs far less than ranking in a field of eight
hundred. A few hundred genuine installs and twenty real ratings would likely put
Hawkeye at the top of its own category in Nigeria.

---

## 2. The audit — ordered by what it costs to fix

### 2.1 Category is `Tools`. It should not be.

The single cheapest fix on this list. `Tools` is where flashlights, file
managers and QR scanners live; Play's browse surfaces and its "similar apps"
recommendations will place Hawkeye against those. Election and civic apps sit in
**News & Magazines**.

Category drives the "similar apps" carousel, which is a meaningful share of Play
discovery for apps nobody is searching for by name — exactly Hawkeye's position.

### 2.2 The screenshots are the biggest conversion problem

Six screenshots, and they are raw UI captures with **no caption overlays at
all**. Most people never scroll past the second. Currently:

| # | what it shows | problem |
|---|---|---|
| 1 | list of upcoming elections, "Opens in 151 days" | does not say what the app does |
| 2 | Leaderboard — "Nothing is being ranked yet / Pick one to see its board" | an **empty state**, shipped as a store screenshot |
| 3 | Governor of Osun — grey map, no data | looks broken |
| 4 | Senator FCT — "INEC has not published the candidates for this race yet" | reads as "this app has nothing" |

Screenshot 2 is an empty state on a production store listing, and screenshots 3
and 4 are grey maps whose captions say there is no data yet. Three of the first
four tell a prospective observer the app has nothing in it.

**None of the six shows the core action: photographing a result sheet.** That is
the product. It is absent from the store.

The shot list lives in `backend/scripts/make_store_screenshots.mjs`; capture,
name the files as listed there, and run it. Two constraints shaped it:

**The sheet in shot 1 must be blank.** A real EC8A carries a real unit's real
votes, and putting that on a store listing publishes a result Hawkeye has no
business publishing — for a tool whose entire claim is that it does not declare
results, it says precisely the wrong thing. `make_specimen_ec8a.mjs` generates a
blank A4 specimen to print and photograph. It carries no INEC branding, is
struck through with SPECIMEN, names polling unit `00-00-00-000`, and states on
both the header and footer that it is not an INEC document — a convincing blank
government form is a forgery kit, so this one is deliberately unconvincing. It
doubles as the training prop for walking a new observer through capture.

**The leaderboard is not a candidate.** It is empty until an election is live,
and practice runs go to their own separate chain — they never populate it. The
populated screens that genuinely exist today are the completed-race pages
(`/osun` shows the declared INEC result: Adeleke 511,067 v Oyebamiji 444,815,
LGAs won, returning officer, sources) and the political map (all 37
governorships by party, shipping in `political_data.json`). Use those.

Captions carry the message; the UI behind them is texture. Never ship an empty
state.

### 2.3 The long description opens with a denial

It currently begins:

> Hawkeye is an independent, citizen-run election transparency tool. It is not
> affiliated with INEC or any political party…

Play shows roughly the first line as the collapsed preview. The first thing a
prospective observer reads is what Hawkeye *is not*. The legal disclaimer is
necessary — it is why the 3 Aug rejection was resolved — but it belongs lower.
It already appears again in full at the bottom, so moving the opening does not
weaken the compliance position.

Open with the action and the place:

> Report your polling unit's result in Nigeria — photograph the sheet, check the
> figures, publish to a public record anyone can verify.

Keep every indexed term (`Nigerian`, `election results`, `polling unit`,
`observer`, `incident`) but write for a person, since Play weights the first
lines for both indexing and conversion.

**Ready to paste.** Replace only the FIRST paragraph of the full description —
everything from `WHAT YOU CAN DO` down, including the disclaimer block at the
bottom, stays exactly as it is:

```
Report your polling unit's result in Nigeria — photograph the sheet, check the
figures, publish to a public record anyone can verify.

Hawkeye is an independent, citizen-run election transparency tool for Nigerian
elections. Ordinary observers record what they see at their own polling unit,
and every entry goes to a tamper-evident ledger that anyone can audit. Official
results always remain INEC's; Hawkeye is not affiliated with INEC or any
political party.
```

That keeps the non-affiliation statement in the opening paragraph — so nothing
is weakened for policy review — while leading with the action rather than the
denial. The standalone disclaimer already repeated in full at the bottom is
untouched.

### 2.4 Zero ratings

Ratings are a ranking input and a conversion input, and Hawkeye has none. The
**In-App Review API** asks inside the app at a chosen moment, without sending
the user to the Store. The moment to ask is after a *successful* action —
finishing a practice run is ideal, since it is the one flow available between
elections.

Twenty ratings is a different listing from zero. It is achievable from the
existing 12 observers plus the team.

### 2.5 `docs/PLAY-STORE-LISTING.md` is stale

It records the short description as *"Citizen-led election monitoring — report
results & incidents to a public ledger."* The live listing says something
different and better. The doc should follow the listing or be deleted; a stale
spec is worse than none.

---

## 3. The generic Play levers, ranked

| lever | cost | why it matters here |
|---|---|---|
| **Store listing experiments** | free | A/B icon, first screenshot, short description in Console. Google runs the stats. Typical wins 10–30% on conversion, compounding on every other channel |
| **Custom store listings** | free | Up to 50, targetable by country **and reachable by URL** — the most Hawkeye-shaped feature Play has (see below) |
| **Android vitals** | free | Crash and ANR rates above Google's bad-behaviour thresholds reduce discoverability and can add a warning to the listing. Check the current thresholds in Console; they move |
| **In-app review prompts** | low | See 2.4 |
| **Localised listings** | low | Play indexes each language separately. Hausa, Yoruba and Igbo listings are three more search surfaces and a genuine differentiator no competitor has |

### Custom store listings deserve their own paragraph

A listing can be reached by URL, which means each recruitment channel can land
on a page written for it — the party-agent pitch, the CSO approach, the
journalist approach — all sharing one app and one build. Hawkeye's problem is
segment-specific recruitment, and this is the one Play feature shaped like that
problem. Set the default listing Nigeria-first.

### What not to do

- **No paid App Campaigns on broad keywords.** They will deliver installs from
  people who cannot be at a Nigerian polling unit, which suppresses retention —
  now a ranking input — and buys nothing.
- **Nothing that buys installs.** Same mechanism, plus policy risk.
- **Do not chase a spike.** For an app with a fixed date, a burst followed by a
  cliff is the worst signal available. Grow steadily into 16 Jan 2027.

### The keyword you cannot use

`INEC` is almost certainly the highest-volume Nigerian query in this space, and
Hawkeye must not put it in the title or short description. The app already took
a Play rejection over government-source disclaimers on 3 Aug 2026, and a
commission's name in the title of an unaffiliated app invites a second one that
would be harder to argue. Mentioning INEC factually in the body — as the listing
already does, alongside the official links — is fine and is what kept it
compliant.

`election results`, `polling unit`, `election observer`, `result sheet` and
`Nigeria` are all safe, specific, and largely uncontested locally.

---

## 3a. Migrating existing users off the Capacitor APK

Everyone currently running Hawkeye has the sideloaded Capacitor build, which is
**larger** than the native app on Play (~76 MB against a ~35 MB download) and
cannot update itself. Moving them is worth doing on its own merits, and it also
supplies the first install and rating signal the listing has none of.

`backend/scripts/broadcast_push.mjs` sends one push to every registered device.
It is **dry-run by default** and refuses a real send without `--send`, an
explicit `--max` audience guard, and `confirm: 'SEND'` internally. A push cannot
be recalled, so the normal way to use it is to look at what it would do first:

```
node scripts/broadcast_push.mjs                    # audience + exact copy, sends nothing
node scripts/broadcast_push.mjs --send --max 50    # real send, refuses above 50
```

**It must run on the production server.** Locally both FCM and Web Push report
unconfigured and the audience is 0, because the credentials and the device
tokens are on the host, not in a dev checkout. Running it locally will cheerfully
report success having reached nobody.

The `--max` guard is the important one: you state the audience you believe you
are addressing, and if the database disagrees nothing goes out. That is the
difference between messaging 19 observers and messaging 19,000 people.

## 4. Sequence

Nothing here is expensive; the order is what matters.

1. **Category → News & Magazines.** Minutes.
2. **Rewrite the first line of the long description.** Minutes.
3. **Reshoot screenshots 1–3** with captions, showing the capture flow and
   populated states.
4. **Chase Lite out of review** — Draft since 19 Aug.
5. **Wire the In-App Review API** to the end of a practice run.
6. **Set up a store listing experiment** on the first screenshot once there is
   enough traffic for significance.
7. **Custom listings per recruitment channel**, before outreach begins.
8. **Localised listings** in Hausa, Yoruba, Igbo.

---

## 5. The metric

Not installs. From the postmortem: **committed observers per LGA, counted
weekly.** Osun needed roughly 300 for ten-unit coverage across 30 LGAs and had
12.

The Play Store can convert attention Hawkeye has already earned, and steps 1–4
above will roughly double that conversion for an afternoon's work. It will not
manufacture attention for a civic app in a country where almost nobody has heard
of it. That remains a recruitment problem, and it is still the one that decides
whether 2027 produces reports.
