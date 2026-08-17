import { router } from 'expo-router';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';

import { FollowRace } from '@/components/follow-race';
import { RaceMap } from '@/components/race-map';
import {
  logoUrl,
  partyColor,
  photoUrl,
  resultsHrefFor,
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
  const dateStr = race.date
    ? new Date(`${race.date}T00:00:00`).toLocaleDateString('en-NG', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';
  const ballot = race.others?.length
    ? [...race.candidates, ...race.others].sort((a, b) => a.party.localeCompare(b.party))
    : null;
  // A race whose field INEC has not published is the normal state of a seat page
  // until about a month out. With no cards to put in them, the candidate
  // sections printed a heading, a nonpartisan disclaimer and then nothing —
  // which is what every governorship page outside Osun would have opened on.
  const hasField = race.candidates.length > 0;
  // WHERE THE NOTE GOES DEPENDS ON WHAT ELSE IS ON THE SCREEN. With candidates it
  // is a source credit and belongs at the foot; with none it is the only thing
  // explaining why there is no ballot, and the foot position puts that under two
  // buttons, below the fold.
  const noteLeads = !hasField && !!race.note;

  return (
    <View>
      <Text className="text-xl font-bold text-ink">{race.office || race.election}</Text>
      {dateStr ? <Text className="pt-0.5 text-sm text-muted">{dateStr}</Text> : null}

      {(() => {
        // Candidate count is derived from the cards on THIS page (front-runners +
        // full ballot / minors), matching web's race.js; LGA/unit totals come from
        // the data. Date is a fixed day where INEC set one (Osun), else a verbatim
        // label (the 2027 presidential date is not yet fixed — dateText '2027').
        const st = race.stats;
        const candTotal =
          race.candidates.length + (race.others?.length ?? race.minors?.length ?? 0);
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
        }
        // No "0 Candidates" cell — a zero in a stat bar reads as a claim about
        // the ballot rather than about what we have been given.
        if (candTotal) cells.push([candTotal, 'Candidates']);
        if (st?.heldBy) cells.push([st.heldBy, 'Held by']);
        if (st?.lgas != null) cells.push([st.lgas, 'LGAs']);
        if (st?.pollingUnits != null) cells.push([`~${st.pollingUnits.toLocaleString()}`, 'Units']);
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

      <RaceMap join={race.join} date={race.date} />

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

      {race.minors?.length ? (
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
                <Text className="text-[11px] font-semibold" style={{ color: partyColor(m.party) }}>
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

      {/* A FINISHED RACE ASKS FOR NOTHING. Recruiting observers for an election
          that is over sends people to a flow they cannot complete, and "Live
          results" promises a count that stopped moving. Standing rule: past
          polling day, no recruitment CTA, and the results button says what it
          now is. Twin of app/race.js. */}
      <View className="flex-row pt-5">
        {isCompleted(race) ? null : (
        <Pressable
          className="mr-2 flex-1 items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80"
          onPress={() => router.push('/report/result')}
        >
          <Text className="text-sm font-bold text-hawk-gold">Become an observer</Text>
        </Pressable>
        )}
        {/* good-ink, not hawk-green: the fixed #004225 sat at 1.6:1 on the dark
            surface — an outline and a label that both disappeared. The semantic
            pair is 5.8:1 light / 11.0:1 dark, and matches every other secondary
            affordance in the app. The filled button beside it keeps the fixed
            brand pair because gold on dark green reads the same in both themes. */}
        <Pressable
          className="flex-1 items-center rounded-2xl border border-good-ink py-3.5 active:opacity-70"
          onPress={() => router.push((resultsHref ?? resultsHrefFor(race)) as never)}
        >
          <Text className="text-sm font-bold text-good-ink">
            {isCompleted(race) ? 'Review the results' : 'Live results'}
          </Text>
        </Pressable>
      </View>

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
