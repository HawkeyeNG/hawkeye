import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Animated, Pressable, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { loadStatesGeo, NigeriaMap, NO_DATA_FILL, normState } from '@/components/nigeria-map';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { loadPolitical, partyColor, partyName, type Political } from '@/lib/political';

const BASE = 'https://hawkeye.com.ng';
const REFRESH_MS = 60_000;

type Contest = {
  code: string;
  name: string;
  election: string;
  date: string;
  states: string[];
  open: boolean;
  opensAt?: string;
};

/**
 * `/api/national/:contest` as the map needs it. lib/api.ts's `National` type
 * predates the per-region `leader`/`leaders` fields the backend now returns
 * (backend/src/routes/national.js), and that file is not ours to edit, so the
 * map keeps its own contract with the endpoint.
 */
type Region = {
  region: string;
  leader: string | null;
  leaders: string[];
  votes: Record<string, number>;
  unitsReporting: number;
  unitsVerified: number;
};

type Tally = {
  contest: string;
  level: string;
  updatedAt: number;
  unitsReporting: number;
  inDispute: number;
  national: { party: string; votes: number }[];
  regions: Region[];
};

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Which contests this map can honestly draw. The backend keys `state` and
 * `lga` levels by state name (LEVEL in national.js: State Assembly regions are
 * still the unit's state), so both fill state shapes correctly. Senate and
 * House of Reps divide into districts and constituencies — different polygons
 * entirely, and tinting whole states by them would be a lie.
 */
const STATE_KEYED = new Set(['state', 'lga']);

/** An exact tie: the web map paints these white rather than pick a winner. */
const TIE_FILL = '#ffffff';

/** The geo file's display names are title-cased keys; this one reads badly. */
const LABEL: Record<string, string> = { Fct: 'FCT (Abuja)' };
const label = (name: string) => LABEL[name] ?? name;

type Mode = 'results' | 'power';

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [mode, setMode] = useState<Mode>('results');
  const [contests, setContests] = useState<Contest[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [tally, setTally] = useState<Tally | null>(null);
  const [political, setPolitical] = useState<Political | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The state list under the map comes from the same memoised geo fetch the map
  // itself uses, so it costs nothing extra.
  useEffect(() => {
    let alive = true;
    loadStatesGeo()
      .then((g) => alive && setNames(g.states.map((s) => s.name)))
      .catch(() => {
        /* the map renders its own failure; a second copy of it helps nobody */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    loadPolitical()
      .then(({ data }) => setPolitical(data))
      .catch((e) => setErr(`Incumbency data: ${e instanceof Error ? e.message : String(e)}`));
  }, []);

  // The contest list is fixed for the run — only the tally under it moves, so
  // this is fetched once and the polling below stays on /api/national alone.
  useEffect(() => {
    jget<Contest[]>('/api/contests')
      .then((list) => {
        setContests(list);
        if (!list.length) {
          setErr('No contest is configured yet. (/api/contests returned none)');
          return;
        }
        setCode((prev) => (prev && list.some((c) => c.code === prev) ? prev : list[0].code));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const load = useCallback(async () => {
    if (!code) return;
    try {
      setTally(await jget<Tally>(`/api/national/${code}`));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [code]);

  useEffect(() => {
    // `load` is async and every setState in it lands after a network round-trip,
    // so this is not the synchronous cascade the rule is aimed at.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const contest = contests.find((c) => c.code === code) ?? null;
  const stateKeyed = !tally || STATE_KEYED.has(tally.level);

  const byRegion = useMemo(() => {
    const m: Record<string, Region> = {};
    for (const r of tally?.regions ?? []) m[normState(r.region)] = r;
    return m;
  }, [tally]);

  const byGovernor = useMemo(() => {
    const m: Record<string, string | null> = {};
    for (const [state, party] of Object.entries(political?.governors ?? {})) {
      m[normState(state)] = party ?? null;
    }
    return m;
  }, [political]);

  const fills = useMemo(() => {
    const f: Record<string, string> = {};
    if (mode === 'results') {
      if (!stateKeyed) return f;
      for (const r of tally?.regions ?? []) {
        if (r.leaders?.length > 1) f[r.region] = TIE_FILL;
        else if (r.leader) f[r.region] = partyColor(r.leader);
      }
      return f;
    }
    for (const [state, party] of Object.entries(political?.governors ?? {})) {
      if (party) f[state] = partyColor(party);
    }
    return f;
  }, [mode, stateKeyed, tally, political]);

  // The chip row wants the same colours the map used, looked up by the geo
  // file's spelling of each state rather than the data source's.
  const fillByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [state, colour] of Object.entries(fills)) m[normState(state)] = colour;
    return m;
  }, [fills]);

  /** Legend rows: which parties are on the map, and over how many states. */
  const legend = useMemo(() => {
    const n: Record<string, number> = {};
    let ties = 0;
    if (mode === 'results') {
      for (const r of tally?.regions ?? []) {
        if (r.leaders?.length > 1) ties++;
        else if (r.leader) n[r.leader] = (n[r.leader] ?? 0) + 1;
      }
    } else {
      for (const party of Object.values(political?.governors ?? {})) {
        if (party) n[party] = (n[party] ?? 0) + 1;
      }
    }
    return { rows: Object.entries(n).sort((a, b) => b[1] - a[1]), ties };
  }, [mode, tally, political]);

  /** The tap-for-details line, in the footer where every other status line is. */
  const detail = (() => {
    if (!selected) return { title: null as string | null, lines: ['Tap a state for its details.'] };
    const key = normState(selected);
    const title = label(selected);

    if (mode === 'power') {
      const party = byGovernor[key];
      if (!political) return { title, lines: ['Loading incumbency data…'] };
      if (party) return { title, lines: [`Governed by ${partyName(party)}.`] };
      if (key in byGovernor) {
        return { title, lines: ['No governor — administered by a federal minister.'] };
      }
      return { title, lines: ['No incumbency record for this state.'] };
    }

    if (!stateKeyed) return { title, lines: ['This race is not divided by state.'] };
    if (contest && !contest.states.some((s) => normState(s) === key)) {
      return {
        title,
        lines: [`${contest.name} is not contested here — it covers ${contest.states.join(', ')}.`],
      };
    }
    const r = byRegion[key];
    if (!r) return { title, lines: ['No results reported from this state yet.'] };

    const L = r.leaders?.length ? r.leaders : r.leader ? [r.leader] : [];
    const lead =
      L.length > 2
        ? `${L.length}-way tie`
        : L.length === 2
          ? `${L[0]} and ${L[1]} tied`
          : L.length === 1
            ? `${L[0]} leads`
            : 'No counts yet';
    const top = Object.entries(r.votes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, v]) => `${p} ${v.toLocaleString()}`)
      .join(' · ');
    return {
      title,
      lines: [
        `${lead} · ${r.unitsReporting} unit(s) reporting, ${r.unitsVerified} verified.`,
        top || 'No votes recorded.',
      ],
    };
  })();

  const heading = mode === 'results' ? 'Leading party by state' : 'Governing party by state';

  // A by-election or a single-state governorship leaves most of the map grey.
  // Saying which states it covers stops that reading as "nobody has reported".
  const partial = contest && contest.states.length > 0 && contest.states.length < 36;
  const subtitle =
    mode === 'results'
      ? contest
        ? `${contest.election}${partial ? ` — contested in ${contest.states.join(', ')}; every other state stays grey.` : ''}`
        : 'Unofficial running tally from accepted observer reports.'
      : 'Who holds each governorship now — the incumbents this election confirms or unseats.';

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Map of Nigeria" translateY={translateY} onClose={() => router.back()} />

      <Animated.ScrollView
        style={{ flex: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 24 }}
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
        <View className="flex-row pb-3">
          {(
            [
              ['results', 'Reported results'],
              ['power', 'Governing party'],
            ] as [Mode, string][]
          ).map(([m, text]) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              className={`mr-2 rounded-full px-3.5 py-2 ${mode === m ? 'bg-hawk-green' : 'bg-card'}`}
            >
              <Text
                className={`text-xs font-semibold ${mode === m ? 'text-hawk-gold' : 'text-muted'}`}
              >
                {text}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Only worth a picker when there is actually a choice to make. */}
        {mode === 'results' && contests.length > 1 ? (
          <View className="flex-row flex-wrap pb-3">
            {contests.map((c) => (
              <Pressable
                key={c.code}
                onPress={() => setCode(c.code)}
                className={`mb-2 mr-2 rounded-full px-3 py-1.5 ${c.code === code ? 'bg-hawk-leaf' : 'bg-card'}`}
              >
                <Text
                  className={`text-[11px] font-semibold ${c.code === code ? 'text-white' : 'text-muted'}`}
                >
                  {c.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Text className="text-base font-bold text-ink">{heading}</Text>
        <Text className="pb-3 pt-0.5 text-xs text-muted">{subtitle}</Text>

        {mode === 'results' && !stateKeyed ? (
          <View className="mb-3 rounded-2xl bg-card px-4 py-3">
            <Text className="text-sm font-semibold text-amber-800">
              This race can&apos;t be drawn on a state map.
            </Text>
            <Text className="pt-1 text-xs text-muted">
              {contest?.name ?? tally?.contest} is counted by {tally?.level}, not by state. Open the
              website&apos;s results map for the right polygons.
            </Text>
          </View>
        ) : null}

        <NigeriaMap
          fills={fills}
          selected={selected}
          onPress={setSelected}
          accessibilityLabel={`Map of Nigeria: ${heading.toLowerCase()}`}
        />

        <View className="flex-row flex-wrap pt-3">
          {legend.rows.map(([party, n]) => (
            <View key={party} className="mb-1.5 mr-3 flex-row items-center">
              <View
                className="h-3 w-3 rounded-sm"
                style={{ backgroundColor: partyColor(party), opacity: 0.9 }}
              />
              <Text className="pl-1.5 text-[11px] text-muted">
                {party} · {n}
              </Text>
            </View>
          ))}
          {legend.ties ? (
            <View className="mb-1.5 mr-3 flex-row items-center">
              <View className="h-3 w-3 rounded-sm border border-neutral-300 bg-card" />
              <Text className="pl-1.5 text-[11px] text-muted">tied · {legend.ties}</Text>
            </View>
          ) : null}
          <View className="mb-1.5 mr-3 flex-row items-center">
            <View className="h-3 w-3 rounded-sm" style={{ backgroundColor: NO_DATA_FILL }} />
            <Text className="pl-1.5 text-[11px] text-muted">
              {mode === 'results' ? 'no reports yet' : 'no governor'}
            </Text>
          </View>
        </View>

        {mode === 'results' && tally ? (
          <Text className="pt-1 text-[11px] text-faint">
            {tally.regions.length} state(s) reporting · {tally.unitsReporting} unit(s) counted
            {tally.inDispute ? ` · ${tally.inDispute} excluded pending arbitration` : ''} · updated{' '}
            {new Date(tally.updatedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        ) : null}
        {mode === 'results' ? (
          <Text className="pt-2 text-[11px] text-faint">
            Unofficial. Crowd-reported totals, excluding disputed results. Official results remain
            INEC&apos;s.
          </Text>
        ) : (
          <Text className="pt-2 text-[11px] text-faint">
            {political?.note ?? 'Incumbency data is provisional and community-maintained.'}
          </Text>
        )}

        {/* Small states are a few pixels wide on a phone; these are the tap
            targets that actually work for Lagos, Ekiti and the FCT. */}
        {names.length ? (
          <>
            <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
              Every state
            </Text>
            <View className="flex-row flex-wrap">
              {[...names].sort().map((name) => {
                const key = normState(name);
                const on = selected != null && normState(selected) === key;
                const colour = fillByKey[key];
                return (
                  <Pressable
                    key={name}
                    onPress={() => setSelected(name)}
                    className={`mb-2 mr-2 flex-row items-center rounded-full px-3 py-1.5 ${on ? 'bg-hawk-green' : 'bg-card'}`}
                  >
                    <View
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: colour ?? '#c9d4cd' }}
                    />
                    <Text
                      className={`pl-1.5 text-[11px] font-semibold ${on ? 'text-hawk-gold' : 'text-muted'}`}
                    >
                      {label(name)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
      </Animated.ScrollView>

      <View
        className="border-t border-line bg-surface px-4 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        {detail.title ? (
          <Text className="text-sm font-bold text-ink">{detail.title}</Text>
        ) : null}
        {detail.lines.map((line, i) => (
          <Text key={i} className="pt-0.5 text-xs text-muted">
            {line}
          </Text>
        ))}
        {err ? (
          <Text className="pt-1.5 text-xs font-semibold text-amber-800">Could not load. ({err})</Text>
        ) : null}
        <Pressable
          className="mt-3 items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80"
          onPress={() =>
            router.push((mode === 'results' ? '/(tabs)/results' : '/political') as never)
          }
        >
          <Text className="text-sm font-bold text-hawk-gold">
            {mode === 'results' ? 'Open live results' : 'Full political data'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
