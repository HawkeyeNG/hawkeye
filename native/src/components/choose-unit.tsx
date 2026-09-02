import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';

import { InfoDot } from '@/components/info-dot';
import { ModalCard } from '@/components/modal-card';
import { useNotice, NoticeSheet } from '@/components/notice-sheet';
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
import { BRAND } from '@/lib/api';
import { getIdentity } from '@/lib/identity';
import { describeFixFailure, DISCOVERY_RADIUS_M, tryQuickFix, type Fix } from '@/lib/location';
import { regFetch } from '@/lib/register-fetch';
import * as SecureStore from '@/lib/secure-store';
import { useUi } from '@/lib/theme';

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
 * THREE ROUTES TO A UNIT, and the modal is laid out so none of them hides the
 * others:
 *
 *  - TWO TABS, NEITHER ACTIVE ON OPEN. This modal opens from a profile row that
 *    an observer may have tapped while merely reading their profile, so nothing
 *    fires until a tab is tapped: no GPS lookup, no register fetch. That is the
 *    same restraint the report screens adopted deliberately. Tapping the open
 *    tab folds it away again, which is the only way to get a long ward list off
 *    a phone screen without leaving the modal.
 *  - SEARCH IS ALWAYS VISIBLE, pinned directly under the tab strip so switching
 *    or folding a tab never moves it. It is also the only route that works with
 *    no signal at all (UnitSearch answers from the register packs), which is why
 *    every failure message here points at it.
 *
 * THE SEARCH PANE HAS TO LOOK LIKE A FIELD. ModalCard's own surface is `bg-card`
 * and so is UnitSearch's input — white on white, so the box read as background
 * and observers did not see there was anywhere to type. Every panel below is an
 * inset `bg-surface` pane with a real border, and the raised `bg-card` controls
 * inside them (the input, the rows, the chips) separate from it in both themes.
 * That is the app's existing raised-on-inset relationship, not a new treatment.
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

/** Enough to find your own unit; short enough to still scan inside a modal. */
const MAX_NEAR = 8;

/** config.discoveryRadiusM as of writing — a mirror, used only against a server
 *  too old to report its own `radiusM`. */
const REGISTER_RADIUS_M = 500;

/** Bounded hard: this map lives inside a modal whose card is capped at 85% of
 *  the screen, and UnitMap's own floor is 240. Anything taller pushes the rows
 *  it exists to help pick out of reach on a small phone. */
const MAP_H = 240;

type Tab = 'near' | 'register';

/**
 * THE LIST COMPONENTS LIVE AT MODULE SCOPE, and must stay here. A component
 * created during render is a new function identity every render, so React
 * unmounts and rebuilds the whole subtree instead of updating it — which loses
 * the press feedback mid-gesture on the very tap that selects a row. Mirrors
 * report/result.tsx.
 */

