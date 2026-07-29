import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PartyMark } from '@/components/race';
import { useUi } from '@/lib/theme';
import { loadPolitical, partyColor, partyName, type Political } from '@/lib/political';

/**
 * Political Data — who holds power now: the incumbents this election confirms
 * or unseats.
 *
 * The web page draws a choropleth of Nigeria; here the same fact is a grouped
 * list (party → its states), which reads better on a phone than a map you have
 * to pinch, and carries the count the map only implies.
 */
export default function PoliticalData() {
  const ui = useUi();
  const [d, setD] = useState<Political | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadPolitical()
      .then(({ data, logos: l }) => {
        setD(data);
        setLogos(l);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // FCT is in the register with a null party — it has a minister, not a
  // governor. Grouping it under "null" is worse than saying so.
  const byParty = (() => {
    const g: Record<string, string[]> = {};
    const none: string[] = [];
    for (const [state, party] of Object.entries(d?.governors ?? {})) {
      if (party) (g[party] ??= []).push(state);
      else none.push(state);
    }
    return { groups: Object.entries(g).sort((a, b) => b[1].length - a[1].length), none };
  })();

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-card"
        >
          <Feather name="x" size={18} color={ui.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-ink">Political Data</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 pb-10 pt-3">
        <Text className="pb-3 text-sm text-muted">
          The parties in power now — the incumbents this election confirms or unseats.
        </Text>

        {err ? (
          <Text className="text-sm font-semibold text-warn-ink">Could not load. ({err})</Text>
        ) : !d ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : (
          <>
            {d.president ? (
              <View className="flex-row items-center rounded-2xl bg-card px-4 py-3">
                <PartyMark party={d.president.party} logos={logos} size={26} />
                <View className="flex-1 pl-3">
                  <Text className="text-sm font-bold text-ink">{d.president.name}</Text>
                  <Text className="text-xs text-muted">
                    Governing party:{' '}
                    <Text style={{ color: partyColor(d.president.party) }}>
                      {partyName(d.president.party)}
                    </Text>
                  </Text>
                </View>
              </View>
            ) : null}

            <Pressable
              className="mt-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-80"
              onPress={() => router.push('/candidates')}
            >
              <Feather name="users" size={17} color={ui.tint.good.ink} />
              <Text className="flex-1 pl-3 text-sm font-semibold text-ink">
                The 2027 Presidential Race — Full Profiles
              </Text>
              <Feather name="chevron-right" size={16} color={ui.faint} />
            </Pressable>

            {/* Seat composition per chamber, as a stacked party bar. */}
            {d.composition ? (
              <>
                <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                  Who holds power now
                </Text>
                {Object.entries(d.composition.chambers).map(([key, ch]) => {
                  const parties = Object.entries(ch.parties).sort((a, b) => b[1] - a[1]);
                  return (
                    <View key={key} className="mb-2 rounded-2xl bg-card px-4 py-3">
                      <View className="flex-row items-baseline">
                        <Text className="flex-1 text-sm font-bold text-ink">{ch.label}</Text>
                        <Text className="text-[11px] text-faint">
                          {ch.total}/{ch.size} seats declared
                        </Text>
                      </View>
                      <View className="mt-2 h-2.5 flex-row overflow-hidden rounded-full bg-surface">
                        {parties.map(([p, n]) => (
                          <View
                            key={p}
                            style={{
                              width: `${(n / ch.size) * 100}%`,
                              backgroundColor: partyColor(p),
                            }}
                          />
                        ))}
                      </View>
                      <View className="flex-row flex-wrap pt-2">
                        {parties.map(([p, n]) => (
                          <View key={p} className="mr-3 flex-row items-center pt-1">
                            <View
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: partyColor(p) }}
                            />
                            <Text className="pl-1 text-[11px] text-muted">
                              {p} {n}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  );
                })}
                {d.composition.note ? (
                  <Text className="pt-1 text-xs text-faint">
                    {d.composition.note}
                    {d.composition.asOf ? ` (as of ${d.composition.asOf})` : ''}
                  </Text>
                ) : null}
              </>
            ) : null}

            {/* Governing party by state — the map, as a list you can read. */}
            {byParty.groups.length ? (
              <>
                <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                  Governing party by state
                </Text>
                {byParty.groups.map(([party, sts]) => (
                  <View key={party} className="mb-2 rounded-2xl bg-card px-4 py-3">
                    <View className="flex-row items-center">
                      <PartyMark party={party} logos={logos} size={20} />
                      <Text
                        className="flex-1 pl-2 text-sm font-bold"
                        style={{ color: partyColor(party) }}
                      >
                        {partyName(party)}
                      </Text>
                      <Text className="text-xs font-semibold text-muted">
                        {sts.length} {sts.length === 1 ? 'state' : 'states'}
                      </Text>
                    </View>
                    <Text className="pt-1.5 text-xs text-muted">
                      {sts.sort().join(' · ')}
                    </Text>
                  </View>
                ))}
                {byParty.none.length ? (
                  <Text className="pt-1 text-xs text-faint">
                    {byParty.none.join(' · ')} — no governor (administered by a minister).
                  </Text>
                ) : null}
              </>
            ) : null}

            {d.upcoming ? (
              <>
                <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                  Upcoming elections
                </Text>
                <View className="overflow-hidden rounded-2xl bg-card">
                  {d.upcoming.elections.map((e, i) => (
                    <View
                      key={e.office}
                      className={`px-4 py-3 ${i > 0 ? 'border-t border-line' : ''}`}
                    >
                      <View className="flex-row items-baseline">
                        <Text className="flex-1 text-sm font-bold text-ink">{e.office}</Text>
                        <Text className="text-xs font-semibold text-good-ink">
                          {e.seats} seat(s)
                        </Text>
                      </View>
                      <Text className="pt-0.5 text-xs text-muted">
                        {e.when} · {e.scope}
                      </Text>
                    </View>
                  ))}
                </View>
                {d.upcoming.note ? (
                  <Text className="pt-2 text-xs text-faint">{d.upcoming.note}</Text>
                ) : null}
              </>
            ) : null}

            {d.note ? (
              <Text className="pt-4 text-xs text-faint">{d.note}</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
