import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Text, View } from 'react-native';

import { GovDisclaimer } from '@/components/gov-disclaimer';
import { RaceView } from '@/components/race';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { api } from '@/lib/api';
import { findRace, loadPolitical, stateRace, type Race } from '@/lib/political';
import { useUi } from '@/lib/theme';

/**
 * One race, by route params. Native twin of app/race.html, and reached the same
 * two ways:
 *
 *   /race?key=raceOsun2026        a written race in political_data.json
 *   /race?contest=GOV&state=Kano  a governorship built from the register
 *
 * The second form is why every state has a screen without a file or a data block
 * each: the seat's map, size, holder and date are facts we already have, and the
 * one missing piece — the candidate list — is missing for a reason the screen
 * states plainly. A state that HAS a written race (Osun) resolves to it, so a
 * generated screen never shadows a real one.
 */
export default function RaceScreen() {
  const ui = useUi();
  const { key, contest, state } = useLocalSearchParams<{
    key?: string;
    contest?: string;
    state?: string;
  }>();
  const [race, setRace] = useState<Race | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data, logos: l } = await loadPolitical();
      if (!live) return;
      setLogos(l);
      if (contest === 'GOV' && state) {
        // Contests are the backend's to define; a screen is not the place to
        // decide when an election is. If the catalogue is unreachable the screen
        // still renders — undated, which is the truthful degradation.
        const cs = await api.contests().catch(() => []);
        if (!live) return;
        setRace(stateRace(data, state, cs.find((c) => c.code === 'GOV')));
      } else if (contest && state) {
        const hit = findRace(data, contest, state);
        setRace(hit ? hit.race : null);
      } else {
        setRace((data as Record<string, unknown>)[key || 'raceOsun2026'] as Race);
      }
      if (live) setDone(true);
    })().catch((e) => {
      if (live) {
        setErr(e instanceof Error ? e.message : String(e));
        setDone(true);
      }
    });
    return () => {
      live = false;
    };
  }, [key, contest, state]);

  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const title = race?.office || race?.election || 'Race';

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={title} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{
          paddingTop: headerH + 12,
          paddingHorizontal: 16,
          paddingBottom: 40,
        }}
      >
        <GovDisclaimer />
        {err ? (
          <Text className="text-sm font-semibold text-warn-ink">Could not load. ({err})</Text>
        ) : !done ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : race ? (
          <RaceView race={race} logos={logos} />
        ) : (
          // A race we have nothing for. Say so, rather than render an empty
          // frame that looks like a page still loading.
          <Text className="pt-4 text-sm text-muted">
            Hawkeye has no page for this race yet. Each race page is published as
            its election nears — about 28 days out.
          </Text>
        )}
      </Animated.ScrollView>
    </View>
  );
}
