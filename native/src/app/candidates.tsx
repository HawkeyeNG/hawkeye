import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PartyMark, RaceView } from '@/components/race';
import { BRAND } from '@/lib/api';
import { loadPolitical, partyColor, type Race } from '@/lib/political';

/** 2027 Candidates — the declared presidential field, plus the side-by-side
 *  compare the web page carries (kept, scrolled horizontally, not dropped). */
export default function Candidates() {
  const [race, setRace] = useState<Race | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadPolitical()
      .then(({ data, logos: l }) => {
        setRace(data.race2027 ?? null);
        setLogos(l);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-white"
        >
          <Feather name="x" size={18} color={BRAND.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-hawk-ink">2027 Candidates</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 pb-10 pt-3">
        {err ? (
          <Text className="text-sm font-semibold text-amber-800">Could not load. ({err})</Text>
        ) : !race ? (
          <ActivityIndicator className="pt-6" color={BRAND.leaf} />
        ) : (
          <>
            <RaceView race={race} logos={logos} />

            <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              Quick compare
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="overflow-hidden rounded-2xl bg-white">
                <View className="flex-row bg-hawk-mist px-3 py-2">
                  {['Candidate', 'Party', 'Home base', 'Bid', 'Status'].map((h, i) => (
                    <Text
                      key={h}
                      className="text-[10px] font-bold uppercase tracking-wide text-neutral-500"
                      style={{ width: i === 0 ? 150 : 120 }}
                    >
                      {h}
                    </Text>
                  ))}
                </View>
                {race.candidates.map((c, i) => (
                  <View
                    key={`${c.party}-${c.name}`}
                    className={`flex-row px-3 py-2.5 ${i > 0 ? 'border-t border-hawk-mist' : ''}`}
                  >
                    <Text
                      className="pr-2 text-xs font-bold text-hawk-ink"
                      style={{ width: 150 }}
                    >
                      {c.name}
                    </Text>
                    <View className="flex-row items-center" style={{ width: 120 }}>
                      <PartyMark party={c.party} logos={logos} size={14} />
                      <Text
                        className="pl-1 text-xs font-bold"
                        style={{ color: partyColor(c.party) }}
                      >
                        {c.party}
                      </Text>
                    </View>
                    {[c.home, c.bids, c.status].map((v, j) => (
                      <Text
                        key={j}
                        className="pr-2 text-xs text-neutral-600"
                        style={{ width: 120 }}
                      >
                        {v || '—'}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
