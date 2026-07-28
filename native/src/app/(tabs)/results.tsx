import { FlashList } from '@shopify/flash-list';
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, type National, type Party } from '@/lib/api';

type Row = { party: string; name: string; votes: number; share: number };

/** Results — the national leaderboard on FlashList. Native twin of results.html. */
export default function Results() {
  const [data, setData] = useState<National | null>(null);
  const [parties, setParties] = useState<Party[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [n, p] = await Promise.all([api.national('GOV'), api.parties()]);
    setData(n);
    setParties(p);
  };

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const rows: Row[] = useMemo(() => {
    if (!data?.national?.length) return [];
    const total = data.national.reduce((s, r) => s + r.votes, 0) || 1;
    const names = new Map(parties.map((p) => [p.code, p.name]));
    return data.national.map((r) => ({
      party: r.party,
      name: names.get(r.party) ?? r.party,
      votes: r.votes,
      share: r.votes / total,
    }));
  }, [data, parties]);

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist" edges={['top']}>
      <View className="px-4 pb-2 pt-4">
        <Text className="text-2xl font-bold text-hawk-ink">Results</Text>
        <Text className="text-sm text-neutral-600">
          Osun Governorship 2026 · {data?.unitsReporting ?? 0} units reporting
        </Text>
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.party}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load().catch(() => {});
              setRefreshing(false);
            }}
          />
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListEmptyComponent={
          <View className="mt-6 items-center rounded-2xl bg-white px-6 py-10">
            <Text className="text-base font-semibold text-hawk-ink">No results yet</Text>
            <Text className="pt-1 text-center text-sm text-neutral-500">
              Reporting opens on election day, 15 August. Accepted reports appear here
              live, ranked by verified votes.
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <View className="mb-2 flex-row items-center rounded-2xl bg-white px-4 py-3">
            <Text className="w-7 text-base font-bold text-neutral-400">{index + 1}</Text>
            <View className="flex-1 pr-3">
              <Text className="text-base font-semibold text-hawk-ink">{item.party}</Text>
              <Text className="text-xs text-neutral-500" numberOfLines={1}>
                {item.name}
              </Text>
              <View className="mt-1 h-1.5 overflow-hidden rounded-full bg-hawk-mist">
                <View
                  className="h-1.5 rounded-full bg-hawk-leaf"
                  style={{ width: `${Math.max(2, Math.round(item.share * 100))}%` }}
                />
              </View>
            </View>
            <Text className="text-base font-bold text-hawk-ink">
              {item.votes.toLocaleString()}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
