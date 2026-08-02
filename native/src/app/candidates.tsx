import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, Text, View } from 'react-native';

import { PartyMark, RaceView } from '@/components/race';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';
import { loadPolitical, partyColor, type Race } from '@/lib/political';

/** 2027 Candidates — the declared presidential field, plus the side-by-side
 *  compare the web page carries (kept, scrolled horizontally, not dropped). */
export default function Candidates() {
  const ui = useUi();
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

  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Presidency 2027" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        {err ? (
          <Text className="text-sm font-semibold text-warn-ink">Could not load. ({err})</Text>
        ) : !race ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : (
          <>
            <RaceView race={race} logos={logos} />

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
                    <Text
                      className="pr-2 text-xs font-bold text-ink"
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
                        className="pr-2 text-xs text-muted"
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
      </Animated.ScrollView>
    </View>
  );
}
