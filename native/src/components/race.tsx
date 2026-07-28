import { router } from 'expo-router';
import { Image, Pressable, Text, View } from 'react-native';

import { logoUrl, partyColor, type Candidate, type Race } from '@/lib/political';

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
        className="items-center justify-center rounded-full bg-hawk-mist"
        style={{ width: size, height: size }}
      >
        <Text className="text-[8px] font-bold text-neutral-600">{party.slice(0, 3)}</Text>
      </View>
    );
  }
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
      className="mb-2 rounded-2xl bg-white px-4 py-3"
      style={{ borderLeftWidth: 4, borderLeftColor: partyColor(c.party) }}
    >
      <View className="flex-row items-center">
        {c.photo ? (
          <Image
            source={{ uri: c.photo }}
            className="h-11 w-11 rounded-full bg-hawk-mist"
            resizeMode="cover"
          />
        ) : (
          <View className="h-11 w-11 items-center justify-center rounded-full bg-hawk-mist">
            <Text className="text-xs font-bold text-neutral-500">{c.initials ?? ''}</Text>
          </View>
        )}
        <View className="flex-1 pl-3">
          <View className="flex-row items-center">
            <PartyMark party={c.party} logos={logos} size={14} />
            <Text className="pl-1 text-[11px] font-bold" style={{ color: partyColor(c.party) }}>
              {c.party}
            </Text>
            {c.incumbent ? (
              <View className="ml-2 rounded-full bg-hawk-mist px-2 py-0.5">
                <Text className="text-[9px] font-bold text-hawk-leaf">INCUMBENT</Text>
              </View>
            ) : null}
          </View>
          <Text className="pt-0.5 text-base font-bold text-hawk-ink">{c.name}</Text>
        </View>
      </View>
      {c.line ? <Text className="pt-2 text-sm text-neutral-600">{c.line}</Text> : null}
      <View className="pt-2">
        {[
          ['Home base', c.home],
          ['Bid', c.bids],
          ['Status', c.status],
        ].map(([k, v]) => (
          <View key={k} className="flex-row py-0.5">
            <Text className="w-24 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              {k}
            </Text>
            <Text className="flex-1 text-xs text-neutral-600">{v || '—'}</Text>
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
  const ballot = race.others
    ? [...race.candidates, ...race.others].sort((a, b) => a.party.localeCompare(b.party))
    : null;

  return (
    <View>
      <Text className="text-xl font-bold text-hawk-ink">{race.office || race.election}</Text>
      {dateStr ? <Text className="pt-0.5 text-sm text-neutral-500">{dateStr}</Text> : null}

      {race.stats ? (
        <View className="mt-3 flex-row rounded-2xl bg-white px-2 py-3">
          {[
            [race.stats.candidates, 'Candidates'],
            [race.stats.lgas, 'LGAs'],
            [race.stats.pollingUnits ? `~${race.stats.pollingUnits.toLocaleString()}` : null, 'Units'],
          ]
            .filter(([n]) => n != null)
            .map(([n, l]) => (
              <View key={String(l)} className="flex-1 items-center">
                <Text className="text-lg font-bold text-hawk-ink">{n}</Text>
                <Text className="text-[10px] text-neutral-500">{l}</Text>
              </View>
            ))}
        </View>
      ) : null}

      {race.incumbentNote ? (
        <View className="mt-3 rounded-2xl bg-hawk-mist px-4 py-3">
          <Text className="text-sm text-neutral-700">{race.incumbentNote}</Text>
        </View>
      ) : null}

      <Text className="pb-1 pt-5 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
        {race.others ? 'Front-runners' : 'Declared candidates'}
      </Text>
      <Text className="pb-2 text-xs text-neutral-500">
        Alphabetical by party. Not an endorsement or a prediction.
      </Text>
      {race.candidates.map((c) => (
        <CandidateCard key={`${c.party}-${c.name}`} c={c} logos={logos} />
      ))}

      {ballot ? (
        <>
          <Text className="pb-2 pt-3 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
            Full ballot — {ballot.length} candidates
          </Text>
          <View className="overflow-hidden rounded-2xl bg-white">
            {ballot.map((c, i) => (
              <View
                key={`${c.party}-${c.name}`}
                className={`flex-row items-center px-4 py-2.5 ${i > 0 ? 'border-t border-hawk-mist' : ''}`}
              >
                <PartyMark party={c.party} logos={logos} />
                <Text className="flex-1 pl-3 text-sm text-hawk-ink">{c.name}</Text>
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
          <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
            Other declared candidates
          </Text>
          <View className="overflow-hidden rounded-2xl bg-white">
            {race.minors.map((m, i) => (
              <View
                key={`${m.party}-${m.name}`}
                className={`flex-row items-center px-4 py-2.5 ${i > 0 ? 'border-t border-hawk-mist' : ''}`}
              >
                <PartyMark party={m.party} logos={logos} />
                <View className="flex-1 pl-3">
                  <Text className="text-sm text-hawk-ink">{m.name}</Text>
                  {m.meta ? <Text className="text-[11px] text-neutral-500">{m.meta}</Text> : null}
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
        <Text className="pt-3 text-sm italic text-neutral-500">{race.notableAbsence}</Text>
      ) : null}

      <View className="flex-row pt-5">
        <Pressable
          className="mr-2 flex-1 items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80"
          onPress={() => router.push('/report/result')}
        >
          <Text className="text-sm font-bold text-hawk-gold">Become an observer</Text>
        </Pressable>
        <Pressable
          className="flex-1 items-center rounded-2xl border border-hawk-green py-3.5 active:opacity-70"
          onPress={() => router.push((resultsHref ?? '/(tabs)/results') as never)}
        >
          <Text className="text-sm font-bold text-hawk-green">Live results</Text>
        </Pressable>
      </View>

      {[race.note, race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit]
        .filter(Boolean)
        .join(' ') ? (
        <Text className="pt-4 text-xs text-neutral-400">
          {[race.note, race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit]
            .filter(Boolean)
            .join(' ')}
        </Text>
      ) : null}
    </View>
  );
}
