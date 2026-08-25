import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import { InfoDot } from '@/components/info-dot';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
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
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();
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
      setErr(humanError(e));
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
      <View className="flex-row items-center pb-3">
        <Text className="flex-1 text-sm text-muted">
          Confidence is the share of independent observers reporting the same numbers.
        </Text>
        <InfoDot
          title="How these reports are held"
          text="Every report is digitally signed on the observer's own device and permanently recorded on a public, tamper-evident ledger, so it cannot be edited or removed after the fact. Confidence rises as independent observers at the same unit file matching numbers."
        />
      </View>

      {/* The ledger verdict belongs here too — and tapping it goes to the screen
          where the phone rechecks the chain itself rather than believing this line. */}
      <Pressable
        className="flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80"
        onPress={() => router.push('/ledger')}
      >
        {!ledger ? (
          <Text className="flex-1 text-sm text-muted">Checking ledger integrity…</Text>
        ) : ledger.ok ? (
          <>
            <Feather name="shield" size={16} color={ui.tint.good.ink} />
            <Text className="flex-1 pl-2 text-sm font-semibold text-good-ink">
              Ledger intact — {ledger.entries} {ledger.entries === 1 ? 'entry' : 'entries'}
            </Text>
          </>
        ) : (
          <>
            <Feather name="alert-triangle" size={16} color={ui.tint.bad.ink} />
            <Text className="flex-1 pl-2 text-sm font-semibold text-bad-ink">
              Ledger tampered (entry {ledger.brokenAtId})
            </Text>
          </>
        )}
        <Feather name="chevron-right" size={16} color={ui.faint} />
      </Pressable>

      {err ? (
        <Text className="pt-2 text-sm font-semibold text-warn-ink">
          Could not refresh. ({err})
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Public Reports Log" translateY={translateY} onClose={() => router.back()} />
      <FlashList
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        data={rows ?? []}
        keyExtractor={(r) => `${r.puCode}|${r.contest}`}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingTop: headerH, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ui.tint.good.ink} />
        }
        ListEmptyComponent={
          rows === null ? (
            <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
          ) : (
            <Text className="px-4 pt-2 text-sm text-muted">
              No reports yet — this fills up as observers submit from polling units.
            </Text>
          )
        }
        renderItem={({ item: r }) => {
          const bad = r.status === 'disputed' || r.disputed;
          const counted = r.votes.filter((v) => v.count > 0);
          return (
            <View className="mx-4 mb-2 rounded-2xl bg-card px-4 py-3">
              <Text className="text-base font-bold text-ink">{r.name}</Text>
              <Text className="pt-0.5 text-xs text-muted">
                [{r.contest}] {r.puCode} · {[r.ward, r.lga, r.state].filter(Boolean).join(', ')}
                {r.contest !== 'PRES' && r.scope ? ` · ${r.scope}` : ''}
              </Text>

              {/* The filled segment reads against bg-surface in BOTH themes, so
                  it is an *-ink, not the brand green — bg-hawk-green on the dark
                  surface was a bar you could not see move. */}
              <View className="mt-2 h-2 overflow-hidden rounded-full bg-surface">
                <View
                  className={`h-full ${bad ? 'bg-bad-ink' : 'bg-good-ink'}`}
                  style={{ width: `${Math.max(0, Math.min(100, r.confidence))}%` }}
                />
              </View>

              <Text className="pt-1.5 text-sm text-ink">
                <Text className={`font-bold ${bad ? 'text-bad-ink' : 'text-good-ink'}`}>
                  {r.status.toUpperCase()}
                </Text>
                {` · ${r.confidence}% confidence · ${r.matchingReports}/${r.totalReports} matching reports`}
              </Text>

              <Text className="pt-1 text-xs text-muted">{locationLine(r)}</Text>
              <Text className="pt-1 text-xs text-muted">
                {counted.map((v) => `${v.party} ${v.count}`).join(' · ') || 'all zero'}
              </Text>
            </View>
          );
        }}
      />
    </View>
  );
}