/** One choosable unit. `bg-hawk-green` when selected, exactly as UnitSearch's
 *  own rows in the pane above — the same modal must not grade a selection two
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
    accessibilityLabel={`${name}${sub ? `, ${sub}` : ''}${saved ? ', currently saved' : ''}`}
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
    {saved ? <Text className="pr-2 text-[10px] font-bold uppercase text-faint">Saved</Text> : null}
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
 * One tab. Selected is `bg-hawk-green` + `text-hawk-gold`, the same active
 * treatment the cascade chips below it use — bg-good was the other candidate
 * and in light mode it is two pale mints against `bg-surface`.
 *
 * Both tabs start UNSELECTED, which the strip has to be able to show: an
 * unselected strip is the honest picture of a modal where nothing has run yet.
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
    className={`flex-1 flex-row items-center justify-center rounded-full py-2.5 active:opacity-70 ${
      on ? 'bg-hawk-green' : ''
    }`}
  >
    <Feather name={icon} size={14} color={on ? BRAND.gold : mutedInk} />
    <Text
      className={`pl-1.5 text-sm font-bold ${on ? 'text-hawk-gold' : 'text-muted'}`}
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

export function ChooseUnitModal({
  visible,
  onClose,
  onSaved,
  current,
}: {
  visible: boolean;
  onClose: () => void;
  /** Fires with the saved unit so the host can update without a refetch. */
  onSaved?: (unit: Row) => void;
  /**
   * The unit already saved, so the list can mark it. Looser than `Row` on
   * purpose: this comes from /api/observers/me, where a register row with no
   * name is possible, whereas everything UnitSearch hands back is named.
   */
  current?: { pu_code: string; name?: string | null } | null;
}) {
  const ui = useUi();
  const notice = useNotice();
  const [tab, setTab] = useState<Tab | null>(null);
  const [picked, setPicked] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);

  // -- near me --------------------------------------------------------------
  const [near, setNear] = useState<NearRow[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
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
   * This modal asked only the first, at its own narrower radius, which is why an
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
    setNearLine('Getting your location…');
    try {
      const r = await tryQuickFix();
      if (!r.ok) {
        // NAMED failures, not one message for all of them. Telling an observer
        // with working permission that they have none is how this screen loses
        // the people it is for — the same discrimination map-unit makes.
        const d = describeFixFailure(r);
        setNearLine(`${d.lead}, or search for it above. (${d.code})`);
        setGpsSettings(d.settings);
        return;
      }
      const f = r.fix;
      setFix(f);
      setNearLine('Looking up nearby units…');

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
        setNearLine('Could not check nearby units — search by name above.');
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
       * circle is built here at all: this modal chooses a unit for alerts, it
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
        setNearLine(
          m != null
            ? `No unit found within ${m}m — search by name above.`
            : 'Could not check nearby units — search by name above.',
        );
        return;
      }
      setNearLine(
        all.length > list.length
          ? `The ${list.length} closest of ${all.length} found — tap yours:`
          : 'Tap your polling unit:',
      );
    } catch {
      setNearLine('Could not check nearby units — search by name above.');
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
   * away, which is the only way to get a long ward list off a small screen
   * without leaving the modal.
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
          'Could not save your polling unit',
          code === 'unknown_unit'
            ? `${unit.name} is not in the register. (${code} / HTTP ${res.status})`
            : `Please check your connection and try again. (${code} / HTTP ${res.status})`,
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved?.(unit);
      close();
    } catch {
      notice.show('Could not save your polling unit', 'Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    setPicked(null);
    setTab(null);
    setNear([]);
    setNearLine(null);
    setGpsSettings(false);
    setFix(null);
    setSearched(null);
    nearRan.current = false;
    pickState(null);
    onClose();
  };

  const chosen = picked ?? null;

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
    <ModalCard
      visible={visible}
      onClose={close}
      title="Choose your polling unit"
      footer={
        <View className="flex-row">
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            className="mr-2 flex-1 items-center rounded-full border border-line py-3 active:opacity-70"
          >
            <Text className="text-sm font-bold text-muted">Cancel</Text>
          </Pressable>
          {/* The commit is disabled until something is chosen, rather than
              hidden: a footer that appears and disappears moves the Cancel
              button under the reader's thumb between taps. */}
          <Pressable
            disabled={!chosen || saving}
            onPress={() => chosen && save(chosen)}
            accessibilityRole="button"
            accessibilityLabel="Save this unit"
            accessibilityState={{ disabled: !chosen || saving, busy: saving }}
            className={`flex-1 items-center rounded-full py-3 ${!chosen || saving ? 'bg-disabled' : 'bg-good active:opacity-80'}`}
          >
            {saving ? (
              <ActivityIndicator color={ui.tint.good.ink} />
            ) : (
              <Text className={`text-sm font-bold ${chosen ? 'text-good-ink' : 'text-faint'}`}>
                Save this unit
              </Text>
            )}
          </Pressable>
        </View>
      }
    >
      {/* Two phrases. The difference between choosing and mapping is an
          explanation, so it goes behind the dot rather than on the screen. */}
      <View className="flex-row items-center">
        <Text className="text-sm font-semibold text-ink">The unit you get alerts about.</Text>
        <InfoDot
          title="Choosing vs mapping"
          text={
            'Choosing a unit is a preference — it decides which unit you get alerts about, and you do not need to be there to set it.\n\n' +
            "Mapping is a different job: it records a unit's GPS position into the register, and it does require you to be standing at the unit. Use “Map a Polling Unit” under More for that."
          }
        />
      </View>
      <Text className="pb-1 text-sm text-muted">You do not need to be there now.</Text>

      {/* NOTHING RUNS UNTIL A TAB IS TAPPED — no GPS fix, no register fetch.
          This modal opens from a profile row someone may have tapped while just
          reading their profile. */}
      <View className="mt-3 flex-row rounded-full bg-surface p-1" accessibilityRole="tablist">
        <TabButton
          icon="crosshair"
          label="Near me"
          on={tab === 'near'}
          mutedInk={ui.muted}
          onPress={() => openTab('near')}
        />
        <TabButton
          icon="list"
          label="Browse register"
          on={tab === 'register'}
          mutedInk={ui.muted}
          onPress={() => openTab('register')}
        />
      </View>

      {/* ALWAYS VISIBLE, pinned directly under the tabs so opening, switching or
          folding a tab never moves it. It is also the only route that works with
          no signal at all — UnitSearch answers from the register packs on the
          device — which is why every failure message here points back at it.

          NOT narrowed by the drill's current state/LGA, deliberately: search is
          the escape hatch from the cascade ("I know the name, not the ward"),
          and it outlives the folded tab, so inheriting a stale drill selection
          would silently hide the very match being typed for. */}
      <Pane flush>
        <UnitSearch<Row> onSelect={(u) => setPicked(u)} selectedCode={chosen?.pu_code} />
      </Pane>

      {tab === 'near' ? (
        <Pane>
          <Pressable
            disabled={nearBusy}
            onPress={findNearby}
            accessibilityRole="button"
            accessibilityLabel={near.length || nearLine ? 'Search near me again' : 'Find units near me'}
            accessibilityState={{ disabled: nearBusy, busy: nearBusy }}
            className={`flex-row items-center justify-center rounded-2xl py-3 ${nearBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
          >
            {nearBusy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <>
                <Feather name="crosshair" size={15} color={BRAND.gold} />
                {/* The lookup runs when the tab opens, so this is the RETRY once
                    it has. Keyed on a FINISHED search — rows, or a message
                    saying why there are none — rather than on the tab, which
                    would offer to search "again" before it ever succeeded. */}
                <Text className="pl-2 text-sm font-bold text-hawk-gold">
                  {near.length || nearLine ? 'Search near me again' : 'Find units near me'}
                </Text>
              </>
            )}
          </Pressable>

          {/* nearLine carries BOTH outcomes — "N found, tap yours" and every GPS
              failure — so it cannot be warning-inked unconditionally, or a
              successful search reads as a problem. */}
          {nearLine ? (
            <Text
              className={`pt-2.5 text-sm font-semibold ${
                gpsSettings || /could not|couldn|no unit|not found|denied|turned off|blocked/i.test(nearLine)
                  ? 'text-warn-ink'
                  : 'text-muted'
              }`}
            >
              {nearLine}
            </Text>
          ) : null}

          {/* Only for the failures the settings app actually cures. The button
              above is already the retry, so a weak signal gets the sentence and
              another tap, not a detour into system settings. */}
          {gpsSettings ? (
            <Pressable
              onPress={() => Linking.openSettings()}
              accessibilityRole="button"
              accessibilityLabel="Open phone settings"
              className="mt-2 flex-row items-center self-start rounded-xl border border-line bg-card px-3 py-2 active:opacity-70"
            >
              <Feather name="settings" size={14} color={ui.muted} />
              <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
            </Pressable>
          ) : null}

          {/* The map answers what a list cannot: which of these is the building
              in front of you. Selection is shared both ways. Height is clamped
              hard — see MAP_H. */}
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
                Units found within {ringM}m. Unmapped units may not appear.
              </Text>
            </View>
          ) : null}

          {near.length ? (
            <View className="pt-2.5">
              {near.map((n) => {
                const on = chosen?.pu_code === n.puCode;
                return (
                  <PickRow
                    key={n.puCode}
                    name={n.name}
                    // The distance is only stated when a lookup actually
                    // measured one — "0m away" on a row that arrived without
                    // `distanceM` would read as standing on top of it.
                    sub={`${n.puCode}${n.ward ? ` · ${n.ward}` : ''}${
                      n.distanceM ? ` · ${Math.round(n.distanceM)}m away` : ''
                    }`}
                    badge={<NearBadge tier={n.tier} selected={on} />}
                    selected={on}
                    saved={current?.pu_code === n.puCode}
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
            <Text className="text-sm text-muted">Loading the register…</Text>
          ) : null}
          {/* A dead end needs a way out, not a spinner to be waited on. */}
          {regFailed ? (
            <Pressable onPress={loadStates} accessibilityRole="button" className="active:opacity-70">
              <Text className="text-sm font-bold text-hawk-gold">
                Couldn’t load the register — tap to retry
              </Text>
            </Pressable>
          ) : null}

          {!stateSel && states.length ? (
            <>
              <Prompt>Select your state</Prompt>
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
              <Prompt>Select your LGA</Prompt>
              <View className="flex-row flex-wrap">
                {lgas.map((l) => (
                  <Chip key={l} label={l} onPress={() => pickLga(l)} />
                ))}
              </View>
              {!lgas.length ? <Text className="text-sm text-muted">Loading LGAs…</Text> : null}
            </>
          ) : null}

          {stateSel && lgaSel && !wardSel ? (
            <>
              <Crumb label={lgaSel} onPress={() => pickLga(null)} />
              <Prompt>Select your ward</Prompt>
              <View className="flex-row flex-wrap">
                {wards.map((w) => (
                  <Chip key={w} label={w} onPress={() => pickWard(w)} />
                ))}
              </View>
              {!wards.length ? <Text className="text-sm text-muted">Loading wards…</Text> : null}
            </>
          ) : null}

          {stateSel && lgaSel && wardSel ? (
            <>
              <Crumb label={`${lgaSel} · ${wardSel}`} onPress={() => pickWard(null)} />
              <Prompt>Select your polling unit</Prompt>
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
                    saved={current?.pu_code === u.pu_code}
                    onPress={() => setPicked(u)}
                  />
                );
              })}
              {!units.length ? (
                <Text className="text-sm text-muted">
                  No units in the register for this ward yet.
                </Text>
              ) : null}
            </>
          ) : null}
        </Pane>
      ) : null}

      {chosen ? (
        <View className="mt-3 rounded-2xl border border-line bg-surface px-3 py-2.5">
          <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">Selected</Text>
          <Text className="pt-1 text-sm font-bold text-ink">{chosen.name}</Text>
          <Text className="text-[11px] text-muted">
            {[chosen.ward, chosen.lga, chosen.state].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}

      {/* Inside the card, not beside it: this notice belongs to the modal that
          raised it, and the ModalCard is what is on screen when a save fails. */}
      <NoticeSheet {...notice.props} />
    </ModalCard>
  );
}
