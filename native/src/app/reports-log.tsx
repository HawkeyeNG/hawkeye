import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';

const BASE = 'https://hawkeye.com.ng';
const REFRESH_MS = 30_000;

type Vote = { party: string; count: number };

type Row = {
  puCode: string;
  contest: string;
  name: string;
  ward: string | null;
  lga: string | null;
  state: string | null;
  scope: string | null;
  votes: Vote[];
  confidence: number;
  matchingReports: number;
  totalReports: number;
  status: string;
  disputed: boolean;
  locationStatus: 'verified' | 'provisional' | 'unverified';
  locationConfidence: number | null;
  locationPlausibility: string | null;
  locationScore: number | null;
  venueMatches: number;
};

type Ledger = { ok: boolean; entries: number; head: string | null; brokenAtId?: number };

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The location evidence line — the part that separates a claim from a proof. */
function locationLine(r: Row) {
  const head =
    r.locationStatus === 'verified'
      ? '📍 location verified'
      : r.locationStatus === 'provisional'
        ? `◌ crowd-confirmed location (${r.locationConfidence}% of reports agree)`
        : `⚠ location unverified (${r.locationConfidence ?? 0}% GPS agreement)`;
  const venue =
    r.venueMatches > 0
      ? ` · 🏫 ${r.venueMatches} venue photo pair${r.venueMatches > 1 ? 's' : ''} match`
      : '';
  const clash =
    r.locationPlausibility === 'inconsistent'
      ? ' · ⚠ GPS reports contradict this unit’s expected area'
      : '';
  const score = r.locationScore != null ? ` · location evidence ${r.locationScore}/100` : '';
  return head + venue + clash + score;
}

/**
 * Public Reports Log — native twin of app/dashboard.html.
 *
 * Every accepted report, unit by unit, with the two things that make it worth
 * anything: how many independent observers agree on the same numbers, and how
 * well the reporters' locations were proven. Refreshes on the same 30s cadence
 * as the web page, and pulls to refresh because a phone should.
 */
export default function ReportsLog() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([
        jget<Row[]>('/api/results'),
        jget<Ledger>('/api/ledger/verify'),
      ]);
      setRows(r);
      setLedger(l);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const header = (
    <View className="px-4 pb-3 pt-3">
      <Text className="pb-3 text-sm text-neutral-600">
        Confidence is the share of independent observers reporting the same numbers. Every
        report is digitally signed and permanently recorded on a public, tamper-evident ledger.
      </Text>

      {/* The ledger verdict belongs here too — and tapping it goes to the screen
          where the phone rechecks the chain itself rather than believing this line. */}
      <Pressable
        className="flex-row items-center rounded-2xl bg-white px-4 py-3 active:opacity-80"
        onPress={() => router.push('/ledger')}
      >
        {!ledger ? (
          <Text className="flex-1 text-sm text-neutral-500">Checking ledger integrity…</Text>
        ) : ledger.ok ? (
          <>
            <Feather name="shield" size={16} color={BRAND.leaf} />
            <Text className="flex-1 pl-2 text-sm font-semibold text-hawk-leaf">
              Ledger intact — {ledger.entries} {ledger.entries === 1 ? 'entry' : 'entries'}
            </Text>
          </>
        ) : (
          <>
            <Feather name="alert-triangle" size={16} color="#b91c1c" />
            <Text className="flex-1 pl-2 text-sm font-semibold text-red-700">
              Ledger tampered (entry {ledger.brokenAtId})
            </Text>
          </>
        )}
        <Feather name="chevron-right" size={16} color="#9db5a7" />
      </Pressable>

      {err ? (
        <Text className="pt-2 text-sm font-semibold text-amber-800">
          Could not refresh. ({err})
        </Text>
      ) : null}
    </View>
  );

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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Public Reports Log</Text>
      </View>

      <FlashList
        data={rows ?? []}
        keyExtractor={(r) => `${r.puCode}|${r.contest}`}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.leaf} />
        }
        ListEmptyComponent={
          rows === null ? (
            <ActivityIndicator className="pt-6" color={BRAND.leaf} />
          ) : (
            <Text className="px-4 pt-2 text-sm text-neutral-500">
              No reports yet — this fills up as observers submit from polling units.
            </Text>
          )
        }
        renderItem={({ item: r }) => {
          const bad = r.status === 'disputed' || r.disputed;
          const counted = r.votes.filter((v) => v.count > 0);
          return (
            <View className="mx-4 mb-2 rounded-2xl bg-white px-4 py-3">
              <Text className="text-base font-bold text-hawk-ink">{r.name}</Text>
              <Text className="pt-0.5 text-xs text-neutral-500">
                [{r.contest}] {r.puCode} · {[r.ward, r.lga, r.state].filter(Boolean).join(', ')}
                {r.contest !== 'PRES' && r.scope ? ` · ${r.scope}` : ''}
              </Text>

              <View className="mt-2 h-2 overflow-hidden rounded-full bg-hawk-mist">
                <View
                  className={`h-full ${bad ? 'bg-red-600' : 'bg-hawk-green'}`}
                  style={{ width: `${Math.max(0, Math.min(100, r.confidence))}%` }}
                />
              </View>

              <Text className="pt-1.5 text-sm text-neutral-700">
                <Text className={`font-bold ${bad ? 'text-red-700' : 'text-hawk-leaf'}`}>
                  {r.status.toUpperCase()}
                </Text>
                {` · ${r.confidence}% confidence · ${r.matchingReports}/${r.totalReports} matching reports`}
              </Text>

              <Text className="pt-1 text-xs text-neutral-500">{locationLine(r)}</Text>
              <Text className="pt-1 text-xs text-neutral-500">
                {counted.map((v) => `${v.party} ${v.count}`).join(' · ') || 'all zero'}
              </Text>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}
