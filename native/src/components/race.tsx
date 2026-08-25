import { router } from 'expo-router';
import { Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useEffect, useMemo, useState } from 'react';

import { FollowRace } from '@/components/follow-race';
import { BRAND, api, type National } from '@/lib/api';
import { RaceMap } from '@/components/race-map';
import {
  isPresidency,
  logoUrl,
  partyColor,
  photoUrl,
  resultsHrefFor,
  seatFieldOf,
  wholeFieldOf,
  type Candidate,
  type Race,
} from '@/lib/political';

/**
 * Has polling day passed? Deliberately not the contest's `open` flag —
 * reportingOpen() is true from poll-open onwards and never goes false again, so
 * every finished election would read as live forever. Compared at midnight, so a
 * race is not "completed" at 00:01 on its own polling day.
 */
function isCompleted(race: Race): boolean {
  if (!race.date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(`${race.date}T00:00:00`);
  day.setHours(0, 0, 0, 0);
  return day < today;
}

/** Party emblem, falling back to the code itself when there's no image. */
export function PartyMark({
  party,
  logos,
  size = 18,
}: {
  party: string;
  logos: Record<string, string>;
  size?: number;
}) {
  const url = logoUrl(logos, party);
  if (!url) {
    return (
      <View
        className="items-center justify-center rounded-full bg-surface"
        style={{ width: size, height: size }}
      >
        <Text className="text-[8px] font-bold text-muted">{party.slice(0, 3)}</Text>
      </View>
    );
  }
  // The white disc stays white in both themes on purpose: party emblems are
  // transparent PNGs drawn in their own colours and several are dark-on-nothing,
  // so a themed backdrop would swallow them. It reads as a badge, not a surface.
  return (
    <Image
      source={{ uri: url }}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#fff' }}
      resizeMode="contain"
    />
  );
}

function CandidateCard({ c, logos }: { c: Candidate; logos: Record<string, string> }) {
  return (
    <View
      className="mb-2 rounded-2xl bg-card px-4 py-3"
      style={{ borderLeftWidth: 4, borderLeftColor: partyColor(c.party) }}
    >
      <View className="flex-row items-center">
        {c.photo ? (
          <Image
            // photoUrl, not c.photo: political_data.json stores a path relative to
            // the site root ("photos/candidates/tinubu.jpg"). A browser resolves
            // that against the page; React Native has no page to resolve against,
            // so the bare string is not a URI and every avatar rendered blank.
            // Same shape as the party emblems, which were already absolutised.
            source={{ uri: photoUrl(c.photo) }}
            className="h-11 w-11 rounded-full bg-surface"
            resizeMode="cover"
          />
        ) : (
          <View className="h-11 w-11 items-center justify-center rounded-full bg-surface">
            <Text className="text-xs font-bold text-muted">{c.initials ?? ''}</Text>
          </View>
        )}
        <View className="flex-1 pl-3">
          <View className="flex-row items-center">
            <PartyMark party={c.party} logos={logos} size={14} />
            <Text className="pl-1 text-[11px] font-bold" style={{ color: partyColor(c.party) }}>
              {c.party}
            </Text>
            {c.incumbent ? (
              <View className="ml-2 rounded-full bg-surface px-2 py-0.5">
                <Text className="text-[9px] font-bold text-good-ink">INCUMBENT</Text>
              </View>
            ) : null}
          </View>
          <Text className="pt-0.5 text-base font-bold text-ink">{c.name}</Text>
        </View>
      </View>
      {c.line ? <Text className="pt-2 text-sm text-muted">{c.line}</Text> : null}
      <View className="pt-2">
        {[
          ['Home base', c.home],
          ['Bid', c.bids],
          ['Status', c.status],
        ].map(([k, v]) => (
          <View key={k} className="flex-row py-0.5">
            <Text className="w-24 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {k}
            </Text>
            <Text className="flex-1 text-xs text-muted">{v || '—'}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * One race, rendered the same way wherever it appears — the native counterpart
 * of race.js's mountRace, shared by Osun 2026 and the 2027 presidential field.
 */
export function RaceView({
  race,
  logos,
  resultsHref,
}: {
  race: Race;
  logos: Record<string, string>;
  resultsHref?: string;
}) {
  /**
   * The running totals, fetched ONCE for the two things that want them.
   *
   * RaceMap asked for this already; the candidate list needs the same response's
   * party totals, and two requests to one endpoint on every race screen is a
   * cost with nothing to show for it. Fetched here and handed down — RaceMap
   * still fetches its own when no board is passed, so it stays usable alone.
   *
   * `undefined` while in flight, `null` on failure: the map distinguishes them,
   * because "not given" and "given and empty" mean different things there.
   */
  const [board, setBoard] = useState<National | null>(null);
  useEffect(() => {
    let live = true;
    const state = race.join?.state || race.join?.value;
    if (!race.join?.contest || !state) return undefined;
    api
      .national(race.join.contest, { state, level: 'lga' })
      .then((b) => live && setBoard(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [race.join]);
  const dateStr = race.date
    ? new Date(`${race.date}T00:00:00`).toLocaleDateString('en-NG', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';
  // THE PRESIDENCY PROFILES ITS FIELD; EVERY OTHER RACE LISTS IT — the rule and
  // its reasoning live in lib/political.ts, next to the web twin's, so the two
  // can be compared by a test rather than by reading two renderers side by side.
  const seatField = seatFieldOf(race);
  const wholeField = seatField ? wholeFieldOf(race) : [];
  /**
   * The running total per party, or null until there is one.
   *
   * Joined on PARTY — the only key the two sides share, because a result sheet
   * records votes by party, not by candidate name. NULL RATHER THAN AN EMPTY MAP
   * when nothing has been reported: the list then renders exactly as it did
   * before, with no column of zeroes claiming nobody has voted for anyone.
   */
  const reported = useMemo(() => {
    if (!board?.unitsReporting || !board.national?.length) return null;
    const totals = new Map(board.national.map((n) => [String(n.party), Number(n.votes) || 0]));
    return { totals, units: board.unitsReporting };
  }, [board]);
  const ballot =
    !seatField && race.others?.length
      ? [...race.candidates, ...race.others].sort((a, b) => a.party.localeCompare(b.party))
      : null;
  // A race whose field INEC has not published is the normal state of a seat page
  // until about a month out. With no cards to put in them, the candidate
  // sections printed a heading, a nonpartisan disclaimer and then nothing —
  // which is what every governorship page outside Osun would have opened on.
  const hasField = !seatField && race.candidates.length > 0;
  // WHERE THE NOTE GOES DEPENDS ON WHAT ELSE IS ON THE SCREEN. With candidates it
  // is a source credit and belongs at the foot; with none it is the only thing
  // explaining why there is no ballot, and the foot position puts that under two
  // buttons, below the fold.
  //
  // Asked of the WHOLE screen, not of `hasField`: a seat never has front-runner
  // cards now, so keying on `hasField` would float the source credit to the top
  // of every seat that DOES have a published field.
  const anyField = seatField ? wholeField.length > 0 : race.candidates.length > 0;
  const noteLeads = !anyField && !!race.note;

  // THE YEAR COMES FROM THE DATA — the polling date, or a year inside dateText
  // for a race whose day INEC has not fixed. No year rather than a guessed one:
  // this template used to be Osun-and-the-presidency only, and a hardcoded 2026
  // would announce a 2027 Senate seat as a 2026 race. Twin of race.js:yearOf.
  const yr = race.date
    ? String(new Date(`${race.date}T00:00:00`).getFullYear())
    : (String(race.dateText ?? race.election ?? '').match(/\b(20\d{2})\b/) ?? [])[1] ?? '';

  return (
    <View>
      <Text className="text-xl font-bold text-ink">
        {race.office ? `${race.office}${yr ? ` — ${yr}` : ''}` : race.election}
      </Text>
      {dateStr ? <Text className="pt-0.5 text-sm text-muted">{dateStr}</Text> : null}

      {(() => {
        // Candidate count is derived from the cards on THIS page (front-runners +
        // full ballot / minors), matching web's race.js; LGA/unit totals come from
        // the data. Date is a fixed day where INEC set one (Osun), else a verbatim
        // label (the 2027 presidential date is not yet fixed — dateText '2027').
        const st = race.stats;
        // COUNTED FROM THE LIST THAT IS ACTUALLY PRINTED. On a seat the merged
        // field is the only list, so deriving the number from anything else
        // could disagree with what is on screen directly beneath it.
        const candTotal = seatField
          ? wholeField.length
          : race.candidates.length + (race.others?.length ?? race.minors?.length ?? 0);
        const cells: Array<[string | number, string]> = [];
        if (race.date) {
          cells.push([
            new Date(`${race.date}T00:00:00`).toLocaleDateString('en-NG', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }),
            'Election day',
          ]);
        } else if (race.dateText) {
          cells.push([race.dateText, race.dateLabel ?? 'Date']);
        } else if (yr) {
          // THE YEAR IS A FALLBACK, NOT A FIFTH CELL. A full election day
          // already contains it ("16 Jan 2027"), and the written races carry
          // their own dated label — one of which is literally "Election year",
          // so an unconditional cell printed that label TWICE on those screens.
          cells.push([yr, 'Election year']);
        }
        /**
         * TBD, NOT A SUPPRESSED CELL.
         *
         * This used to omit the cell at zero, on the grounds that a `0` in a
         * stat bar reads as a claim about the ballot rather than about our data.
         * Right about the zero, wrong about the fix: dropping the cell made the
         * card SHORTEST on exactly the screens that have least, so a seat with
         * no published field looked like one that had been half-built.
         *
         * `TBD` says what the zero could not — the number is missing from
         * Hawkeye, not from the election.
         */
        cells.push([candTotal || 'TBD', 'Candidates']);
        if (st?.heldBy) cells.push([st.heldBy, 'Held by']);
        /**
         * THE COUNT SHOULD DESCRIBE WHAT THE MAP DRAWS — except where it cannot.
         *
         * The map above is cut from LGAs at every level, so the LGA count and
         * the shapes on screen are the same fact twice: a governorship's whole
         * state, a senatorial district's 3-8, a federal constituency's 2-4.
         * Naming a different unit than the one being drawn makes a reader
         * reconcile two numbers for no gain.
         *
         * A STATE CONSTITUENCY IS THE EXCEPTION, and the only one. It sits
         * inside a single LGA — "1 LGAs", on 765 of the 1,005 seats — which is
         * not a fact about the seat so much as a fact about the register not
         * separating them. Wards are the grain that seat is actually built from
         * and the only figure that varies: 8 to 20 per state constituency.
         *
         * REP was briefly measured in wards too and is back on LGAs, because
         * its map really does draw 2-4 shapes and the count now names them.
         * Twin: app/race.js.
         *
         * Chosen off `join.level`, the same field the board and the map key on,
         * so a screen cannot describe itself as one kind of race and draw
         * another.
         */
        const seatLevel = race.join?.level === 'lga';
        // A count of one is still a count of one. "1 LGAs" appears on 80 of the
        // 366 federal constituencies and 986 of the 1,005 state seats — not a
        // rare edge.
        const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
        if (seatLevel && st?.wards != null) cells.push([st.wards, plural(st.wards, 'Ward')]);
        else if (st?.lgas != null) cells.push([st.lgas, plural(st.lgas, 'LGA')]);
        if (st?.pollingUnits != null) {
          cells.push([`~${st.pollingUnits.toLocaleString()}`, plural(st.pollingUnits, 'Unit')]);
        }
        return (
          <View className="mt-3 flex-row rounded-2xl bg-card px-2 py-3">
            {cells.map(([n, l]) => (
              <View key={l} className="flex-1 items-center">
                <Text className="text-base font-bold text-ink" numberOfLines={1}>
                  {n}
                </Text>
                <Text className="text-[10px] text-muted">{l}</Text>
              </View>
            ))}
          </View>
        );
      })()}

      <RaceMap join={race.join} date={race.date} board={board} />

      {/* WHO INEC DECLARED — on a finished race, the first thing a reader wants.

          DELIBERATELY NOT AN INEC-LOOKING BADGE. No crest, no emblem, nothing
          that could pass for a mark INEC issued: this app says "Not government
          or INEC affiliated" on every board, and a screen wearing INEC's
          insignia would contradict that on sight — quite apart from being
          someone else's mark to use. Hawkeye's own badge, CITING INEC in words.

          It renders only from a hand-recorded `declared` block. IReV publishes
          sheet IMAGES, never numbers, so there is no endpoint this could be
          derived from — an absent block means nobody has recorded the
          declaration yet, not that the race was undecided. */}
      {race.declared?.winner ? <Declared d={race.declared} logos={logos} /> : null}

      {noteLeads ? (
        <View className="mt-3 rounded-2xl bg-surface px-4 py-3">
          <Text className="text-sm text-ink">{race.note}</Text>
        </View>
      ) : null}

      {race.incumbentNote ? (
        <View className="mt-3 rounded-2xl bg-surface px-4 py-3">
          <Text className="text-sm text-ink">{race.incumbentNote}</Text>
        </View>
      ) : null}

      {/* A SEAT'S WHOLE FIELD — one heading, one row each, in the same compact
          format the presidential screen uses for its minor candidates. See the
          `seatField` note above for why a seat is not given cards. */}
      {seatField && wholeField.length ? (
        <>
          <Text className="pb-1 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
            Declared candidates
          </Text>
          {/* WHAT THE NUMBERS BESIDE THE NAMES ARE. Said here rather than left
              to be inferred: on a completed race this list sits below the
              DECLARED card, and a reader has to be able to tell INEC's figures
              from what Hawkeye's observers have sent in. The unit count is part
              of the claim — a total without a denominator invites being read as
              final. */}
          <Text className="pb-2 text-xs text-muted">
            Alphabetical by party. Not an endorsement or a prediction.
            {reported
              ? ` Totals are what observers have reported so far — from ${reported.units.toLocaleString()} polling unit${
                  reported.units === 1 ? '' : 's'
                }, not an official count.`
              : ''}
          </Text>
          <View className="overflow-hidden rounded-2xl bg-card">
            {wholeField.map((c, i) => {
              const votes = reported?.totals.get(c.party);
              return (
                <View
                  key={`${c.party}-${c.name}`}
                  className={`flex-row items-center px-4 py-2.5 ${i > 0 ? 'border-t border-line' : ''}`}
                >
                  <PartyMark party={c.party} logos={logos} />
                  <View className="flex-1 pl-3">
                    <Text className="text-sm text-ink">{c.name}</Text>
                    {c.meta ? <Text className="text-[11px] text-muted">{c.meta}</Text> : null}
                  </View>
                  <Text className="shrink-0 text-[11px] font-semibold" style={{ color: partyColor(c.party) }}>
                    {c.party}
                    {!c.meta && c.incumbent ? ' · inc' : ''}
                  </Text>
                  {/* Only when this party has votes. A "0" against a name reads
                      as "nobody voted for them", which is a different and
                      wrong claim while reports are still arriving. */}
                  {votes ? (
                    <Text className="shrink-0 pl-3 text-sm font-bold tabular-nums text-ink">
                      {votes.toLocaleString()}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </>
      ) : null}

      {hasField ? (
        <>
          <Text className="pb-1 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
            {race.others ? 'Front-runners' : 'Declared candidates'}
          </Text>
          <Text className="pb-2 text-xs text-muted">
            Alphabetical by party. Not an endorsement or a prediction.
          </Text>
          {race.candidates.map((c) => (
            <CandidateCard key={`${c.party}-${c.name}`} c={c} logos={logos} />
          ))}
        </>
      ) : null}

      {ballot ? (
        <>
          <Text className="pb-2 pt-3 text-[11px] font-bold uppercase tracking-wider text-faint">
            Full ballot — {ballot.length} candidates
          </Text>
          <View className="overflow-hidden rounded-2xl bg-card">
            {ballot.map((c, i) => (
              <View
                key={`${c.party}-${c.name}`}
                className={`flex-row items-center px-4 py-2.5 ${i > 0 ? 'border-t border-line' : ''}`}
              >
                <PartyMark party={c.party} logos={logos} />
                <Text className="flex-1 pl-3 text-sm text-ink">{c.name}</Text>
                <Text className="text-[11px] font-semibold" style={{ color: partyColor(c.party) }}>
                  {c.party}
                  {c.incumbent ? ' · inc' : ''}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* Not on a seat: `wholeField` above already printed every one of these
          names, and a second heading would double the field. */}
      {!seatField && race.minors?.length ? (
        <>
          <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
            Other declared candidates
          </Text>
          <View className="overflow-hidden rounded-2xl bg-card">
            {race.minors.map((m, i) => (
              <View
                key={`${m.party}-${m.name}`}
                className={`flex-row items-center px-4 py-2.5 ${i > 0 ? 'border-t border-line' : ''}`}
              >
                <PartyMark party={m.party} logos={logos} />
                <View className="flex-1 pl-3">
                  <Text className="text-sm text-ink">{m.name}</Text>
                  {m.meta ? <Text className="text-[11px] text-muted">{m.meta}</Text> : null}
                </View>
                <Text className="shrink-0 text-[11px] font-semibold" style={{ color: partyColor(m.party) }}>
                  {m.party}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {race.notableAbsence ? (
        <Text className="pt-3 text-sm italic text-muted">{race.notableAbsence}</Text>
      ) : null}

      {/* Quick compare — front-runner cards side by side. On EVERY race page that
          HAS front-runners, with the action buttons directly below; a seat with
          no published field would otherwise show an empty table with headers. */}
      {hasField ? (
        <>
      <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
        Quick compare
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="overflow-hidden rounded-2xl bg-card">
          <View className="flex-row bg-surface px-3 py-2">
            {['Candidate', 'Party', 'Home base', 'Bid', 'Status'].map((h, i) => (
              <Text
                key={h}
                className="text-[10px] font-bold uppercase tracking-wide text-muted"
                style={{ width: i === 0 ? 150 : 120 }}
              >
                {h}
              </Text>
            ))}
          </View>
          {race.candidates.map((c, i) => (
            <View
              key={`${c.party}-${c.name}`}
              className={`flex-row px-3 py-2.5 ${i > 0 ? 'border-t border-line' : ''}`}
            >
              <Text className="pr-2 text-xs font-bold text-ink" style={{ width: 150 }}>
                {c.name}
              </Text>
              <View className="flex-row items-center" style={{ width: 120 }}>
                <PartyMark party={c.party} logos={logos} size={14} />
                <Text className="pl-1 text-xs font-bold" style={{ color: partyColor(c.party) }}>
                  {c.party}
                </Text>
              </View>
              {[c.home, c.bids, c.status].map((v, j) => (
                <Text key={j} className="pr-2 text-xs text-muted" style={{ width: 120 }}>
                  {v || '—'}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
        </>
      ) : null}

      {/* FOLLOWING ONE SEAT — the size of subscription most people actually
          want, and until now the one there was no way to ask for. The board
          could only offer the whole election; wanting every governorship in the
          federation is a newsroom's interest, not a voter's. `join.value` is the
          seat's own region key — the state, senatorial district or federal
          constituency the backend buckets its reports by — so this follows
          exactly this race and nothing else.

          Not on a finished race, by the same rule as the CTA below: there will
          be no further reports to alert anyone about. */}
      {race.join?.contest && race.join?.value && !isCompleted(race) ? (
        <View className="pt-5">
          <FollowRace contest={race.join.contest} scope={race.join.value} />
        </View>
      ) : null}

      {/* The action row USED to sit here, in the scroll. It is now pinned by the
          screen — see RaceActions below and the hosts that render it. */}

      {[noteLeads ? '' : race.note, race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit]
        .filter(Boolean)
        .join(' ') ? (
        <Text className="pt-4 text-xs text-faint">
          {[noteLeads ? '' : race.note, race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit]
            .filter(Boolean)
            .join(' ')}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A race's primary actions, PINNED — a sibling of the host's ScrollView, never
 * inside it.
 *
 * WHY IT LEFT RaceView. A race page is long: stat bar, map, declared result,
 * note, then a candidate list that on a presidential page runs to nineteen
 * names. The one thing the page is asking of an observer sat at the bottom of
 * all that, reachable only by scrolling past everything. The house rule is that
 * no primary action is scroll-only, and the pattern is the footer View as a
 * SIBLING of the scroller — report/result.tsx and map-unit.tsx both do it that
 * way, and inside any KeyboardAvoidingView so it lifts with the keyboard.
 *
 * "REPORT FROM YOUR UNIT", not "Become an observer". The destination was already
 * the report flow; the label described recruitment. Someone reading a race page
 * who is ready to act is being asked to file from where they are standing, and
 * the button now says that. (The web twin said the same words but went to
 * sign-up — see app/race.js, now aligned.)
 *
 * A FINISHED RACE ASKS FOR NOTHING. Past polling day there is no report to file,
 * so the report button goes — and with the results button gone too (below), a
 * completed race has no bar at all, which is why `hasRaceActions` exists.
 * Pinning makes that rule matter more, not less: a permanent bar recruiting for
 * an election that is over would be the most visible thing on the page.
 *
 * NO "LIVE RESULTS" BUTTON, BECAUSE THIS SCREEN IS THE LIVE RESULTS.
 *
 * RaceMap above draws this race's own regions coloured by /api/national — the
 * same board data, cropped to the race being read. A button labelled "Live
 * results" sat directly under a live result and sent the reader somewhere less
 * specific than where they already were.
 *
 * THE PRESIDENCY IS THE EXCEPTION, and for a reason worth stating rather than
 * special-casing quietly: it has no join, so race-map.tsx returns nothing and it
 * is the one race page WITHOUT a map of its own. Until it has one, the button
 * is the only way to a presidential board — and it now opens that board
 * directly instead of the picker (lib/political.ts:resultsHrefFor).
 */
export function RaceActions({
  race,
  resultsHref,
}: {
  race: Race;
  resultsHref?: string;
}) {
  const done = isCompleted(race);
  const boardOnly = isPresidency(race);
  return (
    <View className="flex-row">
      {done ? null : (
        <Pressable
          className={`flex-1 items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80${
            boardOnly ? ' mr-2' : ''
          }`}
          onPress={() => router.push('/report/result')}
        >
          <Text className="text-sm font-bold text-hawk-gold">Report from your unit</Text>
        </Pressable>
      )}
      {/* good-ink, not hawk-green: the fixed #004225 sat at 1.6:1 on the dark
          surface — an outline and a label that both disappeared. The semantic
          pair is 5.8:1 light / 11.0:1 dark, and matches every other secondary
          affordance in the app. The filled button beside it keeps the fixed
          brand pair because gold on dark green reads the same in both themes. */}
      {boardOnly ? (
        <Pressable
          className="flex-1 items-center rounded-2xl border border-good-ink py-3.5 active:opacity-70"
          onPress={() => router.push((resultsHref ?? resultsHrefFor(race)) as never)}
        >
          <Text className="text-sm font-bold text-good-ink">
            {done ? 'Review the results' : 'Live results'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Whether RaceActions would render anything at all.
 *
 * PinnedFooter draws a bordered bar around whatever it is given, so an empty
 * RaceActions inside one is a stripe of chrome pinned to the bottom of the
 * screen advertising nothing. A completed non-presidential race is exactly that
 * case. Hosts ask this before they mount the footer.
 */
export function hasRaceActions(race: Race | null | undefined): boolean {
  if (!race) return false;
  return !isCompleted(race) || isPresidency(race);
}

/**
 * The declared result. Web twin: app/race.js's `.declared` section and the
 * matching block in app/race.css — same wording, same ordering, same refusal to
 * dress itself as an INEC artefact.
 */
function Declared({ d, logos }: { d: NonNullable<Race['declared']>; logos: Record<string, string> }) {
  const rows = d.results ?? [];
  const top = rows.reduce((m, r) => Math.max(m, r.votes || 0), 0);
  const when = d.date
    ? new Date(`${d.date}T00:00:00`).toLocaleDateString('en-NG', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';
  return (
    <View className="mt-4 rounded-2xl bg-card px-4 py-4" style={{ borderLeftWidth: 4, borderLeftColor: BRAND.leaf }}>
      {/* The SECTION is what gets the heading role, not the person: a screen
          reader jumping by heading should land on "Declared result", not on a
          candidate's name — which would also read as Hawkeye announcing him
          rather than recording INEC's declaration. Web twin does the same. */}
      <View
        accessibilityRole="header"
        className="self-start rounded-full border border-good-ink px-2.5 py-1"
      >
        <Text className="text-[10px] font-bold uppercase tracking-widest text-good-ink">
          Declared result
        </Text>
      </View>
      <View className="flex-row items-center pt-2">
        <Text className="flex-1 pr-2 text-lg font-bold text-ink">{d.winner}</Text>
        {d.party ? (
          <View className="flex-row items-center">
            <PartyMark party={d.party} logos={logos} size={18} />
            <Text className="pl-1.5 text-sm font-bold text-muted">{d.party}</Text>
          </View>
        ) : null}
      </View>
      <Text className="pt-1 text-xs text-muted">
        Declared by {d.by || 'INEC'}
        {when ? ` on ${when}` : ''}
        {d.place ? `, ${d.place}` : ''}
        {d.returningOfficer ? ` · Returning Officer ${d.returningOfficer}` : ''}.
      </Text>

      {rows.map((r) => (
        <View key={r.party} className="flex-row items-center pt-2.5">
          <View className="w-14 flex-row items-center">
            <PartyMark party={r.party} logos={logos} size={14} />
            <Text className="pl-1 text-xs font-bold text-ink">{r.party}</Text>
          </View>
          <View className="flex-1 px-2">
            <Text className="text-[11px] text-muted" numberOfLines={1}>{r.name}</Text>
            <View className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
              <View
                className="h-1.5 rounded-full"
                style={{
                  width: `${top ? Math.max(3, Math.round(((r.votes || 0) / top) * 100)) : 0}%`,
                  backgroundColor: r.party === d.party ? BRAND.leaf : '#8aa79a',
                }}
              />
            </View>
          </View>
          <Text className="text-sm font-bold text-ink">{(r.votes || 0).toLocaleString()}</Text>
        </View>
      ))}

      {d.note ? <Text className="pt-3 text-[11px] text-muted">{d.note}</Text> : null}
      {d.sources?.length ? (
        <View className="flex-row flex-wrap pt-1.5">
          <Text className="text-[11px] text-muted">Recorded from: </Text>
          {d.sources.map((u, i) => (
            <Pressable key={u} onPress={() => Linking.openURL(u)}>
              <Text className="text-[11px] font-semibold text-good-ink">
                source {i + 1}
                {i < d.sources!.length - 1 ? ' · ' : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
