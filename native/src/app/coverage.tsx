import Feather from '@expo/vector-icons/Feather';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Pressable,
  RefreshControl,
  Text,
  View,
  type ScrollView,
} from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { clock } from '@/lib/dates';
import { t as i18nT } from '@/lib/i18n';
import { useUi } from '@/lib/theme';

/**
 * OBSERVER COVERAGE — the native twin of app/coverage.html, over the same
 * public endpoint (backend routes/coverage.js):
 *
 *   GET /api/coverage            national totals + one row per state
 *   GET /api/coverage?state=X    national totals + that state's LGA rows
 *
 * THE PUBLIC FLOOR IS THE LGA, and this screen never asks for more. A ward
 * figure of "1 of 14" is most of the way to saying where the one observer is,
 * and a list of uncovered units says where nobody is watching; both stay on
 * the owner's console (/api/admin/coverage), which this screen does not call.
 * Units are counted, never people.
 *
 * It used to open the website in the in-app browser from More. Native gets
 * native screens (tests/native_no_web_pages_test.mjs); a coverage.html link
 * lands here too, through lib/web-routes.ts.
 *
 * Same wording and keys as the web page wherever the text is the same, so the
 * two cannot drift into two different Hausa sentences.
 */
type Totals = { units: number; covered: number; pct: number };
type StateRow = Totals & { state: string };
type LgaRow = Totals & { lga: string };
type NationalView = { updatedAt: number; national: Totals; level: 'state'; states: StateRow[] };
type StateView = Totals & { updatedAt: number; national: Totals; level: 'lga'; state: string; lgas: LgaRow[] };
type Coverage = NationalView | StateView;
type Failure = 'network' | 'unknown_state';

const num = (n: number) => Number(n || 0).toLocaleString('en-US');

/** Coverage is small — Osun was 0.3% — so two places below 1%, and a unit
 *  that rounds to zero still says it exists. The web page's rule, exactly. */
const fmtPct = (p: number, covered: number) => {
  if (!p) return covered ? '<0.01%' : '0%';
  return `${p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : String(Math.round(p))}%`;
};

/** Ties share a rank (1, 2, 2, 4): ranking 36 states at 0% as 2…37 would
 *  invent an order that is not there. */
const ranks = (rows: Totals[]) => {
  let prev: number | null = null;
  let rank = 0;
  return rows.map((r, i) => {
    if (r.pct !== prev) {
      rank = i + 1;
      prev = r.pct;
    }
    return rank;
  });
};

const isTotals = (x: unknown): x is Totals =>
  !!x && typeof x === 'object' && typeof (x as Totals).units === 'number' && typeof (x as Totals).covered === 'number';

/** One read of the public endpoint, shape-checked before anything paints it. */
async function fetchCoverage(state: string): Promise<{ ok: true; body: Coverage } | { ok: false; why: Failure }> {
  try {
    const res = await fetch(`${BASE}/api/coverage${state ? `?state=${encodeURIComponent(state)}` : ''}`, {
      headers: { accept: 'application/json' },
    });
    const body = await res.json().catch(() => null);
    if (res.status === 404 && body?.error === 'unknown_state') return { ok: false, why: 'unknown_state' };
    if (!res.ok || !body || !isTotals(body.national)) return { ok: false, why: 'network' };
    if (state ? !Array.isArray(body.lgas) : !Array.isArray(body.states)) return { ok: false, why: 'network' };
    return { ok: true, body: body as Coverage };
  } catch {
    return { ok: false, why: 'network' };
  }
}

/** A thin bar; a covered unit always shows at least a sliver. */
function Bar({ pct, covered, thick }: { pct: number; covered: number; thick?: boolean }) {
  return (
    <View className={`${thick ? 'h-3' : 'h-1.5'} w-full overflow-hidden rounded-full bg-surface`}>
      <View
        className="h-full rounded-full bg-good-ink"
        style={{ width: `${covered ? Math.min(100, Math.max(0, pct)) : 0}%`, minWidth: covered ? 3 : 0 }}
      />
    </View>
  );
}

