import Feather from '@expo/vector-icons/Feather';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { FlashList } from '@shopify/flash-list';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';

import { HeaderControls } from '@/components/header-controls';
import { PracticeDayCard } from '@/components/practice-day-card';
import { ScreenHeader } from '@/components/screen-header';
import { Tour } from '@/components/tour';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { useForegroundInterval } from '@/hooks/use-foreground-interval';
import { BRAND, api, electionTitle, type Contest, type IntegritySummary } from '@/lib/api';
import { authedGet, getToken, useAuth } from '@/lib/auth';
import { onMyUnitSaved, type SavedUnit } from '@/lib/my-unit';
import { markRead, openNotificationTarget, refreshUnread } from '@/lib/push';
import { bust, fresh } from '@/lib/signed-in-cache';
import { useUi, type Tone } from '@/lib/theme';
import { dayMonth, longDate } from '@/lib/dates';
import { t as i18nT, lazyT, useI18n, useT } from '@/lib/i18n';
import { flagLabel } from '@/lib/flags';
import { KIND_LABEL } from '@/lib/incident-kinds';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const REFRESH_MS = 30_000;

/**
 * Where an election card goes.
 *
 * The presidency has its own screen; a governorship confined to ONE state has a
 * per-state race screen; a by-election is a single seat and has one too.
 * Everything else (a nationwide governorship across 28 states, National
 * Assembly, State Assembly) is 28, 109, 360 or 1,005 seats with no single page
 * to open, so the board for that contest is the honest destination — it is the
 * screen that is actually about that election, and the selection it offers is
 * the point rather than a detour.
 */
// Every branch ends in a query string, so the caller can append `&n=` without
// having to know which one it got.
function cardHref(c: Contest): string {
  if (c.code === 'PRES') return '/candidates?from=home';
  if (c.code === 'GOV' && c.states?.length === 1) {
    return `/race?contest=GOV&state=${encodeURIComponent(c.states[0])}`;
  }
  /**
   * A BY-ELECTION IS ONE SEAT, SO IT OPENS THAT SEAT.
   *
   * `constituencies` present means the whole election is those places, and for
   * every by-election it is exactly one. Sending those to the board produced a
   * page describing a single constituency as if it were a category — "Leading
   * party by federal constituency in Gombe" over a map with one shape, and
   * "Help cover Gombe" — an intermediate step whose only content was a worse
   * version of the race page behind it.
   *
   * The link needs nothing but the code: the contest names its own seat and
   * state, in the same allowlist the backend gates reports with, so the screen
   * and the gate cannot describe different places (see app/race.tsx).
   *
   * The web twin already did this — app/races.html has branched on
   * `constituencies.length` since by-elections were added. This is Home
   * catching up, not a new rule.
   */
  if (c.constituencies?.length) return `/race?contest=${encodeURIComponent(c.code)}`;
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
/** Unknown codes sort after the five known ones rather than before them, which
 *  is where indexOf's -1 would put them. */
const magnitude = (code: string) => {
  const i = CARD_ORDER.indexOf(code);
  return i === -1 ? CARD_ORDER.length : i;
};

/**
 * SOONEST FIRST — date, then seat magnitude, then name.
 *
 * This used to sort by magnitude alone, which is right for a catalogue and
 * wrong for a list headed "upcoming": it put a presidential election eleven
 * months out above a by-election happening in three weeks. INEC runs
 * by-elections between the general rounds (there are some in September), and
 * those are exactly the ones an observer can act on next.
 *
 * Dates are ISO, so a string compare is a date compare. Anything already past
 * sorts to the very end regardless — a finished election is not upcoming, and
 * a plain ascending sort would have led with the oldest one.
 */
const CARDS_SHOWN = 2;
/**
 * AND PAST ELECTIONS LEAVE IT ENTIRELY.
 *
 * Sorting them to the end was not enough: after the five by-elections of 19
 * September the home screen still offered "Report from your polling unit now"
 * on four seats that had been decided, under a heading that says upcoming.
 * Sorting fixed the order of a list that should not have contained them.
 *
 * Reporting genuinely does stay open after polling day — a sheet photographed
 * on Saturday is still worth having — so this hides the card, not the route:
 * Results and Races still reach every past contest, and a deep link still
 * opens it.
 */
const orderedContests = (cs: Contest[] | null) => {
  const today = new Date().toISOString().slice(0, 10);
  return [...(cs ?? [])].filter((c) => !(c.date && c.date < today)).sort((a, b) => {
    const ad = a.date ?? '';
    const bd = b.date ?? '';
    const apast = ad !== '' && ad < today;
    const bpast = bd !== '' && bd < today;
    if (apast !== bpast) return apast ? 1 : -1;
    if (ad !== bd) return ad === '' ? 1 : bd === '' ? -1 : ad.localeCompare(bd);
    const m = magnitude(a.code) - magnitude(b.code);
    if (m !== 0) return m;
    return electionTitle(a, cs).localeCompare(electionTitle(b, cs));
  });
};

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

/**
 * "Opens in 1 days" is what a single plural string gets you, and it was on the
 * home screen the day before a by-election.
 *
 * THREE CASES, not two. daysUntil clamps at 0, so on polling morning - before
 * 08:30, when the contest is still closed - the same string read "Opens in 0
 * days", which is worse than the plural slip and was on the same expression.
 *
 * ENGLISH IS THE ONLY LANGUAGE THAT NEEDS THE SPLIT here: Hausa "kwana {v0}",
 * Igbo "ubochi {v0}" and Yoruba "ojo {v0}" do not inflect the noun for number,
 * so their singular and plural values are deliberately the same sentence. The
 * split lives in the KEY rather than in a count rule, because a count rule that
 * is right for English is wrong for languages with more than two forms.
 */
function opensIn(days: number) {
  if (days <= 0) return i18nT('n.app.tabs.index.opens-today');
  if (days === 1) return i18nT('n.app.tabs.index.opens-in-day', { v0: days });
  return i18nT('n.app.tabs.index.opens-in-days', { v0: days });
}

function ago(ts: number) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return i18nT('n.app.ledger.min-ago', { v0: m });
  const h = Math.round(m / 60);
  if (h < 48) return i18nT('n.lib.dates.hours-ago', { v0: h });
  return dayMonth(new Date(ts));
}

