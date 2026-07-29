import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusChip, TallyBar, type Tally } from '@/components/tally';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

const BASE = 'https://hawkeye.com.ng';

type Case = {
  id: number;
  puCode: string;
  contest: string;
  status: string;
  openedAt: number;
  closesAt: number;
  resolvedAt: number | null;
  tally: Tally;
  name: string | null;
  ward: string | null;
  lga: string | null;
  state: string | null;
};

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '');

/**
 * Public Docket — native twin of app/docket.html.
 *
 * A flag never decides anything; it opens a case. Cases are published with
 * their evidence and judged by verified observers answering factual questions,
 * with quorum and a supermajority resolving them. Nobody at Hawkeye votes.
 */
export default function Docket() {
  const ui = useUi();
  const [cases, setCases] = useState<Case[] | null>(null);
  const [rule, setRule] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/docket`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { rule: string; cases: Case[] };
      setRule(d.rule);
      setCases(d.cases);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const header = (
    <View className="px-4 pb-2 pt-3">
      <View className="mb-3 rounded-xl bg-amber-100 px-3 py-2">
        <Text className="text-xs font-semibold text-amber-900">
          Public Docket — flagged results, judged by the crowd. Nobody at Hawkeye decides.
        </Text>
      </View>
      <Text className="text-sm text-muted">
        When automated checks flag a result, the flag never decides anything — it opens a case.
        Every case is published here with its full evidence, and verified observers worldwide
        judge it by answering factual questions. Quorum and a supermajority resolve it, every
        verdict is on the public record, and the whole docket is anchored to a public
        transparency log.
      </Text>
      {rule ? (
        <Text className="pt-2 text-xs text-muted">Resolution rule: {rule}</Text>
      ) : null}
      {err ? (
        <Text className="pt-2 text-sm font-semibold text-amber-800">
          Could not load the docket. ({err})
        </Text>
      ) : null}
    </View>
  );

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
        <Text className="pl-3 text-lg font-bold text-ink">Public Docket</Text>
      </View>

      <FlashList
        data={cases ?? []}
        keyExtractor={(c) => String(c.id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={BRAND.leaf}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          cases === null ? (
            err ? null : <ActivityIndicator className="pt-6" color={BRAND.leaf} />
          ) : (
            <Text className="px-4 pt-2 text-center text-sm text-muted">
              No cases — no results are currently in dispute.
            </Text>
          )
        }
        renderItem={({ item: c }) => (
          <Pressable
            className="mx-4 mb-2 rounded-2xl bg-card px-4 py-3 active:opacity-80"
            onPress={() => router.push(`/case?id=${c.id}`)}
          >
            <View className="flex-row items-start">
              <Text className="flex-1 pr-2 text-base font-bold text-ink">
                {c.name || c.puCode} — {c.contest}
              </Text>
              <StatusChip status={c.status} />
            </View>
            <Text className="pt-1 text-xs text-muted">
              {[c.ward ? `${c.ward} ward` : null, c.lga, c.state].filter(Boolean).join(', ')} ·
              opened {when(c.openedAt)} ·{' '}
              {c.status === 'open'
                ? `closes ${when(c.closesAt)}`
                : `resolved ${when(c.resolvedAt ?? c.closesAt)}`}{' '}
              · {c.tally.total} verdict(s)
            </Text>
            <TallyBar t={c.tally} />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
