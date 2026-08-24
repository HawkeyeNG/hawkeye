import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Text, View } from 'react-native';

import { RaceActions, RaceView, hasRaceActions } from '@/components/race';
import { PinnedFooter } from '@/components/pinned-footer';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';
import { loadPolitical, type Race } from '@/lib/political';
import { GovDisclaimer } from '@/components/gov-disclaimer';

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
        <GovDisclaimer />
        {err ? (
          <Text className="text-sm font-semibold text-warn-ink">Could not load. ({err})</Text>
        ) : !race ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : (
          <RaceView race={race} logos={logos} />
        )}
      </Animated.ScrollView>
      {/* Sibling of the scroller, not a child — see components/pinned-footer.
          The presidential field is nineteen names; without this the page's only
          action sits below all of them. */}
      {race && hasRaceActions(race) ? <PinnedFooter><RaceActions race={race} /></PinnedFooter> : null}
    </View>
  );
}
