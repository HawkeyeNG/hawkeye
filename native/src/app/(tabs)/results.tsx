import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';

import { ContestPicker } from '@/components/contest-picker';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import {
  asMapLevel,
  LEVEL_WORD,
  loadMapGeo,
  matchRegion,
  regionKey,
  regionLabel,
  ResultsMap,
  type MapLevel,
} from '@/components/results-map';
import { api, BRAND, type Contest, type National, type Party } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import { partyColor, partyName } from '@/lib/political';
import { ELECTION_TYPES, listRaces, STATES, type Race, type StateName } from '@/lib/races';
import { useUi } from '@/lib/theme';
import * as SecureStore from 'expo-secure-store';

const BASE = 'https://hawkeye.com.ng';
const REFRESH_MS = 30_000;

type Row = { party: string; name: string; votes: number; share: number };
type Gaps = { contest: string; statesTotal: number; statesReported: number; missing: string[] };
type Sub = { contest: string; state?: string };

/**
 * One region row of GET /api/national/:contest as the BACKEND actually sends it
 * (backend/src/routes/national.js): region key, a party→votes map, and the
 * region's own reporting counts. `National.regions` in lib/api.ts still declares
 * an older `{ name, rows }` shape that the server does not send, so the read
 * below goes through this type deliberately rather than trusting that decl.
 */
type ApiRegion = {
  region: string;
  votes: Record<string, number>;
  unitsReporting: number;
  unitsVerified: number;
};
const regionsOf = (n: National | null): ApiRegion[] => (n?.regions ?? []) as unknown as ApiRegion[];

/**
 * The party or parties leading a region, from that region's own vote map — the
 * same rule backend/src/routes/national.js applies to fill its `leader` /
 * `leaders` fields, recomputed here rather than read off the wire so that the
 * map's colour and the board's numbers can only ever come from one array of
 * figures. Several tied at the top is a real outcome the map has to show.
 */
function leadersOf(votes: Record<string, number> | undefined): string[] {
  const ranked = Object.entries(votes ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1];
  return top === undefined ? [] : ranked.filter(([, v]) => v === top).map(([p]) => p);
}

/**
 * The region level each contest divides into — the client-side twin of
 * backend/src/routes/national.js:LEVEL. Used only until /api/national answers
 * with its own `level`, so the map's geometry starts downloading with the race
 * instead of one round-trip later. The server's answer always wins.
 */
const LEVEL_FOR_TYPE: Record<string, MapLevel> = {
  PRES: 'state',
  GOV: 'state',
  SHA: 'lga',
  SEN: 'senatorial',
  REP: 'federal',
};

/**
 * How many regions each level HAS, against however many the outline file can
 * draw. They differ for one level: 358 of the 360 federal constituencies have a
 * mapped boundary. The map says so rather than quietly drawing 358 and letting
 * the reader assume that is all of them.
 */
const REGIONS_EXPECTED: Record<MapLevel, number> = {
  state: 37,
  lga: 37,
  senatorial: 109,
  federal: 360,
};

/** One shared empty array, so "outlines not loaded yet" is a stable dependency. */
const NO_SHAPES: string[] = [];

/**
 * The region a report for this race is filed into — mirrors
 * backend/src/routes/subscriptions.js:reportScope, which is also the key
 * /api/national buckets its `regions` by. '' means nationwide (presidential),
 * where the contest-wide tally IS the race's tally.
 */
function scopeOf(race: Race | null): string {
  if (!race) return '';
  if (race.type === 'SEN') return race.district ?? '';
  if (race.type === 'REP') return race.constituency ?? '';
  return race.state ?? '';
}

/** The /api/contests row a race belongs to — the same code + states[] rule the
 *  ContestPicker uses to decide openness, so both agree on what a race is. */
function matchContest(race: Race | null, contests: Contest[]): Contest | null {
  if (!race) return null;
  return (
    contests.find(
      (c) =>
        c.code === race.contestCode &&
        (!c.states || c.states.length === 0 || (race.state != null && c.states.includes(race.state))),
    ) ?? null
  );
}

/**
 * The race the board opens on: the first contest /api/contests lists, resolved
 * to a concrete race. That is the board this screen showed before the picker
 * existed (it read contests[0] directly), so the common path is unchanged — the
 * picker only adds a way to look somewhere else.
 */
function defaultRace(contests: Contest[]): Race | null {
  const c = contests[0];
  if (!c) return null;
  const type = ELECTION_TYPES.find((t) => t.code === c.code);
  if (!type) return null;
  const state = (c.states ?? []).find((s): s is StateName =>
    (STATES as readonly string[]).includes(s),
  );
  return listRaces(type.code, state)[0] ?? null;
}

