import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RaceView } from '@/components/race';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';
import { loadPolitical, type Race } from '@/lib/political';

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
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

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
        <Text className="pl-3 text-lg font-bold text-ink">Osun 2026</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 pb-10 pt-3">
        <View className="mb-3 rounded-xl bg-hawk-green px-3 py-2">
          <Text className="text-xs font-semibold text-hawk-gold">
            First live pilot — we monitor and publish; official results remain INEC&apos;s.
          </Text>
        </View>
        {err ? (
          <Text className="text-sm font-semibold text-amber-800">Could not load. ({err})</Text>
        ) : !race ? (
          <ActivityIndicator className="pt-6" color={BRAND.leaf} />
        ) : (
          <RaceView race={race} logos={logos} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
