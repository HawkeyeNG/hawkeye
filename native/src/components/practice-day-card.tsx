import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { longDate } from '@/lib/dates';
import { t as i18nT, useT } from '@/lib/i18n';
import { fetchPracticeDays, isPracticeDate, type PracticeDaysPayload } from '@/lib/practice-days';
import { useUi } from '@/lib/theme';

const REFRESH_MS = 60_000;
const num = (n: number) => Number(n || 0).toLocaleString('en-US');

/** The count sentence for the live and after states, resolved at paint time. */
function countLine(phase: 'live' | 'after', n: number, date: string): string {
  if (phase === 'live') {
    if (!n) return i18nT('n.components.practice-day-card.live-none');
    if (n === 1) return i18nT('n.components.practice-day-card.live-count-one');
    return i18nT('n.components.practice-day-card.live-count', { v0: num(n) });
  }
  if (!n) return i18nT('n.components.practice-day-card.after-none', { v0: longDate(date) });
  if (n === 1) return i18nT('n.components.practice-day-card.after-count-one', { v0: longDate(date) });
  return i18nT('n.components.practice-day-card.after-count', { v0: num(n), v1: longDate(date) });
}

/**
 * National Practice Day on the home tab: before (date + "Practise now"), on the
 * day (how many observers have practised), and for a few days after (the shared
 * count, linking to the results screen). Renders nothing when the server has no
 * day to talk about, or when it cannot be reached — a home card that reports
 * "offline" on every cold start without signal is noise.
 *
 * The payload is kept, the WORDS are not: every string is resolved in render,
 * and useT() subscribes this card to the language, so a change repaints it.
 * The refresh timer lives in an effect with no dependencies, so no re-render
 * can cancel it.
 */
export function PracticeDayCard() {
  useT();
  const ui = useUi();
  const [data, setData] = useState<PracticeDaysPayload | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchPracticeDays()
        .then((d) => { if (alive) setData(d); })
        .catch(() => { /* keep the last good answer; with none, the card stays hidden */ });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const day = data?.day;
  if (!day || !isPracticeDate(day.date) || !['before', 'live', 'after'].includes(day.phase)) return null;
  const n = data?.results?.participants ?? 0;
  const results = () => router.push(`/practice-day?day=${day.date}` as never);
  const practise = () => router.push('/practice' as never);
  const hours = i18nT('n.components.practice-day-card.window', { v0: day.window?.start ?? '08:00', v1: day.window?.end ?? '18:00' });

  const title = day.phase === 'before'
    ? i18nT('n.components.practice-day-card.title')
    : day.phase === 'live'
      ? i18nT('n.components.practice-day-card.live-title')
      : i18nT('n.components.practice-day-card.after-title');

  return (
    <Pressable
      className="mb-3 rounded-2xl border-l-4 border-hawk-gold bg-card px-4 py-4 active:opacity-90"
      onPress={day.phase === 'before' ? practise : results}
      accessibilityRole="button"
    >
      <View className="flex-row items-center">
        <Feather name="flag" size={16} color={ui.tint.good.ink} />
        <Text className="flex-1 pl-2 text-[15px] font-bold text-ink">{title}</Text>
        {day.phase !== 'before' ? <Feather name="chevron-right" size={18} color={ui.faint} /> : null}
      </View>

      {day.phase === 'before' ? (
        <>
          <Text className="pt-1 text-[13px] text-muted">{`${longDate(day.date)} · ${hours}`}</Text>
          <Text className="pt-2 text-[14px] leading-5 text-ink">
            {i18nT('n.components.practice-day-card.before-line')}
          </Text>
        </>
      ) : (
        <Text className="pt-2 text-[15px] font-semibold leading-5 text-good-ink">{countLine(day.phase, n, day.date)}</Text>
      )}

      {day.phase === 'after' && data?.next && isPracticeDate(data.next.date) ? (
        <Text className="pt-1 text-[13px] text-muted">
          {i18nT('n.components.practice-day-card.next', { v0: longDate(data.next.date) })}
        </Text>
      ) : null}

      {day.phase !== 'after' ? (
        <View className="flex-row flex-wrap items-center pt-3">
          <Pressable
            onPress={practise}
            className="mr-3 rounded-full bg-hawk-gold px-4 py-2.5 active:opacity-80"
            accessibilityRole="button"
          >
            <Text className="text-sm font-bold text-hawk-green">{i18nT('n.components.practice-day-card.practise-now')}</Text>
          </Pressable>
          {day.phase === 'live' ? (
            <Pressable onPress={results} accessibilityRole="link" className="py-2.5 active:opacity-70">
              <Text className="text-sm font-bold text-good-ink">{i18nT('n.components.practice-day-card.see-count')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Text className="pt-2 text-sm font-bold text-good-ink">{i18nT('n.components.practice-day-card.see-results')}</Text>
      )}
    </Pressable>
  );
}
