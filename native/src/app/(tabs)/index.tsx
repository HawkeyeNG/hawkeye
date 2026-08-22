import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { BRAND, api, electionTitle, type Contest, type IntegritySummary } from '@/lib/api';
import { useUi, type Tone } from '@/lib/theme';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const REFRESH_MS = 30_000;

/**
 * Where an election card goes.
 *
 * The presidency has its own screen; a governorship confined to ONE state has a
 * per-state race screen; everything else (a nationwide governorship across 28
 * states, National Assembly, State Assembly) has no single page to open, so the
 * board for that contest is the honest destination — it is the screen that is
 * actually about that election.
 */
// Every branch ends in a query string, so the caller can append `&n=` without
// having to know which one it got.
function cardHref(c: Contest): string {
  if (c.code === 'PRES') return '/candidates?from=home';
  if (c.code === 'GOV' && c.states?.length === 1) {
    return `/race?contest=GOV&state=${encodeURIComponent(c.states[0])}`;
  }
  // The contest's OWN national board — all 37 states for a governorship, all 109
  // districts for the Senate. Without `scope` the results screen used to seed
  // itself with whichever seat sorted first, so every one of these cards landed
  // on Abia.
  return `/(tabs)/results?contest=${encodeURIComponent(c.code)}`;
}

/**
 * Seat magnitude: Presidency, Governorship, Senate, House of Representatives,
 * State Assembly — the order used everywhere else (races.html, the leaderboard
 * picker, menu.js:RACE_ORDER). /api/contests returns catalogue order, which put
 * the two National Assembly cards above the governorship here and nowhere else.
 */
const CARD_ORDER = ['PRES', 'GOV', 'SEN', 'REP', 'SHA'];
const orderedContests = (cs: Contest[] | null) =>
  [...(cs ?? [])].sort((a, b) => CARD_ORDER.indexOf(a.code) - CARD_ORDER.indexOf(b.code));

/**
 * The card's headline — see lib/api.ts:electionTitle. It lives there because the
 * naming rule (plural for everything but the presidency, NASS for the National
 * Assembly) is about the elections themselves, not about this screen.
 */
const cardTitle = (c: Contest, all: Contest[] | null): string => electionTitle(c, all);

function daysUntil(iso: string) {
  const ms = new Date(`${iso}T00:00:00+01:00`).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function ago(ts: number) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

type Kind = 'report' | 'incident' | 'flag' | 'case';

type Item = {
  id: string;
  kind: Kind;
  at: number;
  title: string;
  detail: string;
  href?: string;
};

/**
 * The disc behind each row's icon. `tone` names a semantic tint that darkens
 * with the theme (bg-emerald-100 / bg-red-100 / bg-neutral-200 stayed pale in
 * dark mode and the icon on them vanished); `null` is the neutral disc, which
 * is just the screen background one step back from the card. The icon colour is
 * a prop, so it comes from useUi().tint — the JS twin of the same tokens.
 */
const KIND: Record<Kind, { icon: keyof typeof Feather.glyphMap; tone: Tone | null }> = {
  report: { icon: 'file-text', tone: 'good' },
  incident: { icon: 'alert-triangle', tone: 'warn' },
  flag: { icon: 'flag', tone: 'bad' },
  case: { icon: 'shield', tone: null },
};

const TINT: Record<Tone, string> = {
  good: 'bg-good',
  bad: 'bg-bad',
  warn: 'bg-warn',
};

const FILTERS: { key: Kind | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'report', label: 'Reports' },
  { key: 'incident', label: 'Incidents' },
  { key: 'flag', label: 'Flags' },
  { key: 'case', label: 'Cases' },
];

async function jget<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Home — the live feed of everything moving through Hawkeye.
 *
 * There is no single feed endpoint and there should not be: each of these is a
 * different public record with its own audience and its own screen. They are
 * merged here on the device from four public reads — accepted reports off the
 * ledger, published incidents, integrity flags and docket cases — so the home
 * tab answers "what is happening right now" instead of restating the pitch.
 *
 * Every row lands on the screen that owns it. A feed you cannot follow anywhere
 * is decoration.
 */
