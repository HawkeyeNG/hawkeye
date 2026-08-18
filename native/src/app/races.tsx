import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';

import { InfoDot } from '@/components/info-dot';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { api, type Contest } from '@/lib/api';
import { loadPolitical, type Political, type Race as RaceData } from '@/lib/political';
import { useUi } from '@/lib/theme';

/**
 * Races — the all-races selector, native twin of app/races.html. Reached from
 * the More menu's Races accordion ("All Races").
 *
 * THE GROUPING IS DERIVED, NOT WRITTEN DOWN. Each race falls into completed /
 * ongoing / upcoming from its polling date against today, so a race moves
 * between groups on its own. The previous list said "Osun 2026 is live now" in
 * prose — true for one day, wrong from the next morning.
 *
 * Two sources, because neither alone is complete: /api/contests is the scheduled
 * catalogue (the backend owns dates), and political_data.json carries the races
 * we have written pages for — including finished ones like Osun, which the
 * catalogue no longer lists.
 */
type Status = 'ongoing' | 'upcoming' | 'completed';

type Item = {
  name: string;
  desc: string;
  date?: string;
  status: Status;
  /** Route to push, or null for a race with no page yet. */
  href: string | null;
  /** Set on the governorship row: the states on this cycle's ballot. */
  states?: string[];
};

const GENERAL_ELECTION_YEAR = 2027;
const ORDER = ['PRES', 'GOV', 'SEN', 'REP', 'SHA'];
const DESC: Record<string, string> = {
  PRES: 'The declared presidential field, quick compare and live results.',
  GOV: 'One governorship per state. Each state has its own page and map.',
  SEN: '109 seats across 36 states and the FCT.',
  REP: '360 federal constituencies.',
  SHA: 'The 36 state legislatures.',
};

const SOON =
  'This race has no page yet — we publish each one as its election nears, about 28 days out, once INEC has released the candidate list.';

const fmt = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/**
 * Where a race sits in time.
 *
 * A contest's `open` flag cannot answer this: the backend's reportingOpen() is
 * true from poll-open ONWARDS and never goes false again, so a finished election
 * still reads as open. The polling DAY is what separates the three. Compared at
 * midnight, so a race is not "completed" at 00:01 on its own polling day.
 */
function statusOf(date?: string): Status {
  if (!date) return 'upcoming';
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const d = new Date(`${date}T00:00:00`);
  if (d < t) return 'completed';
  if (d > t) return 'upcoming';
  return 'ongoing';
}

/** `<race> (<year>)` — the app-wide naming convention. Mirrors races.ts:raceLabel. */
function label(c: Contest): string {
  const year = Number(String(c.date ?? '').slice(0, 4)) || GENERAL_ELECTION_YEAR;
  const where = c.states?.length === 1 ? `${c.states[0]} ` : '';
  return `${where}${c.name} (${year})`;
}

const GROUPS: [Status, string, string][] = [
  [
    'ongoing',
    'Being reported now',
    'No election is being reported today. The next one is under Upcoming.',
  ],
  ['upcoming', 'Upcoming', 'Nothing scheduled.'],
  ['completed', 'Completed', 'No election has been reported through Hawkeye yet.'],
];

