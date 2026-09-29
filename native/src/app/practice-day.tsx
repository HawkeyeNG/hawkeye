import Feather from '@expo/vector-icons/Feather';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, RefreshControl, Text, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { longDate } from '@/lib/dates';
import { t as i18nT, useT } from '@/lib/i18n';
import { fetchPracticeDays, isPracticeDate, type PracticeDaysPayload, type PracticePhase } from '@/lib/practice-days';
import { useUi } from '@/lib/theme';

const num = (n: number) => Number(n || 0).toLocaleString('en-US');
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

const phaseLabel = (p: PracticePhase) =>
  p === 'before'
    ? i18nT('n.app.practice-day.phase-before')
    : p === 'live'
      ? i18nT('n.app.practice-day.phase-live')
      : i18nT('n.app.practice-day.phase-after');

/**
 * National Practice Day results — native twin of app/practice-day.html.
 *
 * Aggregates only, as the endpoint returns them: how many observers practised
 * and the combined Party A-F count. Never who practised or where. While the day
 * is open it refreshes every minute, the same cadence as the server's cache.
 */
export default function PracticeDayScreen() {
  useT();
  const ui = useUi();
  const params = useLocalSearchParams<{ day?: string }>();
  const wanted = isPracticeDate(params.day) ? params.day : null;
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [data, setData] = useState<PracticeDaysPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * A plain promise with the state set in its callbacks — the captain.tsx shape.
   * As an async function, react-hooks/set-state-in-effect read its setState as
   * running synchronously inside the effect below; it never did (it followed the
   * await), but the callback form lets the compiler see that without a disable
   * comment.
   *
   * `current` is what the effect adds: a response for a day the reader has
   * already moved off (or for a screen that has closed) is dropped, rather than
   * landing after the newer one and showing the wrong day's figures.
   */
  const load = useCallback(
    (date: string | null, current: () => boolean = () => true) =>
      fetchPracticeDays(date).then(
        (d) => {
          if (!current()) return;
          setData(d);
          setFailed(false);
        },
        () => {
          if (current()) setFailed(true);
        },
      ),
    [],
  );

  useEffect(() => {
    let active = true;
    void load(wanted, () => active);
    return () => {
      active = false;
    };
  }, [load, wanted]);

  const live = data?.day?.phase === 'live';
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => load(wanted), 60_000);
    return () => clearInterval(timer);
  }, [live, load, wanted]);

  const day = data?.day && isPracticeDate(data.day.date) ? data.day : null;
  const r = day && day.phase !== 'before' ? data?.results : null;
  const totals = r?.totals ?? [];
  const max = totals.reduce((m, x) => Math.max(m, Number(x.votes) || 0), 0);
  const days = (data?.days ?? []).filter((x) => isPracticeDate(x.date));

  const status = !day
    ? ''
    : day.phase === 'before'
      ? i18nT('n.app.practice-day.status-before', {
          v0: longDate(day.date),
          v1: i18nT('n.components.practice-day-card.window', { v0: day.window?.start ?? '08:00', v1: day.window?.end ?? '18:00' }),
        })
      : day.phase === 'live'
        ? i18nT('n.app.practice-day.status-live', { v0: day.window?.end ?? '18:00' })
        : i18nT('n.app.practice-day.status-after', { v0: longDate(day.date) });

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('n.app.practice-day.title')} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ui.tint.good.ink}
            onRefresh={async () => {
              setRefreshing(true);
              await load(wanted);
              setRefreshing(false);
            }}
          />
        }
      >
        <Text className="pb-4 text-sm leading-5 text-muted">{i18nT('n.app.practice-day.lede')}</Text>

        {failed && !data ? (
          <View className="rounded-2xl bg-warn px-4 py-3">
            <Text className="text-sm text-ink">{i18nT('n.app.practice-day.load-error')}</Text>
            <Pressable onPress={() => load(wanted)} className="mt-2 self-start py-1 active:opacity-70" accessibilityRole="button">
              <Text className="text-sm font-bold text-warn-ink">{i18nT('n.app.practice-day.try-again')}</Text>
            </Pressable>
          </View>
        ) : !data ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : !day ? (
          <View className="rounded-2xl bg-card px-4 py-4">
            <Text className="text-sm text-muted">{i18nT('n.app.practice-day.none-scheduled')}</Text>
          </View>
        ) : (
          <View className="rounded-2xl bg-card px-4 py-4">
            <Text className="text-lg font-bold text-ink">{longDate(day.date)}</Text>
            <Text className="pt-1 text-sm text-muted">{status}</Text>

            {r ? (
              <>
                <View className="flex-row items-baseline pt-4">
                  <Text className="text-4xl font-bold text-good-ink">{num(r.participants)}</Text>
                  <Text className="pl-2 text-sm text-muted">
                    {r.participants === 1
                      ? i18nT('n.app.practice-day.observer-practised')
                      : i18nT('n.app.practice-day.observers-practised')}
                  </Text>
                </View>

                <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                  {i18nT('n.app.practice-day.combined-heading')}
                </Text>
                {!max ? (
                  <Text className="text-sm text-muted">{i18nT('n.app.practice-day.no-tally')}</Text>
                ) : (
                  totals.map((x) => {
                    const v = Number(x.votes) || 0;
                    return (
                      <View key={x.party} className="flex-row items-center py-1.5">
                        <Text className="w-20 text-sm font-bold text-ink">{x.party}</Text>
                        <View className="mx-2 h-3 flex-1 overflow-hidden rounded-full bg-surface">
                          <View
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round((v / max) * 100)}%`,
                              minWidth: v > 0 ? 3 : 0,
                              backgroundColor: COLOR_RE.test(String(x.color || '')) ? String(x.color) : ui.tint.good.ink,
                            }}
                          />
                        </View>
                        <Text className="w-14 text-right text-sm text-ink">{num(v)}</Text>
                      </View>
                    );
                  })
                )}
                {max ? (
                  <Text className="pt-2 text-xs leading-4 text-muted">{i18nT('n.app.practice-day.combined-note')}</Text>
                ) : null}
                <Text className="pt-2 text-xs leading-4 text-muted">{i18nT('n.app.practice-day.method')}</Text>
              </>
            ) : null}

            {day.phase !== 'after' ? (
              <Pressable
                onPress={() => router.push('/practice' as never)}
                className="mt-4 items-center rounded-full bg-hawk-gold py-3 active:opacity-80"
                accessibilityRole="button"
              >
                <Text className="text-sm font-bold text-hawk-green">{i18nT('n.components.practice-day-card.practise-now')}</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        {/* The next step after practising: check the phone itself is set for
            the day (app/ready.tsx) — the same link app/practice-day.html has. */}
        <Pressable
          onPress={() => router.push('/ready' as never)}
          className="mt-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-80"
          accessibilityRole="link"
        >
          <Feather name="check-circle" size={18} color={ui.tint.good.ink} />
          <Text className="flex-1 pl-3 text-sm font-semibold text-good-ink">{i18nT('ready.title')}</Text>
          <Feather name="chevron-right" size={18} color={ui.faint} />
        </Pressable>

        {days.length > 1 || (days.length === 1 && days[0].date !== day?.date) ? (
          <>
            <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
              {i18nT('n.app.practice-day.all-days')}
            </Text>
            {days.map((x) => {
              const here = x.date === day?.date;
              return (
                <Pressable
                  key={x.date}
                  disabled={here}
                  onPress={() => router.setParams({ day: x.date })}
                  className="mb-2 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80"
                >
                  <Text className={`flex-1 text-sm ${here ? 'font-bold text-ink' : 'font-semibold text-good-ink'}`}>
                    {longDate(x.date)}
                  </Text>
                  <Text className="text-xs text-muted">{phaseLabel(x.phase)}</Text>
                </Pressable>
              );
            })}
          </>
        ) : null}
      </Animated.ScrollView>
    </View>
  );
}