type Kind = 'report' | 'incident' | 'flag' | 'case';

type Item = {
  id: string;
  kind: Kind;
  at: number;
  /** The English fallback, and what a row shows when it has nothing keyed. */
  title: string;
  /* WHAT THE TITLE MEANS, not what it said when it was fetched. A stored
     translation is a stale translation the moment the reader switches
     language; these are resolved in the row, on every paint. */
  titleKey?: string;
  titleVars?: Record<string, string | number>;
  /** A server enum (incident kind, flag type) the row names for itself. */
  titleEnum?: 'incident' | 'flag';
  detail: string;
  href?: string;
};

/** One row's heading, resolved at paint. See the note on Item.titleKey. */
function itemTitle(it: Item): string {
  if (it.titleEnum === 'incident') return KIND_LABEL[it.title] ?? it.title.replace(/_/g, ' ');
  if (it.titleEnum === 'flag') return flagLabel(it.title);
  return it.titleKey ? i18nT(it.titleKey, it.titleVars) : it.title;
}

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

/* The docket's four statuses, as the resolved-case row reads them. */
const CASE_STATUS: Record<string, string> = lazyT({
  open: 'n.app.tabs.index.status-open',
  upheld: 'n.app.tabs.index.status-upheld',
  unresolved: 'n.app.tabs.index.status-unresolved',
  cleared: 'n.app.tabs.index.status-cleared',
});

const FILTERS: { key: Kind | 'all'; label: string }[] = lazyT([
  { key: 'all', label: 'n.app.tabs.index.filter-everything' },
  { key: 'report', label: 'n.app.tabs.index.filter-reports' },
  { key: 'incident', label: 'n.app.tabs.index.filter-incidents' },
  { key: 'flag', label: 'n.app.tabs.index.filter-flags' },
  { key: 'case', label: 'n.app.tabs.index.filter-cases' },
]);

/**
 * "TRY A PRACTICE RUN — 5 MINUTES", for a signed-in observer who never has.
 *
 * The SERVER decides whether it may show (GET /api/practice/nudge — the web
 * home asks the same question): never practised on their device, the sandbox
 * open, and no National Practice Day near. At most one practice card: while
 * this shows, the Practice Day card is not rendered; on and around a Practice
 * Day the server says no and that card holds the slot. Dismissal is per
 * observer, on this device. Asked again on every focus, so coming back from a
 * practice run hides it. Any failure leaves it hidden.
 */