function Btn({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={`mt-2 items-center rounded-xl px-4 py-3 active:opacity-80 ${primary ? 'bg-hawk-gold' : 'border border-line bg-surface'}`}
    >
      <Text className={`text-center text-sm font-bold ${primary ? 'text-hawk-green' : 'text-good-ink'}`}>{label}</Text>
    </Pressable>
  );
}

export default function CoverageScreen() {
  const ui = useUi();
  const auth = useAuth();
  const params = useLocalSearchParams<{ state?: string | string[] }>();
  const initial = (Array.isArray(params.state) ? params.state[0] : params.state)?.trim() ?? '';
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  /** '' = all states; otherwise the state whose LGAs are shown. */
  const [view, setView] = useState(initial);
  const viewRef = useRef(initial);
  /** True once a state was opened HERE — only then does Back mean "All states". */
  const [drilled, setDrilled] = useState(false);
  const [data, setData] = useState<Coverage | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const [national, setNational] = useState<Totals | null>(null);
  /** The last national list, so a state view can still count states at 1%. */
  const [lastStates, setLastStates] = useState<StateRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const tableY = useRef(0);

  const load = useCallback(async (state: string) => {
    const mine = ++seq.current;
    const got = await fetchCoverage(state);
    if (mine !== seq.current) return; // a newer drill-down won
    if (!got.ok) {
      setFailed(got.why);
      return;
    }
    const body = got.body;
    setData(body);
    setFailed(null);
    setNational(body.national);
    if (body.level === 'state') setLastStates(body.states);
    // Answer in the register's own spelling (the API matches any case).
    else if (body.state !== viewRef.current) {
      viewRef.current = body.state;
      setView(body.state);
    }
  }, []);

  // On focus, not mount: back from saving a unit re-reads the figures.
  useFocusEffect(
    useCallback(() => {
      load(viewRef.current);
    }, [load]),
  );

  const go = useCallback(
    (state: string) => {
      viewRef.current = state;
      setView(state);
      setDrilled(!!state);
      setData(null);
      setFailed(null);
      load(state);
      scroll.current?.scrollTo({ y: Math.max(0, tableY.current - headerH - 12), animated: true });
    },
    [load, headerH],
  );

  // Android's back button inside a state opened here returns to all states,
  // as the web page's history does; otherwise it closes the screen as usual.
  useEffect(() => {
    if (!view || !drilled) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      go('');
      return true;
    });
    return () => sub.remove();
  }, [view, drilled, go]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(viewRef.current);
    setRefreshing(false);
  };

  const inState = !!view;
  const current = data && (inState ? data.level === 'lga' : data.level === 'state') ? data : null;
  const list: (Totals & { name: string })[] = !current
    ? []
    : current.level === 'lga'
      ? current.lgas.map((r) => ({ ...r, name: r.lga || '—' }))
      : current.states.map((r) => ({ ...r, name: r.state || '—' }));
  const rowRanks = ranks(list);
  const stateName = current?.level === 'lga' ? current.state : view;
  const goalStates = lastStates;

  const failMsg = failed === 'unknown_state' ? i18nT('coverage.unknown-state') : i18nT('coverage.load-failed');
  const signedIn = auth.status === 'signedIn';

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('coverage.observer-coverage')} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        ref={scroll}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ui.tint.good.ink} />}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        <Text className="pb-4 text-sm leading-5 text-muted">{i18nT('coverage.lede')}</Text>

        {!national && !failed ? (
          <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
        ) : !national ? (
          <View className="items-center rounded-2xl bg-card px-6 py-10">
            <Feather name={failed === 'unknown_state' ? 'map-pin' : 'wifi-off'} size={26} color={ui.faint} />
            <Text className="pt-3 text-center text-sm text-ink">{failMsg}</Text>
            <View className="w-full pt-4">
              {failed === 'unknown_state' ? (
                <Btn label={i18nT('coverage.all-states')} onPress={() => go('')} />
              ) : (
                <Btn label={i18nT('coverage.try-again')} onPress={() => load(viewRef.current)} />
              )}
            </View>
          </View>
        ) : (
          <>
            {/* NATIONWIDE — the number the recruitment plan steers by. */}
            <View className="rounded-2xl bg-card px-4 py-4">
              <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">
                {i18nT('coverage.nationwide')}
              </Text>
              <Text className="pt-1 text-4xl font-bold tabular-nums text-good-ink">
                {fmtPct(national.pct, national.covered)}
              </Text>
              <View
                className="pt-3"
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={i18nT('coverage.progress-aria', { pct: fmtPct(national.pct, national.covered) })}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(national.pct) }}
              >
                <Bar pct={national.pct} covered={national.covered} thick />
              </View>
              <Text className="pt-3 text-sm tabular-nums text-ink">
                {i18nT('coverage.n-of-m-units-covered', { covered: num(national.covered), units: num(national.units) })}
              </Text>
              {goalStates ? (
                <Text className="pt-1 text-sm tabular-nums text-muted">
                  {i18nT('coverage.states-at-goal', {
                    n: num(goalStates.filter((s) => s.pct >= 1).length),
                    m: num(goalStates.length),
                  })}
                </Text>
              ) : null}
              <Text className="pt-3 text-xs leading-5 text-muted">{i18nT('coverage.goal-note')}</Text>
            </View>

            {/* STAY FOR THE COUNT — the page is a recruitment page first. */}
            <View className="mt-3 rounded-2xl bg-card p-4">
              <Text className="text-base font-bold text-ink">{i18nT('coverage.stay-for-the-count')}</Text>
              <Text className="pb-2 pt-1 text-sm leading-5 text-muted">{i18nT('coverage.cta-body')}</Text>
              {/* Signed in: the unit chooser. Signed out: sign-up, which asks for
                  the unit as its last step — the web page's split. */}
              <Btn
                primary
                label={signedIn ? i18nT('coverage.change-your-unit') : i18nT('coverage.save-your-unit')}
                onPress={() => router.push((signedIn ? '/choose-unit' : '/sign-in?intent=signup') as never)}
              />
              <Btn label={i18nT('coverage.try-practice')} onPress={() => router.push('/practice' as never)} />
              <Btn label={i18nT('coverage.become-captain')} onPress={() => router.push('/captain?guide=1' as never)} />
              <View className="mt-3 border-l-4 border-hawk-gold pl-3">
                <Text className="text-xs leading-5 text-muted">{i18nT('coverage.safety')}</Text>
              </View>
            </View>

            {/* THE TABLE — states, or one state's local governments. */}
            <View
              className="mt-3 overflow-hidden rounded-2xl bg-card"
              onLayout={(e) => {
                tableY.current = e.nativeEvent.layout.y;
              }}
            >
              <View className="px-4 pb-3 pt-4">
                {inState ? (
                  <Pressable
                    onPress={() => go('')}
                    accessibilityRole="button"
                    className="mb-2 flex-row items-center self-start py-1.5 pr-3 active:opacity-70"
                  >
                    <Feather name="chevron-left" size={16} color={ui.tint.good.ink} />
                    <Text className="pl-1 text-sm font-bold text-good-ink">{i18nT('coverage.all-states')}</Text>
                  </Pressable>
                ) : null}
                <Text className="text-lg font-bold text-ink">
                  {!inState
                    ? i18nT('coverage.states-by-coverage')
                    : failed
                      ? view
                      : i18nT('coverage.lgas-in-state', { state: stateName })}
                </Text>
                {failed || !current ? null : current.level === 'lga' ? (
                  current.covered ? null : (
                    <Text className="pt-1 text-sm leading-5 text-muted">{i18nT('coverage.none-yet')}</Text>
                  )
                ) : (
                  <Text className="pt-1 text-sm leading-5 text-muted">{i18nT('coverage.tap-a-state')}</Text>
                )}
              </View>

              {failed ? (
                <View className="border-t border-line px-4 py-4">
                  <Text className="text-sm text-ink">{failMsg}</Text>
                  {failed === 'network' ? (
                    <Pressable
                      onPress={() => load(viewRef.current)}
                      accessibilityRole="button"
                      className="mt-2 self-start py-1 active:opacity-70"
                    >
                      <Text className="text-sm font-bold text-warn-ink">{i18nT('coverage.try-again')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : !current ? (
                <ActivityIndicator className="py-6" color={ui.tint.good.ink} />
              ) : list.length === 0 ? (
                <Text className="border-t border-line px-4 py-4 text-sm text-muted">
                  {i18nT('n.app.coverage.empty')}
                </Text>
              ) : (
                <>
                  {/* Column heads, as on the web table. Each row below carries
                      its own full label, so a screen reader skips these. */}
                  <View
                    className="flex-row items-center border-t border-line px-4 py-1.5"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                  >
                    <Text className="w-8 text-[11px] font-bold uppercase tracking-wider text-faint">#</Text>
                    <Text className="flex-1 text-[11px] font-bold uppercase tracking-wider text-faint">
                      {inState ? i18nT('coverage.col-lga') : i18nT('common.state')}
                    </Text>
                    {/* Its own width, not the figures' w-16: "COVERAGE" in capitals
                        broke across two lines there. Right edge still meets the
                        figures' — the spacer stands in for a state row's chevron. */}
                    <Text numberOfLines={1} className="pl-2 text-right text-[11px] font-bold uppercase tracking-wider text-faint">
                      {i18nT('coverage.coverage')}
                    </Text>
                    {inState ? null : <View style={{ width: 22 }} />}
                  </View>
                  {list.map((r, i) => {
                    const pct = fmtPct(r.pct, r.covered);
                    const sub = i18nT('coverage.units-covered-short', { covered: num(r.covered), units: num(r.units) });
                    const label = `${rowRanks[i]}. ${r.name}, ${pct}, ${sub}`;
                    const inner = (
                      <>
                        <Text className="w-8 text-sm tabular-nums text-muted">{rowRanks[i]}</Text>
                        <View className="flex-1 pr-3">
                          <Text className={`text-base font-bold ${inState ? 'text-ink' : 'text-good-ink'}`}>{r.name}</Text>
                          <Text className="pt-0.5 text-xs tabular-nums text-muted">{sub}</Text>
                        </View>
                        <View className="w-16 items-end">
                          <Text className="pb-1 text-sm font-bold tabular-nums text-ink">{pct}</Text>
                          <Bar pct={r.pct} covered={r.covered} />
                        </View>
                      </>
                    );
                    // States drill down; LGAs are the public floor, so they do not.
                    return inState ? (
                      <View
                        key={r.name + i}
                        accessible
                        accessibilityLabel={label}
                        className="flex-row items-center border-t border-line px-4 py-3"
                      >
                        {inner}
                      </View>
                    ) : (
                      <Pressable
                        key={r.name + i}
                        onPress={() => go(r.name)}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityHint={i18nT('coverage.open-state-aria', { state: r.name })}
                        className="flex-row items-center border-t border-line px-4 py-3 active:bg-surface"
                      >
                        {inner}
                        <Feather name="chevron-right" size={16} color={ui.faint} style={{ marginLeft: 6 }} />
                      </Pressable>
                    );
                  })}
                  <Text className="border-t border-line px-4 py-3 text-xs text-muted">
                    {i18nT('coverage.updated-at', { time: clock(current.updatedAt) })}
                  </Text>
                </>
              )}
            </View>

            <Text className="pt-4 text-xs leading-5 text-muted">{i18nT('coverage.privacy-note')}</Text>
          </>
        )}
      </Animated.ScrollView>
    </View>
  );
}
