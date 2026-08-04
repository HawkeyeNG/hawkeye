import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { InfoDot } from '@/components/info-dot';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';

/**
 * Races — the all-races selector, native twin of app/races.html. This is where
 * every contest Hawkeye watches lives, in canonical order. A race is "live" only
 * once its own screen exists (published about 28 days before its election); the
 * rest say so on tap rather than dead-ending. Reached from the More menu's Races
 * accordion ("All Races").
 */
type Race = { name: string; desc: string; href?: string; pill?: string };

const RACES: Race[] = [
  {
    // `<race> (<year>)` — the app-wide naming convention. The entries below it
    // are race CATEGORIES spanning many states and years, so they stay bare and
    // carry their year in the pill instead.
    name: 'Presidency (2027)',
    desc: 'The declared presidential field, quick compare and live results.',
    href: '/candidates',
    pill: 'Live',
  },
  {
    name: 'Governorship',
    desc: 'Osun 2026 is live now. Other states open closer to each election.',
    href: '/osun',
    pill: 'Osun 2026',
  },
  { name: 'Senate', desc: '109 seats across 36 states and the FCT.' },
  { name: 'House of Representatives', desc: '360 federal constituencies.' },
  { name: 'State Houses of Assembly', desc: 'The 36 state legislatures.' },
];

const SOON =
  'This race becomes available closer to the election — we publish each race page about 28 days out. Follow the presidency or Osun 2026 in the meantime.';

export default function Races() {
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [soonOpen, setSoonOpen] = useState<string | null>(null);

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Races" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        <Text className="text-2xl font-bold text-ink">Races</Text>
        <View className="flex-row items-center pt-1">
          <Text className="flex-1 text-sm text-muted">
            Pick a race to follow, report on, or verify.
          </Text>
          <InfoDot
            title="Why some races say “Soon”"
            text="Each race's page is published as its election nears — roughly 28 days out — so a race without a page yet simply isn't open for reporting. Listed in order: Presidency, Governorship, Senate, House of Representatives, State Assembly."
          />
        </View>

        <View className="pt-4">
          {RACES.map((r) => {
            const live = !!r.href;
            const open = soonOpen === r.name;
            return (
              <Pressable
                key={r.name}
                onPress={() => (live ? router.push(r.href as never) : setSoonOpen(open ? null : r.name))}
                className="mb-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-80"
              >
                <View className="flex-1 pr-3">
                  <Text className="text-base font-bold text-ink">{r.name}</Text>
                  <Text className="pt-0.5 text-xs text-muted">{r.desc}</Text>
                  {!live && open ? (
                    <Text className="pt-2 text-xs font-semibold text-warn-ink">{SOON}</Text>
                  ) : null}
                </View>
                {live ? (
                  <View className="flex-row items-center">
                    <View className="rounded-full bg-hawk-green px-3 py-1">
                      <Text className="text-xs font-bold text-hawk-gold">{r.pill}</Text>
                    </View>
                    <Feather name="chevron-right" size={18} color={ui.faint} style={{ marginLeft: 2 }} />
                  </View>
                ) : (
                  <View className="rounded-full border border-line px-3 py-1">
                    <Text className="text-xs font-semibold text-muted">Soon</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </Animated.ScrollView>
    </View>
  );
}
