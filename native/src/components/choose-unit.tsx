import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  Text,
  View,
} from 'react-native';

import { InfoDot } from '@/components/info-dot';
import { useNotice, NoticeSheet } from '@/components/notice-sheet';
import { PinnedFooter } from '@/components/pinned-footer';
import { ScreenHeader } from '@/components/screen-header';
import { UnitSearch } from '@/components/unit-search';
import {
  mapAvailable,
  RegisterTierBadge,
  TIER_COLOR,
  TIER_LABEL,
  toTier,
  UnitMap,
  type MapUnit,
  type UnitTier,
} from '@/components/unit-map';
import { Crumb, Prompt } from '@/components/wizard';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { BRAND } from '@/lib/api';
import { getIdentity } from '@/lib/identity';
import { describeFixFailure, DISCOVERY_RADIUS_M, tryQuickFix, type Fix } from '@/lib/location';
import { regFetch } from '@/lib/register-fetch';
import * as SecureStore from '@/lib/secure-store';
import { useUi } from '@/lib/theme';
import { t as i18nT } from '@/lib/i18n';

const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

/**
 * CHOOSE your polling unit. Not map one.
 *
 * "My Polling Unit" in the profile used to open /map-unit — a screen titled
 * "Map a polling unit", whose instruction is "Stand at the polling unit and
 * record one GPS fix" and whose primary button is "I am standing here — record
 * fix". Saving is a secondary row on it. Someone who just wants to say which
 * unit is theirs was being handed a surveying tool and asked to be standing in
 * the right place to use it. Those are different jobs: mapping contributes a
 * coordinate to the register, choosing is a preference about alerts.
 *
 * /map-unit is untouched and still the right screen for the surveying job.
 *
 * ASSEMBLY, NOT NEW MACHINERY. `UnitSearch` is already written to drop into any
 * host and works offline from the register packs; `regFetch` is the offline-
 * first register browser every report screen drills through; `Prompt`/`Crumb`
 * are the shared cascade furniture; `UnitMap` is the same map report/result and
 * map-unit draw; `tryQuickFix` and `describeFixFailure` are the shared location
 * helpers. `POST /api/observers/my-unit` is the one writer. The only new thing
 * here is the arrangement.
 *
 * A PAGE, NOT A SHEET. This was a ModalCard over Profile and over the last
 * sign-up step. It is now the body of the /choose-unit route (app/choose-unit.tsx)
 * with the app's own ScreenHeader, a scrolling body and a PinnedFooter holding
 * Save — a map, a ward list and a search result list do not fit in a card
 * capped at 85% of the screen, and on sign-up this IS the step, not an
 * interruption of one. The route decides where Save and Skip lead; this
 * component only reports them.
 *
 * THREE ROUTES TO A UNIT, and the page is laid out so none of them hides the
 * others:
 *
 *  - TWO TABS, NEITHER ACTIVE ON OPEN. This page opens from a profile row that
 *    an observer may have tapped while merely reading their profile, so nothing
 *    fires until a tab is tapped: no GPS lookup, no register fetch. That is the
 *    same restraint the report screens adopted deliberately. Tapping the open
 *    tab folds it away again, which is the quickest way to get a long ward list
 *    off a phone screen.
 *  - SEARCH IS ALWAYS VISIBLE, pinned directly under the tab strip so switching
 *    or folding a tab never moves it. It is also the only route that works with
 *    no signal at all (UnitSearch answers from the register packs), which is why
 *    every failure message here points at it.
 *
 * THE SEARCH PANE HAS TO LOOK LIKE A FIELD. The input is `bg-card`, and on the
 * old white card it read as background — observers did not see there was
 * anywhere to type. Every route sits in an inset `bg-surface` pane with a real
 * border, and the raised `bg-card` controls inside them separate from it in both
 * themes; the search box also takes a gold ring while focused.
 *
 * GOLD MARKS WHAT TO DO NEXT, and only that: the step chip, the active tab, the
 * focused search and the enabled Save. Brand gold with brand ink on it is a
 * fixed pair that does not flip with the theme, so it reads the same in light
 * and dark — gold TEXT on the light surface would not.
 */

/** A register row. The tier fields ride along (the register endpoints `SELECT *`)
 *  so browse rows can carry the same location badge every other list shows. */
type Row = {
  pu_code: string;
  name: string;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
  coords_source?: string | null;
  locationTier?: string;
  lat?: number | null;
  crowd_lat?: number | null;
};

/** /api/polling-units hands back whole register rows — the only lookup that can
 *  name a unit's state — with coordinates raw: officially verified ones in
 *  lat/lng, crowd medians and geocodes alike in crowd_lat/crowd_lng. */
type LocatedRow = Row & {
  lng?: number | null;
  crowd_lng?: number | null;
  distanceM?: number;
};

/** /api/mapping/nearby's row shape: camelCase, positioned, thinner than a
 *  register row — no LGA and, crucially, no state. */
type NearbyRow = {
  puCode: string;
  name: string;
  ward: string;
  lat: number;
  lng: number;
  distanceM: number;
  status: string;
};

/** One row of the merged discovery list — the list and the map read this and
 *  nothing else. */
