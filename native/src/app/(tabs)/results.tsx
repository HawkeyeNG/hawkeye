import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, BRAND, type Contest, type National, type Party } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import * as SecureStore from 'expo-secure-store';

const BASE = 'https://hawkeye.com.ng';
const REFRESH_MS = 30_000;

type Row = { party: string; name: string; votes: number; share: number };
type Gaps = { contest: string; statesTotal: number; statesReported: number; missing: string[] };
type Sub = { contest: string; state?: string };

/**
 * Results — the national leaderboard, native twin of results.html.
 *
 * Two things here are not decoration. The board refreshes on a stated cadence
 * and says when it last did, because a stale tally that looks live is worse
 * than no tally. And the "not official" line sits ON the board rather than in a
 * footer: a leaderboard without it reads as a declaration, which is the one
 * thing Hawkeye must never look like.
 */
export default function Results() {
  const auth = useAuth();
  const [contest, setContest] = useState<Contest | null>(null);
  const [data, setData] = useState<National | null>(null);
  const [parties, setParties] = useState<Party[]>([]);
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const cs = await api.contests().catch(() => [] as Contest[]);
    const c = cs[0] ?? null;
    setContest(c);
    if (!c) return;
    const [n, p, g] = await Promise.all([
      api.national(c.code).catch(() => null),
      api.parties().catch(() => [] as Party[]),
      fetch(`${BASE}/api/coverage/gaps?contest=${c.code}`)
        .then((r) => (r.ok ? (r.json() as Promise<Gaps>) : null))
        .catch(() => null),
    ]);
    if (n) setData(n);
    if (p.length) setParties(p);
    setGaps(g);
    setUpdatedAt(Date.now());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // Which races this observer already follows, so the control can say "Following".
  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setSubs([]);
      return;
    }
    authedGet<{ subscriptions?: Sub[] }>('/api/observers/me')
      .then((me) => setSubs(me.subscriptions ?? []))
      .catch(() => {});
  }, [auth.status]);

  const following = useMemo(
    () => !!contest && subs.some((s) => s.contest === contest.code),
    [subs, contest],
  );

  const toggleFollow = async () => {
    if (!contest) return;
    if (auth.status !== 'signedIn') {
      router.push('/sign-in');
      return;
    }
    setBusy(true);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const id = await getIdentity();
      const res = await fetch(`${BASE}/api/subscriptions`, {
        method: following ? 'DELETE' : 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify({ contest: contest.code, state: '' }),
      });
      if (!res.ok) {
        Alert.alert('Could not update', `Try again. (HTTP ${res.status})`);
        return;
      }
      setSubs((s) =>
        following ? s.filter((x) => x.contest !== contest.code) : [...s, { contest: contest.code }],
      );
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  const header = (
    <View>
      {/* On the board, not in a footer: this is the claim the whole product
          depends on not being misread. */}
      <View className="mb-3 rounded-2xl bg-amber-100 px-4 py-3">
        <Text className="text-xs font-semibold text-amber-900">
          Tentative and unofficial. These are crowd-reported figures — only INEC declares
          official results.
        </Text>
      </View>

      {contest ? (
        <Pressable
          disabled={busy}
          onPress={toggleFollow}
          className={`mb-3 flex-row items-center rounded-2xl px-4 py-3 active:opacity-80 ${
            following ? 'bg-card' : 'bg-hawk-green'
          }`}
        >
          {busy ? (
            <ActivityIndicator color={following ? BRAND.leaf : BRAND.gold} />
          ) : (
            <Feather
              name={following ? 'bell' : 'bell-off'}
              size={16}
              color={following ? BRAND.leaf : BRAND.gold}
            />
          )}
          <Text
            className={`flex-1 pl-3 text-sm font-bold ${
              following ? 'text-hawk-leaf' : 'text-hawk-gold'
            }`}
          >
            {following ? 'Following this race' : 'Follow this race'}
          </Text>
          <Text className={`text-xs ${following ? 'text-faint' : 'text-emerald-200'}`}>
            {following ? 'Alerts on' : 'Get alerts on every report'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  const footer =
    gaps && gaps.missing.length ? (
      <View className="mt-4 rounded-2xl bg-card px-4 py-4">
        <Text className="text-sm font-bold text-ink">Help cover these states</Text>
        <Text className="pt-1 text-xs text-muted">
          {gaps.statesReported} of {gaps.statesTotal} states have reports so far. Nothing has
          come in from:
        </Text>
        <Text className="pt-2 text-xs text-muted">{gaps.missing.join(' · ')}</Text>
        <Pressable
          className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
          onPress={() => router.push('/report/result')}
        >
          <Text className="text-sm font-bold text-hawk-gold">Report from your unit</Text>
        </Pressable>
      </View>
    ) : null;

  return (
    <SafeAreaView className="flex-1 bg-surface" edges={['top']}>
      <View className="px-4 pb-2 pt-4">
        <Text className="text-2xl font-bold text-ink">Results</Text>
        <Text className="text-sm text-muted">
          {contest?.election ?? 'Loading…'} · {data?.unitsReporting ?? 0} unit(s) reporting
          {updatedAt
            ? ` · updated ${new Date(updatedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}`
            : ''}
        </Text>
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.party}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
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
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListEmptyComponent={
          <View className="mt-2 items-center rounded-2xl bg-card px-6 py-10">
            <Text className="text-base font-semibold text-ink">No results yet</Text>
            <Text className="pt-1 text-center text-sm text-muted">
              Accepted reports appear here live, ranked by verified votes.
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <View className="mb-2 flex-row items-center rounded-2xl bg-card px-4 py-3">
            <Text className="w-7 text-base font-bold text-faint">{index + 1}</Text>
            <View className="flex-1 pr-3">
              <Text className="text-base font-semibold text-ink">{item.party}</Text>
              <Text className="text-xs text-muted" numberOfLines={1}>
                {item.name}
              </Text>
              <View className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
                <View
                  className="h-1.5 rounded-full bg-hawk-leaf"
                  style={{ width: `${Math.max(2, Math.round(item.share * 100))}%` }}
                />
              </View>
            </View>
            <View className="items-end">
              <Text className="text-base font-bold text-ink">
                {item.votes.toLocaleString()}
              </Text>
              <Text className="text-[11px] text-faint">
                {Math.round(item.share * 100)}%
              </Text>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