/** "15 Aug" from an ISO date / opensAt, or the raw string if it will not parse. */
function whenLine(c: Contest): string {
  const raw = c.opensAt || c.date;
  if (!raw) return 'a date that has not been announced';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The Leaderboard — native twin of results.html, which calls itself that in its
 * nav and its <h1>. The screen title matches the website word for word so that
 * "open the Leaderboard" points at something an observer can actually find; the
 * tab bar keeps the shorter "Results" because five tabs share one row and the
 * longer word truncates there.
 *
 * Three things here are not decoration. The board refreshes on a stated cadence
 * and says when it last did, because a stale tally that looks live is worse
 * than no tally. The "not official" line sits ON the board rather than in a
 * footer: a leaderboard without it reads as a declaration, which is the one
 * thing Hawkeye must never look like. And the race being ranked is named and
 * changeable — the same ContestPicker the reporting flows use — so the board is
 * never an unlabelled set of numbers the reader has to assume the subject of.
 *
 * Viewing is not reporting, so the picker runs with allowClosed: looking up a
 * race that has not opened is legitimate, and the answer there is an empty
 * board that SAYS it is empty because reporting has not begun — not a race the
 * app refuses to show.
 */
export default function Results() {
  const auth = useAuth();
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();

  /** The full /api/contests list — the picker's only source of openness. */
  const [contests, setContests] = useState<Contest[]>([]);
  const [contestsLoaded, setContestsLoaded] = useState(false);
  /** The race being ranked. The picker's controlled value and this screen's subject. */
  const [race, setRace] = useState<Race | null>(null);
  const [picking, setPicking] = useState(false);

  const [data, setData] = useState<National | null>(null);
  const [parties, setParties] = useState<Party[]>([]);
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** The last completed fetch could not reach the tally. Kept apart from "no
   *  results", which is a fact about the election, not about the network. */
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  /** The contest the selected race resolves to — null when Hawkeye does not
   *  collect this race yet, which the empty state has to say out loud. */
  const contest = useMemo(() => matchContest(race, contests), [race, contests]);
  const scope = useMemo(() => scopeOf(race), [race]);
  /** What the fetch is actually keyed by, and what the board is keyed by. They
   *  are NOT the same thing — see `load` and `selectRace`. */
  const contestCode = contest?.code ?? null;
  const raceKey = race?.key ?? null;

  const loadContests = useCallback(async () => {
    const cs = await api.contests().catch(() => null);
    setContestsLoaded(true);
    if (!cs) return;
    setContests(cs);
    // Seed only when the observer has not chosen for themselves.
    setRace((r) => r ?? defaultRace(cs));
  }, []);

  /**
   * Only the newest fetch may write. Switching race mid-flight otherwise lets a
   * previous race's tally land under the new race's name — the one failure mode
   * a leaderboard cannot have.
   */
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    if (!contests.length) await loadContests();
    // `raceKey` is read here, and is in the dep list, on purpose: it makes `load`
    // change identity on EVERY selection, so the effect below re-fetches even
    // when the new race sits in the contest already loaded. Without it, two
    // races sharing a contest produce the same `contestCode`, `load` keeps its
    // identity, and no fetch ever follows the selection.
    if (!raceKey || !contestCode) {
      // No race chosen, or no contest behind it: nothing was fetched, so nothing
      // was "updated" either — stamping a time here would dress an absence as fresh.
      if (mine === reqId.current) {
        setData(null);
        setGaps(null);
        setUpdatedAt(null);
        setFailed(false);
      }
      return;
    }
    const [n, p, g] = await Promise.all([
      api.national(contestCode).catch(() => null),
      api.parties().catch(() => [] as Party[]),
      fetch(`${BASE}/api/coverage/gaps?contest=${encodeURIComponent(contestCode)}`)
        .then((r) => (r.ok ? (r.json() as Promise<Gaps>) : null))
        .catch(() => null),
    ]);
    if (mine !== reqId.current) return; // a newer race took over while this was in flight
    if (p.length) setParties(p);
    setFailed(n === null);
    if (n) {
      setData(n);
      setUpdatedAt(Date.now());
    }
    // A failed poll leaves the tally and its timestamp alone: the numbers on
    // screen are still the ones we last really received, and the header's
    // "updated HH:MM:SS" keeps telling the truth about when that was. Same for
    // gaps — null there means the request failed, not that no states are missing.
    if (g) setGaps(g);
  }, [contestCode, raceKey, contests.length, loadContests]);

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

  /**
   * The subscription that already covers this race, if any. A nationwide row
   * (state '') counts: the backend pings it for every region, so claiming "not
   * following" would be false. It is kept as the ROW, not a boolean, because
   * DELETE matches on (contest, state) exactly — unfollowing a nationwide row
   * with this race's region would delete nothing and silently leave the alerts on.
   */
  const followed = useMemo(() => {
    if (!contest) return null;
    return (
      subs.find(
        (s) => s.contest === contest.code && ((s.state ?? '') === scope || (s.state ?? '') === ''),
      ) ?? null
    );
  }, [subs, contest, scope]);
  const following = !!followed;
  /** Following, but through an everywhere-row rather than this race's region. */
  const followsEverywhere = !!followed && (followed.state ?? '') === '' && scope !== '';

  const toggleFollow = async () => {
    if (!contest) return;
    if (auth.status !== 'signedIn') {
      router.push('/sign-in');
      return;
    }
    // Unfollow removes the exact row that is doing the following; follow adds
    // one scoped to the race on screen.
    const state = following ? (followed?.state ?? '') : scope;
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
        body: JSON.stringify({ contest: contest.code, state }),
      });
      if (!res.ok) {
        Alert.alert('Could not update', `Try again. (HTTP ${res.status})`);
        return;
      }
      setSubs((s) =>
        following
          ? s.filter((x) => !(x.contest === contest.code && (x.state ?? '') === state))
          : [...s, { contest: contest.code, state }],
      );
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * A board is never allowed to show one race's votes under another's name —
   * but that is a question about the CONTEST, not about the race.
   * /api/national/:contest and /api/coverage/gaps?contest= are both keyed by
   * contest code alone: one response carries every region, and this screen
   * already picks the selected race's row out of it client-side (`region`,
   * below). So two races inside one contest are served by literally the same
   * payload, and dropping it on the way from one to the other threw away data
   * that was still exactly correct for the incoming race — leaving the board
   * blank under the new race's name with no fetch scheduled to refill it.
   *
   * So: clear only when the contest genuinely changes, which is the only case
   * where the held tally belongs to a different election. Within a contest the
   * numbers stay up and the region rows re-derive from the new scope on the
   * spot; a refresh follows either way, because `load` is keyed on race.
   */
  const selectRace = (r: Race) => {
    if ((matchContest(r, contests)?.code ?? null) !== contestCode) {
      setData(null);
      setGaps(null);
      setUpdatedAt(null);
      setFailed(false);
      // Retire any in-flight fetch for the outgoing contest so it cannot land
      // in the window before the effect's own fetch claims the id.
      reqId.current++;
    }
    setRace(r);
    setPicking(false);
  };

  /**
   * The level the tally is bucketed by, and so the level the map draws. The
   * server's own answer wins as soon as it arrives; before that the race's type
   * predicts it, purely so the outlines start downloading a round-trip earlier.
   * null means "no level we can honestly draw" — an unknown one must not quietly
   * fall back to states.
   */
  const level = useMemo<MapLevel | null>(() => {
    if (data) return asMapLevel(data.level);
    return race ? (LEVEL_FOR_TYPE[race.type] ?? null) : null;
  }, [data, race]);

  /**
   * The region row for the selected race. A race that is one seat inside a
   * multi-state contest is ranked on ITS region, not on the contest-wide sum,
   * which would credit it with votes cast in other states.
   *
   * Resolved through the map's own `matchRegion`, which is the point: the board
   * and the map find their region by literally the same rule, so they can never
   * end up describing different places under one race's name. It also picks up
   * the 65 federal constituencies whose name lib/races.ts writes in a different
   * LGA order than the register does — rows that a straight string compare
   * missed, leaving the board saying "no reports" over reports that existed.
   */
  const region = useMemo(() => {
    if (!scope || !data || !level) return null;
    return matchRegion(level, scope, regionsOf(data), (r) => r.region);
  }, [data, scope, level]);

  const rows: Row[] = useMemo(() => {
    const raw = scope
      ? Object.entries(region?.votes ?? {}).map(([party, votes]) => ({ party, votes }))
      : (data?.national ?? []).map((r) => ({ party: r.party, votes: r.votes }));
    const ranked = raw.filter((r) => r.votes > 0).sort((a, b) => b.votes - a.votes);
    if (!ranked.length) return [];
    const total = ranked.reduce((s, r) => s + r.votes, 0) || 1;
    const names = new Map(parties.map((p) => [p.code, p.name]));
    return ranked.map((r) => ({
      party: r.party,
      name: names.get(r.party) ?? r.party,
      votes: r.votes,
      share: r.votes / total,
    }));
  }, [data, region, scope, parties]);

  /** Units behind the board actually on screen — scoped when the board is. */
  const unitsReporting = scope ? (region?.unitsReporting ?? 0) : (data?.unitsReporting ?? 0);
  /** Reports for this contest that exist somewhere other than the chosen region. */
  const elsewhere = Math.max(0, (data?.unitsReporting ?? 0) - unitsReporting);

  /** Why the board is empty, said plainly. Each branch is a different fact. */
  const empty = useMemo(() => {
    if (!contestsLoaded) return { title: 'Loading…', body: 'Fetching the races Hawkeye covers.' };
    if (!contests.length)
      return {
        title: 'Could not load the races',
        body: 'Pull down to try again — the list of elections did not reach this device.',
      };
    if (!race)
      return { title: 'Choose a race', body: 'Tap “Change” above to pick the race to rank.' };
    if (!contest)
      return {
        title: 'Not covered yet',
        body: `Hawkeye is not collecting results for ${race.label} yet, so there is nothing to rank. It will appear here once the race is added.`,
      };
    // Closed is checked BEFORE the fetch state on purpose: for a race that has
    // not opened, "nothing can be reported yet" is the whole truth, and it stays
    // the truth whether or not the tally request has come back.
    if (!contest.open)
      return {
        title: 'Reporting has not opened',
        body: `${contest.election} is set for ${whenLine(contest)}. Nothing can be reported until then, so this board stays empty — it is not missing data.`,
      };
    // An open race with no answer yet is not an open race with no votes. Saying
    // "no results yet" while the request is still out — or after it failed —
    // reports a fact about the election that we do not actually have.
    if (failed)
      return {
        title: 'Could not load the results',
        body: 'The tally did not reach this device. Pull down to try again.',
      };
    if (updatedAt === null)
      return { title: 'Loading results…', body: `Fetching the tally for ${contest.election}.` };
    if (scope && elsewhere > 0)
      return {
        title: `No reports from ${scope} yet`,
        body: `${elsewhere} unit(s) have reported elsewhere in this election, but nothing has come in from ${scope}.`,
      };
    return {
      title: 'No results yet',
      body: 'Accepted reports appear here live, ranked by verified votes.',
    };
  }, [contestsLoaded, contests.length, race, contest, scope, elsewhere, failed, updatedAt]);

  /**
   * Coverage narrowed to the states this contest is actually run in. The server
   * answers /coverage/gaps against all 37 register states, so an Osun-only
   * governorship came back "1 of 37 states reporting" and asked observers to
   * cover 36 states that hold no such race.
   */
  const coverage = useMemo(() => {
    if (!gaps) return null;
    const only = contest?.states?.length ? contest.states : null;
    const missing = only ? gaps.missing.filter((s) => only.includes(s)) : gaps.missing;
    const total = only ? only.length : gaps.statesTotal;
    return { missing, total, reported: Math.max(0, total - missing.length) };
  }, [gaps, contest]);

  // ── The results map ────────────────────────────────────────────────────────
  // Everything from here to `mapCard` serves one rule: the map and the board
  // below it are two views of ONE payload. Region colours, legend counts and the
  // tap panel all read `data`'s per-region vote maps — the same figures the rows
  // are built from — and every region lookup goes through `matchRegion`.

  const word = level ? LEVEL_WORD[level] : null;

  /**
   * Outline names for this level, from the same memoised fetch the map itself
   * uses, so it costs nothing beyond the map's own download. Two questions the
   * map cannot answer from inside: how many regions are still silent, and whether
   * the race being ranked has a shape to highlight at all.
   *
   * Held with its level and read back derived, so no render sets state.
   */
  const [shapes, setShapes] = useState<{ level: MapLevel; names: string[] } | null>(null);
  useEffect(() => {
    if (!level) return;
    let alive = true;
    loadMapGeo(level)
      .then((g) => alive && setShapes({ level, names: g.shapes.map((s) => s.name) }))
      .catch(() => {
        /* ResultsMap renders its own failure; a second copy of it helps nobody */
      });
    return () => {
      alive = false;
    };
  }, [level]);
  const shapeNames = shapes?.level === level ? shapes.names : NO_SHAPES;

  /**
   * An exact tie has no party colour to take. A neutral from the theme — dark on
   * the light map, light on the dark one — stays distinct from every party colour
   * AND from the unreported grey in both themes. The web's plain white manages
   * neither: on a dark map it is the loudest thing on screen, and on a light one
   * it is nearly the unreported fill.
   */
  const tieFill = ui.muted;

  /**
   * Everything the map paints, and every number the legend claims about it,
   * derived in ONE pass so that the two cannot describe different sets of
   * regions.
   *
   * The pass is keyed by OUTLINE, not by tally row, and that is the point. A
   * tally row is bucketed by whatever `polling_units` recorded, and for federal
   * constituencies the register and the boundary file do not agree on every
   * spelling: audited against the live files, 50 of the register's 355
   * constituency names reach no outline even after `matchRegion`'s loose tiers,
   * and the two FCT seats plus a handful of others differ by a whole word.
   * Counting leaders straight off the rows therefore had the legend claiming a
   * party led N constituencies while fewer than N were coloured, and had the
   * grey count too low by however many rows were quietly dropped — the map and
   * the table disagreeing, which is worse than having no map.
   *
   * So: resolve each row to its outline first, tally only what an outline
   * actually receives, and keep the rows that reached none as `unplaced` — a
   * fact the card states rather than swallows. Resolving to one shape also
   * collapses two spellings of one region onto one fill instead of letting the
   * later row silently overwrite the earlier one's colour.
   */
  const map = useMemo(() => {
    const rows = regionsOf(data);
    const haveShapes = shapeNames.length > 0;
    /** outline name → the leaders painted on it. Deduped by construction. */
    const onShape = new Map<string, string[]>();
    const unplaced: ApiRegion[] = [];
    for (const r of rows) {
      const shape = level && haveShapes ? matchRegion(level, r.region, shapeNames, (n) => n) : null;
      if (haveShapes && !shape) {
        unplaced.push(r);
        continue;
      }
      onShape.set(shape ?? r.region, leadersOf(r.votes));
    }

    const fills: Record<string, string> = {};
    const led: Record<string, number> = {};
    let ties = 0;
    for (const [shape, L] of onShape) {
      if (!L.length) continue; // a report carrying no votes: grey, like an absence
      if (L.length > 1) {
        ties++;
        fills[shape] = tieFill;
      } else {
        led[L[0]] = (led[L[0]] ?? 0) + 1;
        fills[shape] = partyColor(L[0]);
      }
    }

    /**
     * Grey outlines, counted as the reader sees them: total shapes minus the ones
     * that took a colour. Said as "no votes counted yet" rather than "no reports"
     * because both causes land here — an outline with no tally row at all, and the
     * rarer row that reported without a single vote recorded.
     */
    const total = haveShapes ? shapeNames.length : level ? REGIONS_EXPECTED[level] : 0;
    return {
      fills,
      legend: { rows: Object.entries(led).sort((a, b) => b[1] - a[1]), ties },
      unplaced,
      blank: Math.max(0, total - Object.keys(fills).length),
    };
  }, [data, level, shapeNames, tieFill]);

  /**
   * The region the panel under the map is describing. Stored with the race it was
   * tapped on, so changing race drops it without an effect — a highlight left
   * over from another contest misstates what is selected.
   */
  const [tapped, setTapped] = useState<{ race: string | null; region: string } | null>(null);
  const tappedRegion = tapped && tapped.race === raceKey ? tapped.region : null;
  const onRegionPress = useCallback(
    (name: string) => setTapped({ race: raceKey, region: name }),
    [raceKey],
  );

  /** The outline belonging to the race being ranked, when it has one. Empty for
   *  the presidential board, whose scope is the whole country. */
  const homeShape = useMemo(
    () => (level ? matchRegion(level, scope, shapeNames, (n) => n) : null),
    [level, scope, shapeNames],
  );

  /**
   * What the panel under the map is about. With nothing tapped it describes the
   * race's own region and reuses `region` — the very row the board is built from
   * — instead of resolving it a second time, so the two cannot drift.
   */
  const inspect = useMemo(() => {
    if (!level) return null;
    const name = tappedRegion ?? homeShape;
    if (!name) return null;
    const home = homeShape != null && regionKey(level, name) === regionKey(level, homeShape);
    const row = home ? region : matchRegion(level, name, regionsOf(data), (r) => r.region);
    return { name, home, row };
  }, [level, tappedRegion, homeShape, region, data]);

  /**
   * The selected region has a tally row but no outline to put it on — a name the
   * boundary file does not carry. Worth saying in the panel: without it, a chip
   * that highlights nothing on the map looks like a broken tap rather than a
   * known gap in the geometry.
   */
  const inspectUnplaced =
    level != null &&
    inspect != null &&
    inspect.row != null &&
    shapeNames.length > 0 &&
    matchRegion(level, inspect.name, shapeNames, (n) => n) === null;

  const inspectLines = useMemo(() => {
    if (!inspect || !word) return [];
    const out: string[] = [];
    const row = inspect.row;
    if (!row) {
      out.push(`No reports from ${regionLabel(inspect.name)} yet.`);
    } else {
      const L = leadersOf(row.votes);
      const lead =
        L.length > 2
          ? `${L.length}-way tie`
          : L.length === 2
            ? `${L[0]} and ${L[1]} tied`
            : L.length === 1
              ? `${L[0]} leads`
              : 'No votes counted yet';
      out.push(`${lead} · ${row.unitsReporting} unit(s) reporting, ${row.unitsVerified} verified.`);
      const top = Object.entries(row.votes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p, v]) => `${p} ${v.toLocaleString()}`)
        .join(' · ');
      if (top) out.push(top);
    }
    if (inspectUnplaced)
      out.push(
        `Not drawn on the map: no outline is filed under this name, so these votes are in the board above but not in any colour here.`,
      );
    if (inspect.home) out.push(`This is the ${word.one} the board above ranks.`);
    else if (!scope) out.push('The board above ranks the nationwide total.');
    return out;
  }, [inspect, word, scope, inspectUnplaced]);

  /**
   * The races this level's regions map onto one-for-one, so tapping a region can
   * make the board rank it. Only where that is unambiguous: a state has one
   * governorship, a district one Senate seat, a constituency one Reps seat. The
   * presidential board is nationwide — its regions are a breakdown of a single
   * race, not races of their own — and a state holds many State Assembly seats,
   * so neither offers the jump.
   */
  const raceType = race?.type ?? null;
  const regionRaces = useMemo(() => {
    if (!level || !raceType) return null;
    if (level === 'senatorial') return listRaces('SEN');
    if (level === 'federal') return listRaces('REP');
    if (level === 'state' && raceType === 'GOV') return listRaces('GOV');
    return null;
  }, [level, raceType]);

  /**
   * The race a tapped region would move the board to, when it is not this one.
   * `matchContest` has the last word: a governorship contest run only in Osun
   * still has a race object for every state, and offering to rank one Hawkeye is
   * not collecting would be a button whose only outcome is an empty board.
   */
  const jump = useMemo(() => {
    if (!level || !inspect || !regionRaces) return null;
    const r = matchRegion(level, inspect.name, regionRaces, scopeOf);
    if (!r || r.key === raceKey) return null;
    return matchContest(r, contests) ? r : null;
  }, [level, inspect, regionRaces, raceKey, contests]);

  /**
   * Tap targets that actually work. A federal constituency is a few pixels wide
   * on a phone and 358 of them cannot be hit reliably; these are the regions
   * that have actually reported, most units first, which is also the only subset
   * worth inspecting. Capped so the card stays a block, not a directory.
   */
  const reporting = useMemo(
    () =>
      [...regionsOf(data)].sort((a, b) => b.unitsReporting - a.unitsReporting).slice(0, 12),
    [data],
  );

  /** The honest sentence under the heading: what this map can and cannot show. */
  const mapNote = (() => {
    if (!level || !word) return '';
    const parts: string[] = [];
    parts.push(
      level === 'lga'
        ? 'State Assembly reports are grouped by state in the tally, not by state constituency — so this map colours whole states. It cannot show which constituency inside a state a party is winning.'
        : `Every ${word.one} that has reported, filled with the party leading there.`,
    );
    const total = REGIONS_EXPECTED[level];
    if (shapeNames.length > 0 && shapeNames.length < total) {
      parts.push(
        `${shapeNames.length} of Nigeria's ${total} ${word.many} have a mapped boundary; the rest cannot be drawn.`,
      );
    }
    const only = contest?.states ?? [];
    if ((level === 'state' || level === 'lga') && only.length > 0 && only.length < total) {
      parts.push(`Contested only in ${only.join(', ')} — every other state stays grey.`);
    }
    if (scope && shapeNames.length > 0 && !homeShape) {
      parts.push(
        `${scope} could not be matched to an outline, so nothing is highlighted for this race.`,
      );
    }
    // The residue of the name-matching above, stated rather than swallowed. These
    // rows' votes ARE in the board and in the national total; what they have no
    // outline for is a colour on this map, and a reader comparing the two counts
    // deserves to know why they differ.
    if (map.unplaced.length) {
      const n = map.unplaced.length;
      const named = map.unplaced.slice(0, 3).map((r) => r.region);
      const rest = n - named.length;
      parts.push(
        `${n} reporting ${n === 1 ? word.one : word.many} could not be matched to an outline (the register and the boundary file spell ${
          n === 1 ? 'it' : 'them'
        } differently) — counted in the board above, not coloured here: ${named.join(', ')}${
          rest > 0 ? ` and ${rest} more` : ''
        }.`,
      );
    }
    return parts.join(' ');
  })();

  const mapCard =
    !level || !word ? (
      // Reached only when /api/national reports a level this build does not know
      // how to draw. Saying so beats drawing the wrong shapes.
      <View className="mt-4 rounded-2xl bg-card px-4 py-4">
        <Text className="text-sm font-bold text-ink">No map for this race</Text>
        <Text className="pt-1 text-xs text-muted">
          {data
            ? `This tally is grouped by “${data.level}”, which this version of the app has no outlines for. The website's results map can draw it.`
            : 'The map appears once the race is chosen.'}
        </Text>
      </View>
    ) : (
      <View className="mt-4 rounded-2xl bg-card px-4 py-4">
        <Text className="text-sm font-bold text-ink">Leading party by {word.one}</Text>
        <Text className="pt-1 text-xs text-muted">{mapNote}</Text>

        <View className="pt-3">
          <ResultsMap
            level={level}
            fills={map.fills}
            selected={inspect?.name ?? null}
            onPress={onRegionPress}
            accessibilityLabel={`Map of Nigeria: leading party by ${word.one}`}
          />
        </View>

        {/* Named parties, not raw colours — a swatch alone tells a reader
            nothing, and “green” is three different parties here. */}
        <View className="flex-row flex-wrap pt-3">
          {map.legend.rows.map(([party, n]) => (
            <View key={party} className="mb-1.5 mr-3 flex-row items-center">
              <View
                className="h-3 w-3 rounded-sm"
                style={{ backgroundColor: partyColor(party), opacity: 0.92 }}
              />
              <Text className="pl-1.5 text-[11px] text-muted">
                {partyName(party)} · {n} {n === 1 ? word.one : word.many}
              </Text>
            </View>
          ))}
          {map.legend.ties ? (
            <View className="mb-1.5 mr-3 flex-row items-center">
              <View className="h-3 w-3 rounded-sm" style={{ backgroundColor: tieFill }} />
              <Text className="pl-1.5 text-[11px] text-muted">
                exactly tied · {map.legend.ties}
              </Text>
            </View>
          ) : null}
          {/* Counted as the grey shapes a reader can see, not as "rows we have no
              report for" — see `map.blank`. The two differ, and the legend has to
              be the one that matches the picture it is a key to. */}
          <View className="mb-1.5 mr-3 flex-row items-center">
            <View className="h-3 w-3 rounded-sm" style={{ backgroundColor: ui.noData }} />
            <Text className="pl-1.5 text-[11px] text-muted">
              no votes counted yet{map.blank ? ` · ${map.blank}` : ''}
            </Text>
          </View>
        </View>

        {/* Tap-to-inspect. The web shows one line on hover, which a phone has no
            way to trigger; this is the panel that replaces it. */}
        <View className="mt-2 rounded-2xl bg-surface px-3.5 py-3">
          <Text className="text-xs font-bold text-ink">
            {inspect ? regionLabel(inspect.name) : `Tap a ${word.one} for its numbers`}
          </Text>
          {inspect ? (
            inspectLines.map((line, i) => (
              <Text key={i} className="pt-0.5 text-[11px] text-muted">
                {line}
              </Text>
            ))
          ) : (
            <Text className="pt-0.5 text-[11px] text-muted">
              Colour is the leading party. Tap any {word.one} — or a chip below — to see its
              running counts.
            </Text>
          )}
          {jump ? (
            <Pressable
              onPress={() => selectRace(jump)}
              className="mt-2.5 items-center rounded-xl bg-hawk-green py-2.5 active:opacity-80"
            >
              <Text className="text-xs font-bold text-hawk-gold" numberOfLines={1}>
                Rank {jump.label} instead
              </Text>
            </Pressable>
          ) : null}
        </View>

        {reporting.length ? (
          <>
            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
              Reporting {word.many} · most units first
            </Text>
            <View className="flex-row flex-wrap">
              {reporting.map((r) => {
                const on = inspect != null && regionKey(level, inspect.name) === regionKey(level, r.region);
                const L = leadersOf(r.votes);
                const dot = L.length > 1 ? tieFill : L.length === 1 ? partyColor(L[0]) : ui.noData;
                return (
                  <Pressable
                    key={r.region}
                    onPress={() => onRegionPress(r.region)}
                    className={`mb-2 mr-2 flex-row items-center rounded-full px-3 py-1.5 ${
                      on ? 'bg-hawk-green' : 'bg-surface'
                    }`}
                  >
                    <View className="h-2 w-2 rounded-full" style={{ backgroundColor: dot }} />
                    <Text
                      className={`pl-1.5 text-[11px] font-semibold ${
                        on ? 'text-hawk-gold' : 'text-muted'
                      }`}
                      numberOfLines={1}
                    >
                      {regionLabel(r.region)} · {r.unitsReporting}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {regionsOf(data).length > reporting.length ? (
              <Text className="text-[11px] text-faint">
                {reporting.length} of {regionsOf(data).length} reporting {word.many} listed — tap
                the map for the rest.
              </Text>
            ) : null}
          </>
        ) : null}
      </View>
    );

  const header = (
    <View>
      {/* On the board, not in a footer: this is the claim the whole product
          depends on not being misread. */}
      {/* bg-warn/text-warn-ink, not bg-amber-100/text-amber-900: a hardcoded
          Tailwind tint does not follow the theme, so on the dark board this
          block stayed a pale card — the one notice that must read cleanly in
          both. */}
      <View className="mb-3 rounded-2xl bg-warn px-4 py-3">
        <Text className="text-xs font-semibold text-warn-ink">
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
            {following
              ? followsEverywhere
                ? 'Alerts on · every state'
                : 'Alerts on'
              : `Get alerts on every report${scope ? ` in ${scope}` : ''}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  /**
   * The map sits BELOW the board, not above it as on the web. On a phone the
   * ranked rows are the answer and the map is the breakdown: a ~300 px map in the
   * header would push both the tally and the Follow control off the first screen.
   * It is a bounded block here — a fixed-aspect card, its legend and its tap
   * panel — inside the list that was already scrolling.
   */
  const coverageCard =
    coverage && coverage.missing.length ? (
      <View className="mt-4 rounded-2xl bg-card px-4 py-4">
        <Text className="text-sm font-bold text-ink">Help cover these states</Text>
        <Text className="pt-1 text-xs text-muted">
          {coverage.reported} of {coverage.total} state(s) in this election have reports so far.
          Nothing has come in from:
        </Text>
        <Text className="pt-2 text-xs text-muted">{coverage.missing.join(' · ')}</Text>
        <Pressable
          className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
          onPress={() => router.push('/report/result')}
        >
          <Text className="text-sm font-bold text-hawk-gold">Report from your unit</Text>
        </Pressable>
      </View>
    ) : null;

  const footer = (
    <View>
      {mapCard}
      {coverageCard}
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Leaderboard" translateY={translateY} right="none" />
      <View className="px-4 pb-2" style={{ paddingTop: headerH + 8 }}>
        <Text className="text-sm text-muted" numberOfLines={1}>
          {contest?.election ?? (race ? 'Not covered yet' : 'Loading…')} · {unitsReporting} unit(s)
          reporting
          {updatedAt
            ? ` · updated ${new Date(updatedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}`
            : ''}
        </Text>
        {/* Which race is being ranked, and the way to change it — pinned in the
            header so the control is never something you have to scroll to find. */}
        <Pressable
          onPress={() => setPicking((v) => !v)}
          className="mt-3 flex-row items-center rounded-2xl bg-card px-3.5 py-2.5 active:opacity-80"
        >
          <Feather name={picking ? 'x' : 'award'} size={15} color={ui.muted} />
          <Text className="flex-1 px-2.5 text-sm font-semibold text-ink" numberOfLines={1}>
            {picking ? 'Keep the current race' : (race?.label ?? 'Choose a race')}
          </Text>
          <Text className="text-xs font-bold text-hawk-leaf">{picking ? 'Cancel' : 'Change'}</Text>
        </Pressable>
      </View>

      {picking ? (
        <ScrollView
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          contentContainerClassName="px-4 pb-8 pt-1"
        >
          <Text className="pb-2 text-sm text-muted">
            Choose any race to see its board. A race that has not opened can be viewed too — it
            will simply have no results yet.
          </Text>
          {/* allowClosed: viewing is not reporting. No lockedState: the board is
              nationwide, so the full type → state → race path applies. */}
          <ContestPicker contests={contests} value={race} onSelect={selectRace} allowClosed />
        </ScrollView>
      ) : (
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
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          ListEmptyComponent={
            <View className="mt-2 items-center rounded-2xl bg-card px-6 py-10">
              <Text className="text-base font-semibold text-ink">{empty.title}</Text>
              <Text className="pt-1 text-center text-sm text-muted">{empty.body}</Text>
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
      )}
    </View>
  );
}
