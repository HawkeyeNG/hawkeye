import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, type Contest, type IntegritySummary } from '@/lib/api';

function daysUntil(iso: string) {
  const ms = new Date(`${iso}T00:00:00+01:00`).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Home — the live contest card plus trust stats, from the same public API the site uses. */
export default function Home() {
  const [contests, setContests] = useState<Contest[] | null>(null);
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const [c, i] = await Promise.all([api.contests(), api.integrity()]);
      setContests(c);
      setIntegrity(i);
    } catch {
      setError('Could not reach hawkeye.com.ng — check your connection.');
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist" edges={['top']}>
      <ScrollView
        contentContainerClassName="px-4 pb-8"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <Text className="pb-1 pt-4 text-2xl font-bold text-hawk-ink">Hawkeye</Text>
        <Text className="pb-4 text-sm text-neutral-600">
          Independent election observation — every report public, signed and verifiable.
        </Text>

        {error ? (
          <View className="mb-3 rounded-2xl bg-amber-100 px-4 py-3">
            <Text className="text-sm text-amber-900">{error}</Text>
          </View>
        ) : null}

        {contests?.map((c) => (
          <View key={c.code} className="mb-3 overflow-hidden rounded-3xl bg-hawk-green">
            <View className="px-5 pb-4 pt-5">
              <Text className="text-xs font-semibold uppercase tracking-wider text-hawk-gold">
                {c.open ? 'Reporting open' : 'Upcoming election'}
              </Text>
              <Text className="pt-1 text-xl font-bold text-white">{c.election}</Text>
              <Text className="pt-1 text-sm text-emerald-100">
                {new Date(`${c.date}T12:00:00`).toLocaleDateString('en-GB', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            </View>
            <View className="flex-row items-center justify-between bg-[#00351e] px-5 py-3">
              <Text className="text-sm font-semibold text-hawk-gold">
                {c.open ? 'Report from your polling unit now' : `Opens in ${daysUntil(c.date)} days`}
              </Text>
            </View>
          </View>
        ))}

        <View className="flex-row gap-3">
          <View className="flex-1 rounded-2xl bg-white px-4 py-4">
            <Text className="text-2xl font-bold text-hawk-ink">{integrity?.reports ?? '—'}</Text>
            <Text className="text-xs text-neutral-500">Accepted reports</Text>
          </View>
          <View className="flex-1 rounded-2xl bg-white px-4 py-4">
            <Text className="text-2xl font-bold text-hawk-ink">{integrity?.unitsFlagged ?? '—'}</Text>
            <Text className="text-xs text-neutral-500">Units flagged</Text>
          </View>
        </View>

        <View className="mt-3 rounded-2xl bg-white px-4 py-4">
          <Text className="text-base font-semibold text-hawk-ink">How it works</Text>
          <Text className="pt-1 text-sm leading-5 text-neutral-600">
            Photograph the result sheet at your polling unit. Your report is GPS-checked,
            signed on your device, and chained into a public ledger no one — including us —
            can silently edit. Hawkeye never declares results; INEC does.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