type NearRow = {
  puCode: string;
  name: string;
  ward?: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  tier: UnitTier;
  /** Did /api/mapping/nearby actually grade this row? Only that lookup can tell
   *  a crowd-mapped unit from an officially verified one. */
  tierConfirmed: boolean;
  /** The register row, when the merge already had one. `null` means only
   *  /api/mapping/nearby knew about this unit, so its ward/LGA/state still have
   *  to be fetched before the saved-unit line can name where it is. */
  unit: Row | null;
};

/** What the two lookups covered on the last run, so the copy can describe the
 *  area really searched rather than the one drawn. */
type Searched = { registerM: number | null; envelopeM: number | null };

/** Enough to find your own unit; short enough to still scan on a phone. */
const MAX_NEAR = 8;

/** config.discoveryRadiusM as of writing — a mirror, used only against a server
 *  too old to report its own `radiusM`. */
const REGISTER_RADIUS_M = 500;

/** Bounded: UnitMap's own floor is 240, and the rows the map exists to help
 *  pick sit under it. A page has more room than the old modal card did, but
 *  not so much that a taller map should push the first row off a small phone. */
const MAP_H = 260;

type Tab = 'near' | 'register';

/**
 * THE LIST COMPONENTS LIVE AT MODULE SCOPE, and must stay here. A component
 * created during render is a new function identity every render, so React
 * unmounts and rebuilds the whole subtree instead of updating it — which loses
 * the press feedback mid-gesture on the very tap that selects a row. Mirrors
 * report/result.tsx.
 */

/** One choosable unit. `bg-hawk-green` when selected, exactly as UnitSearch's
 *  own rows in the pane above — the same page must not grade a selection two
 *  ways. */
const PickRow = ({
  name,
  sub,
  badge,
  selected,
  saved,
  onPress,
}: {
  name: string;
  sub: string;
  /** The location-tier line, which differs between a merged discovery row and a
   *  plain register row but reads identically to the observer. */
  badge?: ReactNode;
  selected: boolean;
  saved: boolean;
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityState={{ selected }}
    accessibilityLabel={`${name}${sub ? `, ${sub}` : ''}${saved ? `, ${i18nT('n.components.choose-unit.saved')}` : ''}`}
    className={`mb-2 flex-row items-center rounded-2xl px-3 py-2.5 active:opacity-70 ${
      selected ? 'bg-hawk-green' : 'bg-card'
    }`}
  >
    <View className="flex-1 pr-2">
      <Text className={`text-sm font-bold ${selected ? 'text-white' : 'text-ink'}`}>{name}</Text>
      <Text className={`pt-0.5 text-[11px] ${selected ? 'text-emerald-100' : 'text-muted'}`}>
        {sub}
      </Text>
      {badge}
    </View>
    {saved ? <Text className="pr-2 text-[10px] font-bold uppercase text-faint">{i18nT('n.components.choose-unit.saved')}</Text> : null}
    {selected ? <Feather name="check" size={16} color={BRAND.gold} /> : null}
  </Pressable>
);

/** The tier line a merged discovery row carries: same dot, same words as the
 *  pin it refers to on the map above it. */
const NearBadge = ({ tier, selected }: { tier: UnitTier; selected: boolean }) => (
  <View className="flex-row items-center pt-0.5">
    <View
      className="mr-1.5 h-2 w-2 rounded-full"
      style={{ backgroundColor: TIER_COLOR[tier] }}
    />
    <Text className={`flex-1 text-[11px] ${selected ? 'text-emerald-100' : 'text-muted'}`}>
      {TIER_LABEL[tier]}
    </Text>
  </View>
);

/** A cascade chip — the register drill's state / LGA / ward stages, in the same
 *  shape report/result.tsx draws them. */
const Chip = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    className="mb-2 mr-2 rounded-full bg-card px-3.5 py-2 active:opacity-70"
  >
    <Text className="text-sm font-semibold text-ink">{label}</Text>
  </Pressable>
);

/**
 * One segment of the Near me / Browse register control. Selected is solid
 * brand gold with brand ink on it — a fixed pair, so it reads identically in
 * both themes — against the strip's `bg-card`. It used to be green-on-green
 * (`bg-hawk-green` + `text-hawk-gold`), which in dark mode sat one step off the
 * surface and was easy to miss; the page's other greens (the Prompt bars, the
 * picked rows) now stay distinct from the control that opened them.
 *
 * Both tabs start UNSELECTED, which the strip has to be able to show: an
 * unselected strip is the honest picture of a page where nothing has run yet.
 */
