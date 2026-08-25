import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Text, View } from 'react-native';

import { RaceActions, RaceView, hasRaceActions } from '@/components/race';
import { PinnedFooter } from '@/components/pinned-footer';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';
import { loadPolitical, type Race } from '@/lib/political';
import { humanError } from '@/lib/errors';
import { GovDisclaimer } from '@/components/gov-disclaimer';

/** Osun 2026 — Hawkeye's first live pilot election. */
export default function Osun() {
  const ui = useUi();
  const [race, setRace] = useState<Race | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadPolitical()
      .then(({ data, logos: l }) => {
        setRace(data.raceOsun2026 ?? null);
        setLogos(l);
      })
      .catch((e) => setErr(humanError(e)));
  }, []);

  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Osun 2026" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        {/* The "official results remain INEC's" card is gone — the disclaimer
            bar immediately above it now carries exactly that claim. */}
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
          Osun is a completed race and not the presidency, so it now has NO
          actions: nothing to report, and the page is its own result. Asking
          hasRaceActions rather than mounting an empty bar — PinnedFooter draws
          its border and inset around whatever it is handed, so the alternative
          is a stripe of chrome pinned to the screen advertising nothing. */}
      {race && hasRaceActions(race) ? (
        <PinnedFooter><RaceActions race={race} /></PinnedFooter>
      ) : null}
    </View>
  );
}