export default function Home() {
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();
  const [contests, setContests] = useState<Contest[] | null>(null);
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, i, ledger, incidents, flags, docket] = await Promise.all([
      api.contests().catch(() => null),
      api.integrity().catch(() => null),
      jget<{ id: number; pu_code: string; contest: string; created_at: number }[]>(
        '/api/ledger/entries',
      ),
      jget<{
        incidents: {
          id: number;
          kind: string;
          state?: string;
          lga?: string;
          text?: string;
          created_at: number;
        }[];
      }>('/api/incidents'),
      jget<{
        discrepancies: {
          id: number;
          type: string;
          severity: string;
          pu_name?: string | null;
          state?: string | null;
          detail?: { summary?: string };
          created_at: number;
        }[];
      }>('/api/integrity/discrepancies?limit=30'),
      jget<{
        cases: {
          id: number;
          name?: string | null;
          puCode: string;
          contest: string;
          status: string;
          openedAt: number;
          resolvedAt: number | null;
        }[];
      }>('/api/docket'),
    ]);

    if (c) setContests(c);
    if (i) setIntegrity(i);
    // Every source failing at once means the network is gone, not that nothing
    // is happening — the two look identical otherwise.
    if (!c && !ledger && !incidents) {
      setError('Could not reach hawkeye.com.ng — check your connection.');
      return;
    }
    setError(null);

    const merged: Item[] = [];

    for (const e of (ledger ?? []).slice(-40)) {
      merged.push({
        id: `r${e.id}`,
        kind: 'report',
        at: e.created_at,
        title: `Result reported · ${e.contest}`,
        detail: e.pu_code,
        href: '/reports-log',
      });
    }
    for (const n of incidents?.incidents ?? []) {
      merged.push({
        id: `i${n.id}`,
        kind: 'incident',
        at: n.created_at,
        title: n.kind.replace(/_/g, ' '),
        detail: [n.lga, n.state].filter(Boolean).join(', ') || n.text?.slice(0, 60) || '',
        href: '/incidents',
      });
    }
    for (const d of flags?.discrepancies ?? []) {
      if (d.severity === 'low') continue; // the home feed is for what is worth a look
      merged.push({
        id: `f${d.id}`,
        kind: 'flag',
        at: d.created_at,
        title: d.type.replace(/_/g, ' '),
        detail: d.detail?.summary?.slice(0, 90) || [d.pu_name, d.state].filter(Boolean).join(' · '),
        href: '/integrity',
      });
    }
    for (const k of docket?.cases ?? []) {
      merged.push({
        id: `c${k.id}`,
        kind: 'case',
        at: k.resolvedAt ?? k.openedAt,
        title: k.resolvedAt ? `Case resolved — ${k.status}` : 'Case opened',
        detail: `${k.name || k.puCode} · ${k.contest}`,
        href: `/case?id=${k.id}`,
      });
    }

    merged.sort((a, b) => b.at - a.at);
    setItems(merged.slice(0, 80));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(
    () => (filter === 'all' ? items : (items ?? []).filter((x) => x.kind === filter)),
    [items, filter],
  );

  const header = (
    <View className="px-4">
      <Text className="pb-4 pt-1 text-sm text-muted">
        Independent election observation — every report public, signed and verifiable.
      </Text>

      {/* Two contests can share one election NAME — Senate and House of
          Representatives are both the "2027 National Assembly Election" — so
          without the office appended this screen showed two identical cards and
          no way to tell which was which. */}

      {error ? (
        <View className="mb-3 rounded-2xl bg-warn px-4 py-3">
          <Text className="text-sm text-ink">{error}</Text>
        </View>
      ) : null}

      {orderedContests(contests).map((c) => (
        <Pressable
          key={c.code}
          className="mb-3 overflow-hidden rounded-3xl bg-hawk-green active:opacity-90"
          // The election's own page, not straight into reporting. This card is an
          // announcement ("this election is coming"), so it should open the thing
          // it announces and let the observer decide to report from there —
          // dropping someone into a capture flow they did not ask for is wrong,
          // and before polls open it is a dead end.
          //
          // IT OPENS THE ELECTION IT NAMES. This was a hardcoded '/osun' from
          // when Osun was the only race Hawkeye ran, so every card on this
          // screen — presidential, National Assembly, governorship — landed on a
          // finished governorship in a state most of them have nothing to do
          // with.
          // The `n` is a NAVIGATION NONCE, and it is load-bearing. The results
          // screen is a tab: it stays mounted, so tapping a second card only
          // changes the route params of a screen that is already showing
          // something. Its seeding is deliberately "apply only if nothing is
          // chosen" — which preserves a race picked inside the screen, and also
          // swallowed every card tap after the first, leaving the reader on
          // whichever contest they opened first. A value that differs per tap
          // tells the screen a new navigation happened, which a changed
          // `contest` alone cannot (tapping the same card twice, or returning
          // to a tab, look identical without it).
          onPress={() => router.push(`${cardHref(c)}&n=${Date.now()}` as never)}
        >
          <View className="px-5 pb-4 pt-5">
            <Text className="text-xs font-semibold uppercase tracking-wider text-hawk-gold">
              {c.open ? 'Reporting open' : 'Upcoming election'}
            </Text>
            <Text className="pt-1 text-xl font-bold text-white">{cardTitle(c, contests)}</Text>
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
            <Feather name="chevron-right" size={16} color={BRAND.gold} />
          </View>
        </Pressable>
      ))}

      <View className="flex-row gap-3">
        <Pressable
          className="flex-1 rounded-2xl bg-card px-4 py-4 active:opacity-80"
          onPress={() => router.push('/reports-log')}
        >
          <Text className="text-2xl font-bold text-ink">{integrity?.reports ?? '—'}</Text>
          <Text className="text-xs text-muted">Accepted Reports</Text>
        </Pressable>
        <Pressable
          className="flex-1 rounded-2xl bg-card px-4 py-4 active:opacity-80"
          onPress={() => router.push('/integrity')}
        >
          <Text className="text-2xl font-bold text-ink">{integrity?.unitsFlagged ?? '—'}</Text>
          <Text className="text-xs text-muted">Units Flagged</Text>
        </Pressable>
      </View>

      <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
        Live activity
      </Text>
      <View className="flex-row flex-wrap">
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            className={`mb-2 mr-2 rounded-full px-3.5 py-2 ${
              filter === f.key ? 'bg-hawk-green' : 'bg-card'
            }`}
          >
            <Text
              className={`text-xs font-semibold ${
                filter === f.key ? 'text-hawk-gold' : 'text-muted'
              }`}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Hawkeye" translateY={translateY} right="none" />
      <FlashList
        data={shown ?? []}
        keyExtractor={(x) => x.id}
        ListHeaderComponent={header}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ui.tint.good.ink}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          items === null ? (
            <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
          ) : (
            <View className="px-4 pt-2">
              <Text className="text-sm text-muted">
                {filter === 'all'
                  ? 'Nothing has come in yet. Reports, incidents and flags appear here as they land.'
                  : 'Nothing of this kind yet.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const k = KIND[item.kind];
          return (
            <Pressable
              className="mx-4 mb-2 flex-row items-start rounded-2xl bg-card px-4 py-3 active:opacity-80"
              onPress={() => (item.href ? router.push(item.href as never) : undefined)}
            >
              <View className={`mt-0.5 rounded-full p-1.5 ${k.tone ? TINT[k.tone] : 'bg-surface'}`}>
                <Feather name={k.icon} size={12} color={k.tone ? ui.tint[k.tone].ink : ui.muted} />
              </View>
              <View className="flex-1 pl-3">
                <Text className="text-sm font-bold capitalize text-ink">{item.title}</Text>
                {item.detail ? (
                  <Text className="pt-0.5 text-xs text-muted" numberOfLines={2}>
                    {item.detail}
                  </Text>
                ) : null}
              </View>
              <Text className="pl-2 text-[11px] text-faint">{ago(item.at)}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