const TabButton = ({
  icon,
  label,
  on,
  mutedInk,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  on: boolean;
  mutedInk: string;
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="tab"
    accessibilityState={{ selected: on }}
    accessibilityLabel={label}
    className={`flex-1 flex-row items-center justify-center rounded-full py-3 active:opacity-70 ${
      on ? 'bg-hawk-gold' : ''
    }`}
  >
    <Feather name={icon} size={15} color={on ? BRAND.ink : mutedInk} />
    <Text
      className={`pl-1.5 text-sm font-bold ${on ? 'text-hawk-ink' : 'text-muted'}`}
      numberOfLines={1}
    >
      {label}
    </Text>
  </Pressable>
);

/** An inset pane. Every route to a unit gets one, so the search box, the nearby
 *  list and the register drill are visibly three panels rather than one wash of
 *  card colour. */
/**
 * The inset pane every route-to-a-unit sits in.
 *
 * border-faint, NOT border-line. In light mode --line (226 236 230) against
 * --surface (232 242 236) is a six-in-255 delta per channel — a border that is
 * technically present and visually absent, which is exactly the "reads as
 * background" complaint this pane exists to answer. --faint clears --surface by
 * ~91/255 in light and ~102 in dark, so the field reads as a field in both.
 */
const Pane = ({ children, flush }: { children: ReactNode; flush?: boolean }) => (
  <View
    className={`mt-3 rounded-2xl border border-faint bg-surface px-3 pb-3 ${flush ? '' : 'pt-3'}`}
  >
    {children}
  </View>
);

export function ChooseUnitScreen({
  onboard = false,
  currentCode,
  onSaved,
  onSkip,
  onClose,
}: {
  /**
   * Reached straight after a NEW sign-up (sign-in.tsx) rather than from
   * Profile. Adds the one-line why and a quiet "Skip for now" under Save — the
   * same banner and skip the web shows on map-unit.html?onboard=1, on the same
   * keys, so the two clients cannot word the ask differently. There is no close
   * cross: here leaving IS skipping, and it is said in words.
   */
  onboard?: boolean;
  /** The unit already saved, so the lists can mark it "Saved". */
  currentCode?: string | null;
  /** Fires once the server has accepted the unit. The route navigates. */
  onSaved: (unit: Row) => void;
  /** Onboarding only: the reader chose not to pick a unit now. */
  onSkip?: () => void;
  /** From Profile: the header's close cross. */
  onClose?: () => void;
}) {
  const ui = useUi();
  const notice = useNotice();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [tab, setTab] = useState<Tab | null>(null);
  const [picked, setPicked] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);

  // -- near me --------------------------------------------------------------
  const [near, setNear] = useState<NearRow[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  /**
   * Whether nearLine is a failure. Carried beside the line rather than read
   * back out of it: this used to regex the TEXT for "could not|denied|…", which
   * only ever matched English — in Hausa, Igbo or Yorùbá every GPS failure was
   * drawn in the calm muted ink of a success.
   */
  const [nearBad, setNearBad] = useState(false);
  const say = (line: string, bad: boolean) => {
    setNearLine(line);
    setNearBad(bad);
  };
  const [gpsSettings, setGpsSettings] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [searched, setSearched] = useState<Searched | null>(null);
  /** The tab runs the lookup once. Re-opening the tab must not re-take a GPS
   *  fix the observer already paid for; the button inside it is the retry. */
  const nearRan = useRef(false);

  // -- browse the register --------------------------------------------------
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Row[]>([]);
  const [regBusy, setRegBusy] = useState(false);
  /** The states call failed outright. Tracked so the drill offers a retry
   *  instead of an "…" that cannot be told apart from a slow network — a
   *  swallowed catch here renders as a permanent loading state. */
  const [regFailed, setRegFailed] = useState(false);

  const loadStates = () => {
    setRegBusy(true);
    setRegFailed(false);
    regFetch(`${REG}/states`)
      .then((r) => r.json())
      .then((s: unknown) => {
        const list = Array.isArray(s) ? (s as string[]) : [];
        setStates(list);
        setRegFailed(list.length === 0);
      })
      .catch(() => setRegFailed(true))
      .finally(() => setRegBusy(false));
  };

  /**
   * The stages below the first. Offline-first through `regFetch`, which answers
   * states / LGAs / wards from the ~56 KB index pack and units from the state
   * pack when it is held, falling through to the network only for what the
   * packs cannot answer — so browsing works with no signal, exactly as it does
   * on the report screens.
   *
   * Guarded on the tab as well as on the selection: nothing in the register
   * path may fetch before the observer has asked for it.
   */
  useEffect(() => {
    if (tab !== 'register' || !stateSel) return;
    regFetch(`${REG}/lgas?state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json())
      .then((v: unknown) => setLgas(Array.isArray(v) ? (v as string[]) : []))
      .catch(() => setLgas([]));
  }, [tab, stateSel]);

  useEffect(() => {
    if (tab !== 'register' || !stateSel || !lgaSel) return;
    regFetch(`${REG}/wards?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`)
      .then((r) => r.json())
      .then((v: unknown) => setWards(Array.isArray(v) ? (v as string[]) : []))
      .catch(() => setWards([]));
  }, [tab, stateSel, lgaSel]);

  useEffect(() => {
    if (tab !== 'register' || !stateSel || !lgaSel || !wardSel) return;
    regFetch(
      `${REG}/units?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}&ward=${encodeURIComponent(wardSel)}`,
    )
      .then((r) => r.json())
      .then((d: { units?: Row[] }) => setUnits(d.units ?? []))
      .catch(() => setUnits([]));
  }, [tab, stateSel, lgaSel, wardSel]);

  /** Moving in the drill clears everything below it, or a stage the observer
   *  backed out of keeps rendering its old list under the one they went back to. */
  const pickState = (s: string | null) => {
    setStateSel(s);
    setLgaSel(null);
    setWardSel(null);
    // setLgas TOO. Without it, backing out and picking a different state left
    // the PREVIOUS state's LGA chips on screen under the new state's crumb
    // until the fetch landed — and the "Loading LGAs…" line could never show,
    // because the list it checks was never empty. result.tsx clears even less
    // than this; that is a wart to fix there, not a licence to copy it.
    setLgas([]);
    setWards([]);
    setUnits([]);
  };
  const pickLga = (l: string | null) => {
    setLgaSel(l);
    setWardSel(null);
    setUnits([]);
  };
  const pickWard = (w: string | null) => {
    setWardSel(w);
    setUnits([]);
  };

  /**
   * TWO LOOKUPS, MERGED — the same pair report/result.tsx and map-unit.tsx ask,
   * because neither endpoint alone can list the units an observer might be
   * standing at:
   *
   *  - /api/polling-units selects `lat IS NOT NULL OR crowd_lat IS NOT NULL`. It
   *    is the only lookup that sees the 7,652 units positioned solely by
   *    crowd_lat, and the only one that returns whole register rows — so the
   *    only one that knows a unit's state. But it measures at
   *    config.discoveryRadiusM and reports that radius on the wire.
   *  - /api/mapping/nearby reaches 800m and includes units placed only by their
   *    GRID3 envelope — where an observer at an unmapped unit is standing — but
   *    it never reads crowd_lat, so those 7,652 units are invisible to it.
   *
   * This chooser asked only the first, at its own narrower radius, which is why an
   * observer could stand at a real unit and be told there was nothing near them.
   *
   * Either lookup may fail alone; only losing both is fatal.
   */
  const findNearby = async () => {
    setNearBusy(true);
    setNear([]);
    setFix(null);
    setSearched(null);
    setGpsSettings(false);
    say(i18nT('n.app.report.result.getting-your-location'), false);
    try {
      const r = await tryQuickFix();
      if (!r.ok) {
        // NAMED failures, not one message for all of them. Telling an observer
        // with working permission that they have none is how this screen loses
        // the people it is for — the same discrimination map-unit makes.
        const d = describeFixFailure(r);
        say(i18nT('n.components.choose-unit.or-search-for-it-above', { v0: d.lead, v1: d.code }), true);
        setGpsSettings(d.settings);
        return;
      }
      const f = r.fix;
      setFix(f);
      say(i18nT('n.components.choose-unit.looking-up-nearby-units'), false);

      /** A real deadline. React Native's fetch has none, so on a stalled link
       *  the lookup would hang with no error and no way out. */
      const get = async (url: string) => {
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 20_000);
          const res = await fetch(url, { signal: ctl.signal });
          clearTimeout(t);
          return res;
        } catch {
          return null;
        }
      };

      const [located, envelope] = await Promise.all([
        // No radius parameter exists on this one — it filters at
        // config.discoveryRadiusM and reports that back as `radiusM`.
        get(`${BASE}/api/polling-units?lat=${f.lat}&lng=${f.lng}`),
        // This one does take a radius, and would otherwise default to 5km.
        get(`${BASE}/api/mapping/nearby?lat=${f.lat}&lng=${f.lng}&radiusM=${DISCOVERY_RADIUS_M}`),
      ]);

      if (!located?.ok && !envelope?.ok) {
        // POINT AT SEARCH, NOT THE REGISTER DRILL. This is the network-failure
        // case, and browsing is itself network-backed once the packs run out;
        // search answers from the register bundled into the app.
        say(i18nT('n.components.choose-unit.could-not-check-nearby-units-search'), true);
        return;
      }

      /**
       * THE RESPONSE IS AN ENVELOPE, NOT AN ARRAY.
       *
       * /api/polling-units answers { radiusM, maxRows, capped, units } — it
       * reports the radius it searched and whether it capped. This screen once
       * expected the bare array the endpoint used to return, and its
       * `Array.isArray` guard turned every successful lookup into an empty one:
       * 13 units at Garki became "No units found near you", with no error
       * anywhere. A defensive guard that silently converts a shape change into
       * "nothing here" is worse than no guard, so BOTH shapes are read
       * explicitly and the radius is taken off the wire when it is there.
       */
      const locatedBody = located?.ok
        ? ((await located.json().catch(() => null)) as
            | LocatedRow[]
            | { units?: LocatedRow[]; radiusM?: number }
            | null)
        : null;
      const locatedRows: LocatedRow[] = Array.isArray(locatedBody)
        ? locatedBody
        : Array.isArray(locatedBody?.units)
          ? (locatedBody.units as LocatedRow[])
          : [];
      const reportedM =
        !Array.isArray(locatedBody) && Number.isFinite(locatedBody?.radiusM)
          ? Number(locatedBody?.radiusM)
          : REGISTER_RADIUS_M;
      const envelopeRows: NearbyRow[] = envelope?.ok
        ? (((await envelope.json().catch(() => ({}))) as { units?: NearbyRow[] }).units ?? [])
        : [];

      const scope: Searched = {
        registerM: located?.ok ? reportedM : null,
        envelopeM: envelope?.ok ? DISCOVERY_RADIUS_M : null,
      };
      setSearched(scope);

      /**
       * THE MERGE. Keyed by pu_code; seeded from the register rows, then
       * /api/mapping/nearby fills in every unit they could not reach.
       *
       * A unit in both keeps the register row's POSITION — `lat ?? crowd_lat`,
       * the same coalesce map-unit.tsx makes, so a pin does not move between
       * screens — but takes its TIER from /api/mapping/nearby, which derives it
       * from coords_source rather than from which column is filled. No envelope
       * circle is built here at all: this page chooses a unit for alerts, it
       * files nothing, so there is no geofence to describe and nothing to gain
       * from a radius whose centre is a median 2.5km from the pin.
       */
      const merged = new Map<string, NearRow>();
      for (const u of locatedRows) {
        // Nullish, not `||`, so a genuine 0 is not thrown away.
        const uLat = u.lat ?? u.crowd_lat;
        const uLng = u.lng ?? u.crowd_lng;
        if (uLat == null || uLng == null) continue;
        // `coords_source` is read ahead of the server's own tier, and for one
        // value only — exactly as report/result.tsx and map-unit.tsx do, so the
        // three cannot grade the same unit differently. pollingUnits.js calls
        // any row holding `lat` 'verified', including a promoted crowd median.
        const crowdMapped = u.coords_source === 'crowd_mapped';
        merged.set(u.pu_code, {
          puCode: u.pu_code,
          name: u.name,
          ward: u.ward,
          lat: uLat,
          lng: uLng,
          distanceM: u.distanceM ?? 0,
          tier: crowdMapped ? 'crowd' : toTier(u.locationTier),
          tierConfirmed: crowdMapped,
          // A whole register row arrived with it, so selecting this one needs no
          // second lookup.
          unit: {
            pu_code: u.pu_code,
            name: u.name,
            ward: u.ward,
            lga: u.lga,
            state: u.state,
            coords_source: u.coords_source,
            locationTier: u.locationTier,
            lat: u.lat,
            crowd_lat: u.crowd_lat,
          },
        });
      }
      for (const n of envelopeRows) {
        const seed = merged.get(n.puCode);
        // A register row already graded `crowd` off its own coords_source was
        // graded from the very column this endpoint grades from, so there is
        // nothing here to correct.
        const tier = seed?.tierConfirmed ? seed.tier : toTier(n.status);
        merged.set(n.puCode, {
          puCode: n.puCode,
          name: seed?.name ?? n.name,
          ward: seed?.ward ?? n.ward,
          lat: seed?.lat ?? n.lat,
          lng: seed?.lng ?? n.lng,
          distanceM: seed?.distanceM ?? n.distanceM,
          tier,
          tierConfirmed: true,
          unit: seed?.unit ?? null,
        });
      }

      /**
       * PRECISION FIRST, THEN DISTANCE.
       *
       * The union is trimmed to MAX_NEAR rows, and the envelope lookup returns
       * units placed only by their GRID3 area — whose "distance" is measured
       * from an area centroid that can sit a kilometre from the actual unit.
       * Sorting the union on distance alone therefore let those approximate
       * rows outrank units we know the real position of, and push them off the
       * end of a short list. An observer standing at a verified unit could stop
       * seeing it.
       *
       * So located rows are ordered ahead of approximate ones, and distance
       * decides within each group. The tier badge still discloses which is
       * which; this only decides who survives the trim.
       */
      const precision = (t: string) => (t === 'approx' ? 1 : 0);
      const all = [...merged.values()].sort(
        (a, b) => precision(a.tier) - precision(b.tier) || a.distanceM - b.distanceM,
      );
      const list = all.slice(0, MAX_NEAR);
      setNear(list);
      if (!list.length) {
        // The narrower of the two circles, not the wider one drawn: a single
        // radius here would be a positive claim about an area the lookup that
        // sees crowd-only units never looked in.
        const m = scope.registerM ?? scope.envelopeM;
        say(
          m != null
            ? i18nT('n.components.choose-unit.no-unit-found-within-m-search', { v0: m })
            : i18nT('n.components.choose-unit.could-not-check-nearby-units-search'),
          true,
        );
        return;
      }
      say(
        all.length > list.length
          ? i18nT('n.components.choose-unit.the-closest-of-found-tap-yours', { v0: list.length, v1: all.length })
          : i18nT('n.components.choose-unit.tap-your-polling-unit'),
        false,
      );
    } catch {
      say(i18nT('n.components.choose-unit.could-not-check-nearby-units-search'), true);
    } finally {
      setNearBusy(false);
    }
  };

  /**
   * A unit only /api/mapping/nearby knew about carries no ward, LGA or state, so
   * the saved-unit row in the profile would read as a bare name. The choice is
   * never made to wait on this: the row is selected from what is already in
   * hand, and the register lookup fills the rest in behind it if it lands.
   */
  const enrich = async (code: string) => {
    try {
      const res = await fetch(`${REG}/unit?pu_code=${encodeURIComponent(code)}`);
      const body = res.ok ? ((await res.json()) as { unit?: Row }) : null;
      const u = body?.unit;
      if (!u) return;
      setPicked((p) => (p && p.pu_code === code ? { ...p, ...u } : p));
    } catch {
      /* The choice stands on the name alone; /api/observers/me will name it. */
    }
  };

  const chooseNear = (n: NearRow) => {
    setPicked(n.unit ?? { pu_code: n.puCode, name: n.name, ward: n.ward });
    if (!n.unit) void enrich(n.puCode);
  };

  /**
   * Tapping a tab is what starts its work — and tapping the open one folds it
   * away, which is the quickest way to get a long ward list off a small screen.
   */
  const openTab = (t: Tab) => {
    Haptics.selectionAsync();
    if (tab === t) {
      setTab(null);
      return;
    }
    setTab(t);
    if (t === 'near' && !nearRan.current) {
      nearRan.current = true;
      void findNearby();
    }
    if (t === 'register' && !states.length && !regBusy) loadStates();
  };

  const save = async (unit: Row) => {
    setSaving(true);
    // Stays true on success: the route leaves this screen next, and a Save
    // that re-enabled for the few frames before it did could be tapped again —
    // a second save, and a second router.back() that would pop Profile too.
    let saved = false;
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const id = await getIdentity();
      const res = await fetch(`${BASE}/api/observers/my-unit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify({ puCode: unit.pu_code }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        const code = body.error ?? `http_${res.status}`;
        // The code is in the message on purpose: "try again" with nothing to
        // report is the message that wastes a support round-trip.
        notice.show(
          i18nT('n.app.map-unit.could-not-save-your-polling-unit'),
          code === 'unknown_unit'
            ? i18nT('n.components.choose-unit.is-not-in-the-register-http', { v0: unit.name, v1: code, v2: res.status })
            : i18nT('n.components.choose-unit.please-check-your-connection-and-try', { v0: code, v1: res.status }),
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      saved = true;
      onSaved(unit);
    } catch {
      notice.show(i18nT('n.app.map-unit.could-not-save-your-polling-unit'), i18nT('n.components.choose-unit.please-check-your-connection-and-try-2'));
    } finally {
      if (!saved) setSaving(false);
    }
  };

  const chosen = picked ?? null;
  const saveOff = !chosen || saving;

  /** The ring is drawn at the WIDER of the two circles actually searched, and
   *  named underneath — an unlabelled ring reads as "everything in here was
   *  checked", which is false for the units only the narrow lookup can see. */
  const ringM = searched?.envelopeM ?? searched?.registerM ?? DISCOVERY_RADIUS_M;

  const mapUnits = useMemo<MapUnit[]>(
    () =>
      near.map((n) => ({
        puCode: n.puCode,
        name: n.name,
        lat: n.lat,
        lng: n.lng,
        tier: n.tier,
      })),
    [near],
  );

  return (
    <View className="flex-1 bg-surface">
      {/* The header names WHERE the reader is — creating an account, or their
          profile — so it never repeats the page's own title below it. In
          onboarding there is no close cross (Skip for now says it in words) and
          the mark skips rather than stacking the tabs over this page. */}
      <ScreenHeader
        title={onboard ? i18nT('n.app.sign-in.create-your-account') : i18nT('profile.my-profile')}
        translateY={translateY}
        right={onboard ? 'none' : 'close'}
        onClose={onClose}
        onHome={onboard ? onSkip : undefined}
      />

      <KeyboardAvoidingView behavior="padding" className="flex-1">
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          contentContainerStyle={{ paddingTop: headerH + 16, paddingHorizontal: 16, paddingBottom: 24 }}
          // The search field is on this page: without this, the first tap on a
          // state chip or a result row with the keyboard up only dismissed the
          // keyboard. The same fix the report screens carry.
          keyboardShouldPersistTaps="handled"
        >
          {/* The eyebrow. "Last step" only where it is true — after this page a
              new observer is in the app — otherwise it names the subject. A gold
              chip with ink on it rather than gold text, which on the light
              surface would be the least legible thing on the page. */}
          <View className="self-start rounded-full bg-hawk-gold px-3 py-1">
            <Text className="text-[11px] font-bold uppercase tracking-wider text-hawk-ink">
              {onboard ? i18nT('n.app.choose-unit.last-step') : i18nT('n.app.map-unit.your-polling-unit')}
            </Text>
          </View>
          <Text className="pt-2.5 text-2xl font-bold text-ink">{i18nT('profile.choose-your-polling-unit')}</Text>

          {/* Two phrases. The difference between choosing and mapping is an
              explanation, so it goes behind the dot rather than on the screen. */}
          <View className="flex-row items-center pt-1">
            <Text className="text-sm font-semibold text-ink">{i18nT('n.components.choose-unit.the-unit-you-get-alerts-about')}</Text>
            <InfoDot
              title={i18nT('n.components.choose-unit.choosing-vs-mapping')}
              text={`${i18nT('n.components.choose-unit.choosing-a-unit-is-a-preference')}\n\n${i18nT(
                'n.components.choose-unit.mapping-is-a-different-job',
                { v0: i18nT('common.map-a-polling-unit'), v1: i18nT('nav.more') },
              )}`}
            />
          </View>
          <Text className="text-sm text-muted">{i18nT('n.components.choose-unit.you-do-not-need-to-be')}</Text>

          {/* The sign-up welcome: one sentence saying what saving a unit gets
              them, in the success wash rather than a warning colour — it is an
              invitation. */}
          {onboard ? (
            <View className="mt-3 flex-row items-start rounded-2xl bg-good px-3.5 py-3">
              <Feather name="bell" size={16} color={ui.tint.good.ink} style={{ marginTop: 2 }} />
              <Text className="flex-1 pl-2.5 text-sm font-semibold text-good-ink">
                {i18nT('map-unit.save-your-polling-unit-you-ll-get')}
              </Text>
            </View>
          ) : null}

          {/* NOTHING RUNS UNTIL A TAB IS TAPPED — no GPS fix, no register fetch.
              This page opens from a profile row someone may have tapped while
              just reading their profile. */}
          <View
            className="mt-4 flex-row rounded-full border border-line bg-card p-1"
            accessibilityRole="tablist"
          >
            <TabButton
              icon="crosshair"
              label={i18nT('n.components.choose-unit.near-me')}
              on={tab === 'near'}
              mutedInk={ui.muted}
              onPress={() => openTab('near')}
            />
            <TabButton
              icon="list"
              label={i18nT('n.components.choose-unit.browse-register')}
              on={tab === 'register'}
              mutedInk={ui.muted}
              onPress={() => openTab('register')}
            />
          </View>

          {/* ALWAYS VISIBLE, pinned directly under the tabs so opening, switching
              or folding a tab never moves it. It is also the only route that
              works with no signal at all — UnitSearch answers from the register
              packs on the device — which is why every failure message here
              points back at it.

              NOT narrowed by the drill's current state/LGA, deliberately: search
              is the escape hatch from the cascade ("I know the name, not the
              ward"), and it outlives the folded tab, so inheriting a stale drill
              selection would silently hide the very match being typed for. */}
          <Pane flush>
            <UnitSearch<Row> onSelect={(u) => setPicked(u)} selectedCode={chosen?.pu_code} accent />
          </Pane>

          {tab === 'near' ? (
            <Pane>
              <Pressable
                disabled={nearBusy}
                onPress={findNearby}
                accessibilityRole="button"
                accessibilityLabel={near.length || nearLine ? i18nT('n.app.report.incident.search-near-me-again') : i18nT('incidents.find-units-near-me')}
                accessibilityState={{ disabled: nearBusy, busy: nearBusy }}
                className={`flex-row items-center justify-center rounded-2xl py-3 ${nearBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
              >
                {nearBusy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <>
                    <Feather name="crosshair" size={15} color={BRAND.gold} />
                    {/* The lookup runs when the tab opens, so this is the RETRY
                        once it has. Keyed on a FINISHED search — rows, or a
                        message saying why there are none — rather than on the
                        tab, which would offer to search "again" before it ever
                        succeeded. */}
                    <Text className="pl-2 text-sm font-bold text-hawk-gold">
                      {near.length || nearLine ? i18nT('n.app.report.incident.search-near-me-again') : i18nT('incidents.find-units-near-me')}
                    </Text>
                  </>
                )}
              </Pressable>

              {/* nearLine carries BOTH outcomes — "N found, tap yours" and every
                  GPS failure — so its ink comes from nearBad, set where the line
                  is written, never from the words (which are translated). */}
              {nearLine ? (
                <Text className={`pt-2.5 text-sm font-semibold ${gpsSettings || nearBad ? 'text-warn-ink' : 'text-muted'}`}>
                  {nearLine}
                </Text>
              ) : null}

              {/* Only for the failures the settings app actually cures. The
                  button above is already the retry, so a weak signal gets the
                  sentence and another tap, not a detour into system settings. */}
              {gpsSettings ? (
                <Pressable
                  onPress={() => Linking.openSettings()}
                  accessibilityRole="button"
                  accessibilityLabel={i18nT('n.app.map-unit.open-phone-settings')}
                  className="mt-2 flex-row items-center self-start rounded-xl border border-line bg-card px-3 py-2 active:opacity-70"
                >
                  <Feather name="settings" size={14} color={ui.muted} />
                  <Text className="pl-2 text-sm font-semibold text-ink">{i18nT('n.app.map-unit.open-phone-settings')}</Text>
                </Pressable>
              ) : null}

              {/* The map answers what a list cannot: which of these is the
                  building in front of you. Selection is shared both ways. Height
                  is clamped — see MAP_H. */}
              {fix && searched && near.length && mapAvailable() ? (
                <View className="pt-2.5">
                  <UnitMap
                    center={{ lat: fix.lat, lng: fix.lng }}
                    accuracyM={fix.accuracy}
                    units={mapUnits}
                    selected={chosen?.pu_code}
                    onSelect={(code) => {
                      const row = near.find((n) => n.puCode === code);
                      if (row) chooseNear(row);
                    }}
                    radiusM={ringM}
                    height={MAP_H}
                  />
                  <Text className="pt-1.5 text-[11px] text-muted">
                    {i18nT('n.components.choose-unit.units-found-within-m', { v0: ringM })}
                  </Text>
                </View>
              ) : null}

              {near.length ? (
                <View className="pt-2.5">
                  {near.map((n) => {
                    const on = chosen?.pu_code === n.puCode;
                    const where = `${n.puCode}${n.ward ? ` · ${n.ward}` : ''}`;
                    return (
                      <PickRow
                        key={n.puCode}
                        name={n.name}
                        // The distance is only stated when a lookup actually
                        // measured one — "0m away" on a row that arrived
                        // without `distanceM` would read as standing on top of it.
                        sub={
                          n.distanceM
                            ? i18nT('n.app.map-unit.m-away', { v0: where, v1: Math.round(n.distanceM) })
                            : where
                        }
                        badge={<NearBadge tier={n.tier} selected={on} />}
                        selected={on}
                        saved={currentCode === n.puCode}
                        onPress={() => chooseNear(n)}
                      />
                    );
                  })}
                </View>
              ) : null}
            </Pane>
          ) : null}

          {tab === 'register' ? (
            <Pane>
              {regBusy && !states.length ? (
                <Text className="text-sm text-muted">{i18nT('n.components.choose-unit.loading-the-register')}</Text>
              ) : null}
              {/* A dead end needs a way out, not a spinner to be waited on. */}
              {regFailed ? (
                <Pressable onPress={loadStates} accessibilityRole="button" className="active:opacity-70">
                  <Text className="text-sm font-bold text-warn-ink">
                    {i18nT('n.components.choose-unit.couldn-t-load-the-register-tap')}
                  </Text>
                </Pressable>
              ) : null}

              {!stateSel && states.length ? (
                <>
                  <Prompt>{i18nT('n.app.report.result.select-your-state')}</Prompt>
                  <View className="flex-row flex-wrap">
                    {states.map((s) => (
                      <Chip key={s} label={s} onPress={() => pickState(s)} />
                    ))}
                  </View>
                </>
              ) : null}

              {stateSel && !lgaSel ? (
                <>
                  <Crumb label={stateSel} onPress={() => pickState(null)} />
                  <Prompt>{i18nT('n.app.report.result.select-your-lga')}</Prompt>
                  <View className="flex-row flex-wrap">
                    {lgas.map((l) => (
                      <Chip key={l} label={l} onPress={() => pickLga(l)} />
                    ))}
                  </View>
                  {!lgas.length ? <Text className="text-sm text-muted">{i18nT('n.components.choose-unit.loading-lgas')}</Text> : null}
                </>
              ) : null}

              {stateSel && lgaSel && !wardSel ? (
                <>
                  <Crumb label={lgaSel} onPress={() => pickLga(null)} />
                  <Prompt>{i18nT('n.app.report.result.select-your-ward')}</Prompt>
                  <View className="flex-row flex-wrap">
                    {wards.map((w) => (
                      <Chip key={w} label={w} onPress={() => pickWard(w)} />
                    ))}
                  </View>
                  {!wards.length ? <Text className="text-sm text-muted">{i18nT('n.components.choose-unit.loading-wards')}</Text> : null}
                </>
              ) : null}

              {stateSel && lgaSel && wardSel ? (
                <>
                  <Crumb label={`${lgaSel} · ${wardSel}`} onPress={() => pickWard(null)} />
                  <Prompt>{i18nT('n.app.report.result.select-your-polling-unit')}</Prompt>
                  {units.map((u) => {
                    const on = chosen?.pu_code === u.pu_code;
                    return (
                      <PickRow
                        key={u.pu_code}
                        name={u.name}
                        sub={`${u.pu_code} · ${u.ward ?? wardSel}`}
                        // The same badge every other browse list carries, so the
                        // same unit does not read one way here and another there.
                        badge={<RegisterTierBadge u={u} selected={on} />}
                        selected={on}
                        saved={currentCode === u.pu_code}
                        onPress={() => setPicked(u)}
                      />
                    );
                  })}
                  {!units.length ? (
                    <Text className="text-sm text-muted">
                      {i18nT('n.app.report.result.no-units-in-the-register-for')}
                    </Text>
                  ) : null}
                </>
              ) : null}
            </Pane>
          ) : null}
        </Animated.ScrollView>

        {/* A SIBLING of the scroller, so Save is never reachable only by
            scrolling. The choice is named right above the button that commits
            it — in a dense ward the row just tapped can be far up the page.
            Growing the footer for it moves only the footer's top edge: Save and
            Skip stay where the thumb already is. */}
        <PinnedFooter>
          {chosen ? (
            <View className="pb-2.5">
              <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">{i18nT('n.components.choose-unit.selected')}</Text>
              <Text className="pt-0.5 text-sm font-bold text-ink" numberOfLines={1}>{chosen.name}</Text>
              {[chosen.ward, chosen.lga, chosen.state].some(Boolean) ? (
                <Text className="text-[11px] text-muted" numberOfLines={1}>
                  {[chosen.ward, chosen.lga, chosen.state].filter(Boolean).join(' · ')}
                </Text>
              ) : null}
            </View>
          ) : null}
          {/* Disabled until something is chosen, rather than hidden: a button
              that appears and disappears moves Skip under the reader's thumb
              between taps. Gold with brand ink when live; the muted disabled
              wash when not, so "not yet" never reads as "press me". */}
          <Pressable
            disabled={saveOff}
            onPress={() => chosen && save(chosen)}
            accessibilityRole="button"
            accessibilityLabel={i18nT('profile.save-this-unit')}
            accessibilityState={{ disabled: saveOff, busy: saving }}
            className={`items-center rounded-2xl py-4 ${saveOff ? 'bg-disabled' : 'bg-hawk-gold active:opacity-80'}`}
          >
            {saving ? (
              <ActivityIndicator color={BRAND.ink} />
            ) : (
              <Text className={`text-base font-bold ${saveOff ? 'text-faint' : 'text-hawk-ink'}`}>
                {i18nT('profile.save-this-unit')}
              </Text>
            )}
          </Pressable>
          {onboard ? (
            <Pressable
              onPress={onSkip}
              disabled={saving}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={i18nT('map-unit.skip-for-now')}
              className="mt-1 items-center py-2.5 active:opacity-60"
            >
              <Text className="text-sm font-semibold text-muted">{i18nT('map-unit.skip-for-now')}</Text>
            </Pressable>
          ) : null}
        </PinnedFooter>
      </KeyboardAvoidingView>

      {/* A save failure is told here, on the page that raised it. */}
      <NoticeSheet {...notice.props} />
    </View>
  );
}