const nudgeKey = (id: number) => `hawkeye.practiceNudge.dismissed.${id}`;

function usePracticeNudge(): [boolean, () => void] {
  const auth = useAuth();
  const observerId = auth.status === 'signedIn' ? auth.observerId : null;
  const [show, setShow] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (!observerId) {
        setShow(false);
        return undefined;
      }
      (async () => {
        try {
          if ((await AsyncStorage.getItem(nudgeKey(observerId))) === '1') {
            if (alive) setShow(false);
            return;
          }
        } catch {
          /* unreadable flag: ask the server anyway; dismissing again is cheap */
        }
        try {
          const r = await authedGet<{ show?: boolean }>('/api/practice/nudge', { signOutOn401: false });
          if (alive) setShow(r?.show === true);
        } catch {
          if (alive) setShow(false);
        }
      })();
      return () => {
        alive = false;
      };
    }, [observerId]),
  );

  const dismiss = useCallback(() => {
    setShow(false);
    if (observerId) AsyncStorage.setItem(nudgeKey(observerId), '1').catch(() => {});
  }, [observerId]);

  return [show, dismiss];
}

function PracticeNudgeCard({ onDismiss }: { onDismiss: () => void }) {
  const ui = useUi();
  const practise = () => router.push('/practice' as never);
  return (
    <Pressable
      className="mb-3 rounded-2xl border-l-4 border-hawk-gold bg-card px-4 py-4 active:opacity-90"
      onPress={practise}
      accessibilityRole="button"
    >
      <View className="flex-row items-center">
        <Feather name="play-circle" size={16} color={ui.tint.good.ink} />
        <Text className="flex-1 pl-2 text-[15px] font-bold text-ink">
          {i18nT('n.app.tabs.index.practice-nudge-title')}
        </Text>
        <Pressable
          onPress={onDismiss}
          hitSlop={12}
          className="-my-2 -mr-2 rounded-full p-2 active:opacity-60"
          accessibilityRole="button"
          accessibilityLabel={i18nT('n.app.tabs.index.practice-nudge-dismiss')}
        >
          <Feather name="x" size={18} color={ui.faint} />
        </Pressable>
      </View>
      <Text className="pt-2 text-[14px] leading-5 text-ink">{i18nT('n.app.tabs.index.practice-nudge-sub')}</Text>
      <View className="flex-row pt-3">
        <Pressable
          onPress={practise}
          className="rounded-full bg-hawk-gold px-4 py-2.5 active:opacity-80"
          accessibilityRole="button"
        >
          <Text className="text-sm font-bold text-hawk-green">{i18nT('n.app.tabs.index.practice-nudge-go')}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

/** The observer's own record, as /api/observers/me sends the parts Home reads. */
type Me = {
  observerId: number;
  unit?: SavedUnit | null;
  reports?: unknown[];
  collation?: unknown[];
  incidents?: unknown[];
  subscriptions?: unknown[];
};
type Note = { id: number; title: string; url: string | null; read: 0 | 1; created_at: number };

/** Today in Lagos, as the ISO date the catalogue writes. */
const lagosToday = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);

/**
 * 1. THE NEXT STEP — the practice nudge's shape, without the ×: these are not
 * suggestions to dismiss, they are what the observer has to do (choose a unit,
 * or report now while the polls are open). The web's #home-next twin.
 */
function NextStepCard({ icon, title, sub, go, onPress }: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  sub: string;
  go: string;
  onPress: () => void;
}) {
  const ui = useUi();
  return (
    <Pressable
      className="mb-3 rounded-2xl border-l-4 border-hawk-gold bg-card px-4 py-4 active:opacity-90"
      onPress={onPress}
      accessibilityRole="button"
    >
      <View className="flex-row items-center">
        <Feather name={icon} size={16} color={ui.tint.good.ink} />
        <Text className="flex-1 pl-2 text-[15px] font-bold text-ink">{title}</Text>
      </View>
      <Text className="pt-2 text-[14px] leading-5 text-ink">{sub}</Text>
      <View className="flex-row pt-3">
        <View className="rounded-full bg-hawk-gold px-4 py-2.5">
          <Text className="text-sm font-bold text-hawk-green">{go}</Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * 2. GREETING + UNIT — the web hero's two lines and its unit chip. The chip
 * opens the chooser (/choose-unit), the same page Profile's row opens.
 */
function Greeting({ me }: { me: Me | null | undefined }) {
  const ui = useUi();
  const u = me?.unit ?? null;
  // A saved unit IS the alerts subscription, so the chip says so (owner,
  // 2026-10-04: "· Alerts on" on the chip replaced a separate subtext line).
  const where = u
    ? [u.name || u.pu_code, [u.lga, u.state].filter(Boolean).join(', '), i18nT('index.alerts-on')].filter(Boolean).join(' · ')
    : '';
  return (
    <View className="mb-3 px-1">
      <Text className="text-2xl font-bold text-ink">
        {me ? i18nT('index.welcome-back-observer', { id: me.observerId }) : i18nT('index.welcome-back')}
      </Text>
      <Pressable
        onPress={() => router.push({ pathname: '/choose-unit', params: u ? { current: u.pu_code } : {} } as never)}
        className="mt-3 flex-row items-center self-start rounded-full border border-line bg-card px-3.5 py-2 active:opacity-80"
        accessibilityRole="button"
      >
        <Feather name="map-pin" size={14} color={ui.tint.good.ink} />
        <Text className="shrink pl-2 text-sm text-ink" numberOfLines={2}>
          {u ? where : i18nT('n.app.tabs.index.save-your-unit')}
        </Text>
      </Pressable>
    </View>
  );
}

/** A card heading with its "All … →" pill — the web .home-card h2 shape. */
function CardHead({ title, link, onPress }: { title: string; link?: string; onPress?: () => void }) {
  return (
    <View className="flex-row items-center justify-between pb-1">
      <Text className="flex-1 pr-2 text-[15px] font-bold text-ink">{title}</Text>
      {link && onPress ? (
        <Pressable onPress={onPress} hitSlop={8} className="rounded-full bg-surface px-3 py-1.5 active:opacity-70" accessibilityRole="button">
          <Text className="text-xs font-bold text-good-ink">{link}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 4. UNREAD ALERTS, at most three — the web's Latest Alerts. Opening one marks
 * it read and goes straight to what it is about (the Alerts tab keeps the full
 * text); a failed receipt is caught up by the next read of the feed.
 */
function AlertsCard({ notes, failed, onOpen }: { notes: Note[] | null; failed: boolean; onOpen: (n: Note) => void }) {
  const ui = useUi();
  const unread = (notes ?? []).filter((n) => !n.read).slice(0, 3);
  return (
    <View className="mb-3 rounded-2xl bg-card px-4 pb-1.5 pt-3.5">
      <CardHead title={i18nT('index.latest-alerts')} link={i18nT('index.all-alerts')} onPress={() => router.push('/alerts' as never)} />
      {notes === null ? (
        failed ? (
          <Text className="py-2 text-sm text-muted">{i18nT('n.app.tabs.index.could-not-reach')}</Text>
        ) : (
          <ActivityIndicator className="py-2" color={ui.tint.good.ink} />
        )
      ) : unread.length === 0 ? (
        <Text className="py-2 text-sm text-muted">
          {notes.length ? i18nT('n.app.tabs.index.all-caught-up') : i18nT('index.nothing-yet-alerts')}
        </Text>
      ) : (
        unread.map((n, i) => (
          <Pressable
            key={n.id}
            onPress={() => onOpen(n)}
            className={`flex-row items-center py-2.5 active:opacity-70 ${i ? 'border-t border-line' : ''}`}
            accessibilityRole="button"
          >
            <View className="h-2 w-2 rounded-full bg-hawk-gold" />
            <Text className="flex-1 px-2.5 text-sm text-ink" numberOfLines={2}>{n.title}</Text>
            <Text className="text-[11px] text-faint">{ago(n.created_at)}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

/**
 * 5. REPORT ACTIONS — the web's four quick actions, same words, same places:
 * result (primary), incident, collation, and the unit (Map a Polling Unit,
 * which also saves it — the web tile opens map-unit.html).
 */
const ACTIONS: { href: string; icon: keyof typeof Feather.glyphMap; title: string; sub: string; primary?: boolean }[] = [
  { href: '/report/result', icon: 'camera', title: 'common.report-a-result', sub: 'index.photograph-the-ec8a-sheet-at-your', primary: true },
  { href: '/report/incident', icon: 'alert-triangle', title: 'common.report-an-incident', sub: 'index.violence-vote-buying-bvas-failure' },
  { href: '/report/collation', icon: 'layers', title: 'index.collation-result', sub: 'index.ward-lga-or-state-collation-ec8b' },
  { href: '/map-unit', icon: 'map-pin', title: 'index.my-polling-unit', sub: 'index.save-or-map-your-unit-for' },
];

function ReportActions() {
  const ui = useUi();
  return (
    <View className="mb-3" style={{ gap: 12 }}>
      {[ACTIONS.slice(0, 2), ACTIONS.slice(2)].map((row, r) => (
        <View key={r} className="flex-row" style={{ gap: 12 }}>
          {row.map((a) => (
            <Pressable
              key={a.href}
              onPress={() => router.push(a.href as never)}
              className={`flex-1 rounded-2xl px-4 py-3.5 active:opacity-80 ${a.primary ? 'bg-hawk-green' : 'bg-card'}`}
              accessibilityRole="button"
            >
              <Feather name={a.icon} size={22} color={a.primary ? BRAND.gold : ui.tint.good.ink} />
              <Text className={`pt-2 text-[15px] font-bold ${a.primary ? 'text-white' : 'text-ink'}`}>{i18nT(a.title)}</Text>
              <Text className={`pt-1 text-xs leading-4 ${a.primary ? 'text-emerald-100' : 'text-muted'}`}>{i18nT(a.sub)}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

/** 6. MY ACTIVITY — the web card's three counts; the card opens Profile. */
function ActivityCard({ me }: { me: Me }) {
  const stats: [number, string][] = [
    [(me.reports?.length ?? 0) + (me.collation?.length ?? 0), 'index.result-reports'],
    [me.incidents?.length ?? 0, 'index.incidents'],
    [me.subscriptions?.length ?? 0, 'index.races-followed'],
  ];
  return (
    <Pressable onPress={() => router.push('/profile' as never)} className="mb-3 rounded-2xl bg-card px-4 pb-3 pt-3.5 active:opacity-90" accessibilityRole="button">
      <CardHead title={i18nT('n.app.profile.my-activity')} />
      <View className="flex-row pt-1">
        {stats.map(([n, k], i) => (
          <View key={k} className={`flex-1 items-center py-1.5 ${i ? 'border-l border-line' : ''}`}>
            <Text className="text-xl font-bold text-good-ink">{n}</Text>
            <Text className="text-center text-[11px] text-muted">{i18nT(k)}</Text>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

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
  /* SUBSCRIBE THIS SCREEN TO THE LANGUAGE. lazyT resolves a label when it is
     READ, which only helps if this screen paints again — and a tab that is
     already mounted does not always. useT() puts it on the context, so a
     language change repaints the chips and the feed with everything else
     instead of waiting for a cold start. */
  useT();
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();
  const [contests, setContests] = useState<Contest[] | null>(null);
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  /** Two election cards by default; the rest are one tap away. Five full-width
   *  cards pushed the live activity feed — the thing that changes hour to hour —
   *  entirely below the fold on a phone. */
  const [allElections, setAllElections] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /* A FLAG, NOT A SENTENCE: the words are resolved at paint, so a language
     change repaints them (a stored translation is stale the moment it lands). */
  const [offline, setOffline] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [practiceNudge, dismissPracticeNudge] = usePracticeNudge();
  const auth = useAuth();
  const signedIn = auth.status === 'signedIn';
  const { lang } = useI18n();
  /* The observer's own record and unread alerts (signed in only).
     undefined = not asked yet, null = the read failed. */
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);

  /**
   * The account side: /me (greeting, unit, next step, My Activity) and the
   * alerts feed. D6: through the 120 s signed-in cache (lib/signed-in-cache.ts),
   * which a push ends early, so the 30 s poll does not re-read the account each
   * time — and two callers at once (mount + focus) share one request.
   */
  const loadMine = useCallback(async (force = false) => {
    if (!signedIn) return;
    const [m, n] = await Promise.all([
      fresh('/api/observers/me', getToken(), () => authedGet<Me>('/api/observers/me'), { force }).catch(() => null),
      fresh(`/api/notifications?lang=${lang}`, getToken(),
        () => authedGet<{ items: Note[] }>(`/api/notifications?lang=${encodeURIComponent(lang)}`, { signOutOn401: false }),
        { force }).catch(() => null),
    ]);
    // A failed read keeps what was already on screen; only a first failure is null.
    setMe((prev) => m ?? (prev === undefined ? null : prev));
    if (n) setNotes(n.items ?? []);
    setNotesFailed(!n);
  }, [signedIn, lang]);

  const load = useCallback(async (force = false) => {
    const mine = loadMine(force);
    const [c, i, ledger, incidents, flags, docket] = await Promise.all([
      api.contests().catch(() => null),
      api.integrity().catch(() => null),
      // The 40 rows the feed draws, and only the columns it reads. The bare call
      // was the newest 1,000 rows with every ledger payload — ~2 MB every 30 s
      // of the observer's own data (ELECTION-NIGHT-HOSTING.md §5 item 4).
      jget<{ id: number; pu_code: string; contest: string; created_at: number }[]>(
        '/api/ledger/entries?limit=40&fields=feed',
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
      }>(
        // The newest 30 cases, like the 30 flags above: the feed shows 80 rows
        // across every source. The bare call was every case (~85 KB at 300).
        '/api/docket?limit=30',
      ),
    ]);

    if (c) setContests(c);
    if (i) setIntegrity(i);
    await mine;
    /**
     * Every source failing at once means the network is gone, not that nothing
     * is happening — the two look identical otherwise.
     *
     * AND THE SPINNER STOPS (flow walkthrough FA-X8-1). This returned before
     * setItems, so with no signal the feed's ActivityIndicator spun forever
     * under the error line, and the only retry was a pull-to-refresh nobody
     * knows about. Now the feed settles (empty, or what it already showed),
     * the line carries a Try again, and coming back online retries by itself
     * (the NetInfo effect below).
     */
    if (!c && !ledger && !incidents) {
      setOffline(true);
      setItems((prev) => prev ?? []);
      return;
    }
    setOffline(false);

    const merged: Item[] = [];

    for (const e of (ledger ?? []).slice(-40)) {
      merged.push({
        id: `r${e.id}`,
        kind: 'report',
        at: e.created_at,
        title: e.contest,
        titleKey: 'n.app.tabs.index.result-reported',
        titleVars: { v0: e.contest },
        detail: e.pu_code,
        href: '/reports-log',
      });
    }
    for (const n of incidents?.incidents ?? []) {
      merged.push({
        id: `i${n.id}`,
        kind: 'incident',
        at: n.created_at,
        title: n.kind,
        titleEnum: 'incident',
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
        title: d.type,
        titleEnum: 'flag',
        detail: d.detail?.summary?.slice(0, 90) || [d.pu_name, d.state].filter(Boolean).join(' · '),
        href: '/integrity',
      });
    }
    for (const k of docket?.cases ?? []) {
      merged.push({
        id: `c${k.id}`,
        kind: 'case',
        at: k.resolvedAt ?? k.openedAt,
        title: k.status,
        titleKey: k.resolvedAt ? 'n.app.tabs.index.case-resolved' : 'n.app.tabs.index.case-opened',
        titleVars: k.resolvedAt ? { v0: k.status } : undefined,
        detail: `${k.name || k.puCode} · ${k.contest}`,
        href: `/case?id=${k.id}`,
      });
    }

    merged.sort((a, b) => b.at - a.at);
    setItems(merged.slice(0, 80));
  }, [loadMine]);

  // Six requests every 30 s — only while the app is in the foreground
  // (hooks/use-foreground-interval). Tabs stay mounted in a pocket.
  useForegroundInterval(load, REFRESH_MS);

  /* Signed out (or a different account): nothing of the last one stays up. */
  useEffect(() => {
    if (signedIn) return;
    setMe(undefined);
    setNotes(null);
  }, [signedIn]);

  /* Back from the chooser, Home's unit line and next step update at once. */
  useEffect(() => onMyUnitSaved((unit) => {
    bust('/api/observers/me');
    setMe((m) => (m ? { ...m, unit } : m));
  }), []);

  /* Coming back to Home (from Alerts, a report, Profile) re-reads the account
     side through the cache — the alerts read there are not unread here. */
  useFocusEffect(useCallback(() => {
    void loadMine();
  }, [loadMine]));

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try { await load(true); } finally { setRetrying(false); }
  }, [load, retrying]);

  /* RECONNECTING RETRIES BY ITSELF (FA-X8-1): the offline -> online edge only.
     `offlineNow` is read through a ref so the listener is not re-subscribed on
     every failure. A build without the NetInfo module keeps Try again and the
     30 s poll. */
  const offlineNow = useRef(false);
  offlineNow.current = offline;
  useEffect(() => {
    let up = true;
    let unsub: (() => void) | undefined;
    try {
      unsub = NetInfo.addEventListener((s) => {
        const now = s.isConnected !== false && s.isInternetReachable !== false;
        if (now && !up && offlineNow.current) void load(true);
        up = now;
      });
    } catch {
      /* no native module in this build */
    }
    return () => unsub?.();
  }, [load]);

  /* Opening an alert from Home: read on screen now, then where it points. */
  const openNote = useCallback((n: Note) => {
    setNotes((list) => list?.map((x) => (x.id === n.id ? { ...x, read: 1 as const } : x)) ?? list);
    bust(`/api/notifications?lang=${lang}`);
    markRead(n.id).catch(() => refreshUnread());
    openNotificationTarget(n.url);
  }, [lang]);

  const shown = useMemo(
    () => (filter === 'all' ? items : (items ?? []).filter((x) => x.kind === filter)),
    [items, filter],
  );

  /* ONE ordered list, used by the cards AND the show-more control. They used to
     be computed apart — the cards from orderedContests(), the count from the raw
     `contests` — so every past election stayed in the count after it stopped
     rendering. With the five by-elections of 19 September decided, the bar
     offered four more elections than existed, and had they all been past it
     would have offered to expand nothing. */
  const ordered = useMemo(() => orderedContests(contests), [contests]);

  /**
   * 1. THE NEXT STEP, most urgent first — and only one (FA-HOME-2: this screen
   * never told a new observer to choose a unit):
   *   polls open today        → Report now
   *   no polling unit saved   → Choose your polling unit
   *   otherwise the practice nudge, or the Practice Day card.
   * "No unit" waits for /me: an unknown unit is not a missing one.
   */
  const liveContest = useMemo(() => {
    const today = lagosToday();
    return (contests ?? []).find((c) => c.open && c.date === today) ?? null;
  }, [contests]);
  const nextStep = liveContest ? (
    <NextStepCard
      icon="camera"
      title={i18nT('index.next-report-title')}
      sub={i18nT('index.next-report-sub')}
      go={i18nT('index.next-report-go')}
      onPress={() => router.push(`/report/result?contest=${encodeURIComponent(liveContest.code)}` as never)}
    />
  ) : signedIn && me && !me.unit ? (
    <NextStepCard
      icon="map-pin"
      title={i18nT('index.next-unit-title')}
      sub={i18nT('index.next-unit-sub')}
      go={i18nT('index.next-unit-go')}
      onPress={() => router.push('/choose-unit' as never)}
    />
  ) : null;

  /**
   * ONE ORDER ON EVERY SURFACE (flow walkthrough FA-HOME-1). This screen was a
   * public feed while the web and Lite Home was a personal dashboard; all three
   * now read, top to bottom:
   *   1 the next step   2 greeting + unit   3 the two soonest elections
   *   4 unread alerts   5 report actions   6 My Activity
   *   7 the live feed (stats, filters, rows)   8 Chat (the list's footer)
   * Web twin: app/index.html, same order. The account parts (2, 4, 6) show
   * signed in only.
   */
  const header = (
    <View className="px-4">

      {/* Two contests can share one election NAME — Senate and House of
          Representatives are both the "2027 National Assembly Election" — so
          without the office appended this screen showed two identical cards and
          no way to tell which was which. */}

      {offline ? (
        <View className="mb-3 flex-row items-center rounded-2xl bg-warn px-4 py-3">
          <Text className="flex-1 pr-3 text-sm text-ink">{i18nT('n.app.tabs.index.could-not-reach')}</Text>
          <Pressable
            onPress={retry}
            disabled={retrying}
            className="min-h-[40px] items-center justify-center rounded-full bg-hawk-green px-4 active:opacity-80"
            accessibilityRole="button"
          >
            {retrying ? (
              <ActivityIndicator size="small" color={BRAND.gold} />
            ) : (
              <Text className="text-sm font-bold text-hawk-gold">{i18nT('common.try-again')}</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {/* 1 */}
      {signedIn ? <Greeting me={me} /> : null}

      {/* 2 — at most one card, UNDER the greeting (owner, 2026-10-04: leading
          with it looked odd). The nudge only shows when the server says no
          Practice Day is near, so on and around its day that card wins.
          PracticeDayCard renders nothing when there is no day to show. */}
      {nextStep ?? (practiceNudge ? <PracticeNudgeCard onDismiss={dismissPracticeNudge} /> : <PracticeDayCard />)}

      {/* 3 */}

      {(allElections ? ordered : ordered.slice(0, CARDS_SHOWN)).map((c) => (
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
              {c.open ? i18nT('n.app.tabs.index.reporting-open') : i18nT('n.app.tabs.index.upcoming-election')}
            </Text>
            <Text className="pt-1 text-xl font-bold text-white">{cardTitle(c, contests)}</Text>
            <Text className="pt-1 text-sm text-emerald-100">
              {longDate(c.date)}
            </Text>
          </View>
          <View className="flex-row items-center justify-between bg-[#00351e] px-5 py-3">
            <Text className="text-sm font-semibold text-hawk-gold">
              {c.open ? i18nT('n.app.tabs.index.report-from-your-unit-now') : opensIn(daysUntil(c.date))}
            </Text>
            <Feather name="chevron-right" size={16} color={BRAND.gold} />
          </View>
        </Pressable>
      ))}

      {/* Directly under the second card, so it reads as the end of the list
          rather than a control belonging to whatever follows. Named counts, not
          "More": how many are hidden is the thing worth knowing before tapping. */}
      {ordered.length > CARDS_SHOWN ? (
        <Pressable
          onPress={() => setAllElections((v) => !v)}
          className="mb-3 -mt-1 flex-row items-center justify-center rounded-2xl bg-card py-3 active:opacity-80"
          accessibilityRole="button"
        >
          <Text className="text-sm font-bold text-good-ink">
            {allElections
              ? i18nT('n.app.tabs.index.show-fewer-elections')
              : i18nT('n.app.tabs.index.show-more-elections', { v0: ordered.length - CARDS_SHOWN })}
          </Text>
          <Feather
            name={allElections ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={ui.tint.good.ink}
            style={{ marginLeft: 6 }}
          />
        </Pressable>
      ) : null}

      {/* REMOVED from native Home (owner, 2026-10-04: the screen was cluttered;
          native need not mirror Lite): "Latest alerts", "My Activity", the four
          report-action cards (the Report tab does that job) and the "Accepted
          reports" / "Units flagged" counts. AlertsCard / ActivityCard /
          ReportActions stay defined below in case any comes back. */}

      <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
        {i18nT('n.app.tabs.index.live-activity')}
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
      {/* THE FIRST-RUN TOUR LIVES HERE, not in the sign-up handler.
          `router.replace('/(tabs)')` appears at five places in sign-in.tsx —
          password, OTP, two resume paths and browse-without-an-account — and a
          tour hung off one of them would silently miss the other four. This is
          the screen every one of those paths lands on. It opens itself only if
          this device has never seen it, and fails closed. */}
      <Tour auto />
      <ScreenHeader title="Hawkeye" translateY={translateY} right="none" rightSlot={<HeaderControls />} />
      <FlashList
        data={shown ?? []}
        keyExtractor={(x) => x.id}
        ListHeaderComponent={header}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ui.tint.good.ink}
            onRefresh={async () => {
              setRefreshing(true);
              await load(true);
              setRefreshing(false);
            }}
          />
        }
        /* 8 — a person, one tap away: the full-screen support chat (app/chat.tsx).
           Last, as on the web; More carries it too. */
        ListFooterComponent={
          <Pressable
            className="mx-4 mt-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-80"
            onPress={() => router.push('/chat' as never)}
            accessibilityRole="button"
          >
            <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-hawk-green">
              <Feather name="message-square" size={20} color={BRAND.gold} />
            </View>
            <View className="flex-1">
              <Text className="text-[15px] font-bold text-ink">{i18nT('n.app.tabs.index.chat-card-title')}</Text>
              <Text className="pt-0.5 text-[13px] leading-[18px] text-muted">{i18nT('n.app.tabs.index.chat-card-sub')}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={ui.faint} />
          </Pressable>
        }
        ListEmptyComponent={
          // No signal: the line above says so and carries Try again; the feed
          // says nothing rather than "nothing has come in yet", which is false.
          offline && !items?.length ? null : items === null ? (
            <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
          ) : (
            <View className="px-4 pt-2">
              <Text className="text-sm text-muted">
                {filter === 'all'
                  ? i18nT('n.app.tabs.index.nothing-has-come-in-yet')
                  : i18nT('n.app.tabs.index.nothing-of-this-kind-yet')}
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
                <Text className="text-sm font-bold capitalize text-ink">{itemTitle(item)}</Text>
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