export default function Races() {
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [soonOpen, setSoonOpen] = useState<string | null>(null);
  const [govOpen, setGovOpen] = useState(false);
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [contests, setContests] = useState<Contest[] | null>(null);
  const [political, setPolitical] = useState<Political | null>(null);

  useEffect(() => {
    let live = true;
    api
      .contests()
      .then((c) => live && setContests(c))
      .catch(() => live && setContests([]));
    loadPolitical()
      .then(({ data }) => live && setPolitical(data))
      .catch(() => live && setPolitical({}));
    return () => {
      live = false;
    };
  }, []);

  const items = useMemo<Item[] | null>(() => {
    if (!contests || !political) return null;
    const out: Item[] = [];
    for (const c of [...contests].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code))) {
      out.push({
        name: label(c),
        desc: DESC[c.code] ?? '',
        date: c.date,
        status: statusOf(c.date),
        // WHERE THIS CATEGORY GOES.
        //
        // This used to be "the presidency, or nowhere", which was true when only
        // the presidency had a page — so Senate, House of Reps and State
        // Assembly each showed a "Soon" pill and did nothing when tapped. They
        // all have somewhere to go now: a national board at the contest's own
        // level (109 districts for the Senate, 360 constituencies for the House),
        // and per-seat pages beneath it. "Soon" was describing the app of a
        // month ago.
        //
        // Same destinations Home's cards use — see (tabs)/index.tsx:cardHref, and
        // keep the two in step. A governorship still expands to its 28 states
        // rather than linking anywhere itself.
        href:
          c.code === 'PRES'
            ? '/candidates'
            : c.code === 'GOV'
              ? null
              : `/(tabs)/results?contest=${encodeURIComponent(c.code)}`,
        states: c.code === 'GOV' ? (c.states ?? []) : undefined,
      });
    }
    // A finished election leaves the catalogue, but its page stays up — a record
    // nobody can reach is not a record.
    for (const [key, value] of Object.entries(political as Record<string, unknown>)) {
      const r = value as RaceData | undefined;
      if (!r?.join?.value || !r.date) continue;
      if (statusOf(r.date) !== 'completed') continue;
      out.push({
        name: `${r.join.value} ${r.office?.includes('Governor') ? 'Governorship' : 'Race'} (${String(r.date).slice(0, 4)})`,
        desc: r.stats?.candidates
          ? `${r.stats.candidates} candidates · ${r.stats.lgas} LGAs · the full result, permanently.`
          : 'The full result, permanently.',
        date: r.date,
        status: 'completed',
        href: key === 'raceOsun2026' ? '/osun' : `/race?key=${encodeURIComponent(key)}`,
      });
    }
    return out;
  }, [contests, political]);

  /** Every state with a governorship page — the register's own list, less the
   *  FCT, which has no governor. Split by whether it is on this cycle's ballot. */
  const govStates = useMemo(() => {
    const all = Object.keys(political?.stateStats ?? {})
      .filter((s) => s !== 'FCT')
      .sort();
    const cycle = new Set(
      (items?.find((i) => i.states)?.states ?? []).map((s) => s.toLowerCase()),
    );
    return { all, on: all.filter((s) => cycle.has(s.toLowerCase())), off: all.filter((s) => !cycle.has(s.toLowerCase())) };
  }, [political, items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items?.length ?? 0 };
    for (const [k] of GROUPS) c[k] = items?.filter((i) => i.status === k).length ?? 0;
    return c;
  }, [items]);

  const chip = (key: Status | 'all', text: string) => {
    const on = filter === key;
    return (
      <Pressable
        key={key}
        onPress={() => setFilter(key)}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        className={`mb-2 mr-2 rounded-full px-3.5 py-1.5 ${on ? 'bg-hawk-green' : 'border border-line bg-surface'}`}
      >
        <Text className={`text-xs font-semibold ${on ? 'text-hawk-gold' : 'text-muted'}`}>
          {text} {counts[key] ?? 0}
        </Text>
      </Pressable>
    );
  };

  const stateChips = (states: string[]) => (
    <View className="flex-row flex-wrap pt-1.5">
      {states.map((s) => (
        <Pressable
          key={s}
          onPress={() => router.push(`/race?contest=GOV&state=${encodeURIComponent(s)}` as never)}
          className="mb-2 mr-2 rounded-full border border-line bg-surface px-3 py-1.5 active:opacity-70"
        >
          <Text className="text-xs font-semibold text-good-ink">{s}</Text>
        </Pressable>
      ))}
    </View>
  );

  const renderItem = (r: Item) => {
    const open = soonOpen === r.name;
    // "Open" read as "reporting is open" on a row whose own date says January
    // 2027 — on an election app that is the wrong thing to be ambiguous about.
    // It was only ever meant as "open this page", so it says what it does.
    const pill = r.status === 'completed' ? 'Result' : r.status === 'ongoing' ? 'Live' : 'View';
    const body = (
      <View className="flex-1 pr-3">
        <Text className="text-base font-bold text-ink">{r.name}</Text>
        <Text className="pt-0.5 text-xs text-muted">{r.desc}</Text>
        {r.date ? <Text className="pt-0.5 text-xs text-muted">{fmt(r.date)}</Text> : null}
        {!r.href && !r.states && open ? (
          <Text className="pt-2 text-xs font-semibold text-warn-ink">{SOON}</Text>
        ) : null}
      </View>
    );

    // The governorship row is not a link — it opens a list of the states, each
    // of which has its own page.
    if (r.states) {
      return (
        <View key={r.name} className="mb-3 rounded-2xl bg-card px-4 py-3.5">
          <Pressable
            onPress={() => setGovOpen((v) => !v)}
            className="flex-row items-center active:opacity-80"
          >
            {body}
            <View className="flex-row items-center">
              <View className="rounded-full bg-hawk-green px-3 py-1">
                <Text className="text-xs font-bold text-hawk-gold">{r.states.length} states</Text>
              </View>
              <Feather
                name={govOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={ui.faint}
                style={{ marginLeft: 2 }}
              />
            </View>
          </Pressable>
          {govOpen ? (
            <View className="pt-2">
              {govStates.on.length ? (
                <>
                  <Text className="pt-1 text-[11px] text-muted">
                    On the {r.date ? fmt(r.date) : 'general-election'} ballot — {govStates.on.length} states
                  </Text>
                  {stateChips(govStates.on)}
                </>
              ) : null}
              {govStates.off.length ? (
                <>
                  <Text className="pt-1 text-[11px] text-muted">
                    Off-cycle — these states vote for governor separately, and Hawkeye has no date
                    for them yet
                  </Text>
                  {stateChips(govStates.off)}
                </>
              ) : null}
            </View>
          ) : null}
        </View>
      );
    }

    return (
      <Pressable
        key={r.name}
        onPress={() => (r.href ? router.push(r.href as never) : setSoonOpen(open ? null : r.name))}
        className="mb-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-80"
      >
        {body}
        {r.href ? (
          <View className="flex-row items-center">
            <View className="rounded-full bg-hawk-green px-3 py-1">
              <Text className="text-xs font-bold text-hawk-gold">{pill}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={ui.faint} style={{ marginLeft: 2 }} />
          </View>
        ) : (
          <View className="rounded-full border border-line px-3 py-1">
            <Text className="text-xs font-semibold text-muted">Soon</Text>
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Races" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        {/* No in-page "Races" heading: ScreenHeader above already says it, and
            the two sat one line apart. The subtitle is what this space is for. */}
        <View className="flex-row items-center">
          <Text className="flex-1 text-sm text-muted">
            Pick a race to follow, report on, or verify.
          </Text>
          <InfoDot
            title="How races are grouped"
            text="Ongoing is an election being reported today. Upcoming is one whose polling day is still ahead. Completed is one whose polling day has passed — its page stays up, because the record is the point. Candidate lists appear on each race's page as INEC publishes them, roughly 28 days out."
          />
        </View>

        {!items ? (
          <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
        ) : (
          <>
            <View
              className="flex-row flex-wrap pt-4"
              accessibilityRole="radiogroup"
              accessibilityLabel="Filter races by status"
            >
              {chip('all', 'All')}
              {GROUPS.map(([k, title]) =>
                chip(k, title === 'Being reported now' ? 'Ongoing' : title),
              )}
            </View>

            {GROUPS.filter(([k]) => filter === 'all' || filter === k).map(([k, title, empty]) => {
              const mine = items.filter((i) => i.status === k);
              return (
                <View key={k} className="pt-5">
                  <Text className="pb-2 text-[11px] font-bold uppercase tracking-wider text-faint">
                    {title}
                  </Text>
                  {mine.length ? (
                    mine.map(renderItem)
                  ) : (
                    <Text className="text-xs text-muted">{empty}</Text>
                  )}
                </View>
              );
            })}
          </>
        )}
      </Animated.ScrollView>
    </View>
  );
}
