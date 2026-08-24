import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as SecureStore from '@/lib/secure-store';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Linking,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Aliased because this screen's own component is called MapUnit; two things
// under one name here would be a trap rather than a coincidence.
import {
  TIER_COLOR,
  TIER_LABEL,
  UnitMap,
  envelopeText,
  mapAvailable,
  toTier,
  type MapEnvelope,
  type MapUnit as MarkerUnit,
  type UnitTier,
} from '@/components/unit-map';
import { Crumb, Prompt } from '@/components/wizard';
import { InfoDot } from '@/components/info-dot';
import { ScreenHeader } from '@/components/screen-header';
import { UnitSearch } from '@/components/unit-search';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { BRAND } from '@/lib/api';
import { tap } from '@/lib/haptics';
import { useUi } from '@/lib/theme';
import { authedGet, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import {
  describeFixFailure,
  MAPPING_RADIUS_M,
  trySubmitFix,
  tryQuickFix,
  type Fix,
} from '@/lib/location';
import { regFetch } from '@/lib/register-fetch';

type Unit = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state?: string;
  coords_source: string | null;
  crowd_reports: number;
  /** GPS discovery only (/api/polling-units, /api/mapping/nearby). */
  locationTier?: string;
  distanceM?: number;
  /** Coalesced at discovery, because the two lookups spell coordinates
   *  differently and neither spelling is what the map wants. Absent on the
   *  register-browse path — a unit found by name has nowhere to be drawn. */
  mapLat?: number;
  mapLng?: number;
  /**
   * The area a unit with no confirmed position is known to sit somewhere
   * inside — carrying its OWN centre, never inheriting the drawn point above.
   *
   * In the register those are DIFFERENT PLACES. `mapLat/mapLng` come from `lat`
   * or `crowd_lat` — somewhere a person actually stood — while the envelope is
   * a GRID3 ward-scale box centred on `approx_lat/approx_lng`, a median 2,533m
   * from the crowd point, 10km at p90 and 145km at worst, with radii averaging
   * 2.8km. Pairing one row's point with the other's radius (which is what
   * reading two columns off the same register row did) asserts an area centred
   * on a place the envelope makes no claim about, and inside a map framed to
   * ~1km it drew a full-bleed amber wash over every pin.
   *
   * Set ONLY where the drawn point IS this envelope's centre — in practice, a
   * /api/mapping/nearby row whose `status` is `approx`. This is the circle the
   * observer is being asked to collapse.
   */
  envelope?: MapEnvelope;
  /**
   * The envelope's SIZE only, for a unit whose pin is a crowd fix rather than
   * the envelope centre — so there is a number to say but nothing to draw.
   *
   * Deliberately not a MapEnvelope: it has no centre, precisely so it cannot
   * be handed to the map. It exists because withholding the size entirely left
   * this screen mute about the 109,507 geocoded units while report/result.tsx
   * stated their radius, and two screens describing one unit differently is
   * the failure this whole area keeps producing.
   */
  areaOnlyM?: number;
};

/** /api/polling-units hands back whole register rows, so its coordinates arrive
 *  raw: verified ones in lat/lng, crowd medians in crowd_lat/crowd_lng. */
type LocatedRow = Unit & {
  lat?: number | null;
  lng?: number | null;
  crowd_lat?: number | null;
  crowd_lng?: number | null;
  approx_radius_m?: number | null;
};

/** /api/observers/my-unit LEFT JOINs the register, so every field but the code may be null. */
type SavedUnit = {
  pu_code: string;
  name: string | null;
  ward: string | null;
  lga: string | null;
  state: string | null;
};

type Stats = { total: number; verified: number; crowdMapped: number; unitsWithFixes: number };

/** /api/mapping/nearby's row shape — camelCase and thinner than a register row.
 *  Its lat/lng are already coalesced server-side (verified, else the envelope
 *  centre), and approxRadiusM is non-null exactly when they are the latter. */
type NearbyRow = {
  puCode: string;
  name: string;
  ward: string;
  lat: number;
  lng: number;
  distanceM: number;
  status: 'verified' | 'crowd' | 'approx';
  approxRadiusM: number | null;
  fixes: number;
};

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

/** Rows kept from the merged lookup. Same cap as report/result.tsx, so the two
 *  screens truncate one shared list in the same place. */
const MAX_NEARBY = 12;

/**
 * How far /api/polling-units looks, and how many rows it returns — used only
 * until it says so itself, which it now does on every answer.
 *
 * That endpoint takes no radius: it filters at backend/src/config.js
 * `discoveryRadiusM` and slices at `discoveryMaxRows`, while /api/mapping/nearby
 * honours the radiusM we ask for (800m). Two different windows behind one
 * button, so no single number can describe the search — which is why the copy
 * below names both, and why the response's own `radiusM`, `maxRows` and `capped`
 * are preferred over these mirrors whenever they arrive.
 *
 * Note the discovery radius is NOT the submission geofence
 * (`config.geofenceRadiusM`); they answer different questions and are different
 * numbers, and pointing one at the other is the mistake config.js warns about.
 */
const REGISTER_RADIUS_M = 500; // config.discoveryRadiusM, as of writing
const REGISTER_MAX_ROWS = 40; // config.discoveryMaxRows, as of writing

/**
 * What the two lookups covered on the last run, so the screen can describe the
 * area it really searched instead of the area it drew.
 *
 * Same shape, and below the same sentences, as report/result.tsx. The two
 * screens run the identical pair of lookups over the identical register, and an
 * observer who is told two different things about the same circle on two
 * screens has been given a reason to believe neither.
 */
type Searched = {
  /** Radius /api/polling-units filtered at, or null if it never answered. */
  registerM: number | null;
  /** Radius /api/mapping/nearby was asked for, or null if it never answered. */
  envelopeM: number | null;
  /**
   * The row cap /api/polling-units applied — its own `maxRows`, so the copy
   * quotes the server's number rather than a mirror that can drift from it.
   */
  maxRows: number;
  /**
   * The register lookup hit that cap, so nearer units may be missing. The
   * server says so outright; only one too old to send `capped` leaves it to be
   * inferred from the row count.
   */
  capped: boolean;
};

/**
 * What the ring on the map is, in words, given what actually answered.
 *
 * The ring can only ever be one circle, and the two lookups search two
 * different ones — MAPPING_RADIUS_M for units with a GRID3 area, and whatever
 * /api/polling-units reports as its own `radiusM` (config.discoveryRadiusM) for
 * units an observer has already placed; both are read off the answers below
 * rather than written as literals. Drawing the wider and leaving it unlabelled
 * reads as "everything in here was checked", which is false for the 7,652 units only the
 * narrow lookup can see. So the ring is named.
 */
const ringLine = (_s: Searched): string =>
  'Units found within an 800m radius. Unmapped units may not appear on map.';

/** The same honesty for an empty answer: name the circles that were searched,
 *  rather than the one that was drawn. */
const nothingFoundLine = (s: Searched): string => {
  if (s.envelopeM != null && s.registerM != null) {
    return `No polling unit found. Hawkeye searched ${s.registerM}m around you for units observers have already placed, and ${s.envelopeM}m for units known only by their mapped area — browse the register below to find yours by name.`;
  }
  if (s.envelopeM != null) {
    return `No polling unit with a mapped area within ${s.envelopeM}m of you, and the lookup that finds units placed by observers did not answer — browse the register below to find yours by name.`;
  }
  if (s.registerM != null) {
    return `No polling unit within ${s.registerM}m of you, and the wider search for units with a mapped area did not answer — browse the register below to find yours by name.`;
  }
  // Point at SEARCH, not browse: browsing is network-backed (/lgas, /wards,
  // /units), so on a lookup failure it is the one other path that cannot work
  // either. Search answers from the register bundled into the app.
  return 'Could not look up nearby units. Search for yours by name below — the polling unit list works without a connection.';
};

/**
 * A list row's tier: the map's three, plus the one state the map cannot draw.
 *
 * `unmapped` is deliberately NOT folded into `approx` the way toTier() folds it.
 * That fold is right for the map — an approx unit still has an envelope to draw
 * — and wrong here: a unit with no position at all cannot appear on the map, and
 * it is the single population this screen exists to fix. Flattening it would
 * hide exactly the units most in need of a fix.
 */
type RowTier = UnitTier | 'unmapped';

/**
 * THE row vocabulary. The three map tiers are the legend's own phrases, imported
 * rather than re-typed, because the legend and the rows a few pixels under it
 * grading the same unit in different words is what made an observer distrust
 * both. (This screen used to caption a geocoded unit "located from map data"
 * one line below a legend calling it "Approximate area".)
 */
const ROW_LABEL: Record<RowTier, string> = {
  ...TIER_LABEL,
  unmapped: 'Not located yet',
};

/**
 * Which tier a row is drawn as.
 *
 * Both endpoints behind this screen stamp `locationTier` on every row they
 * return (backend/src/routes/pollingUnits.js `tierOf`, and /mapping/nearby's
 * `status`), so the register-column fallback below is for locally-built rows
 * only. It reads those columns the way the backend does rather than treating
 * any source at all as verified — `geocoded` in particular is a name match
 * against map data that nobody has stood at, and claiming it as located is the
 * overstatement this screen is meant to correct.
 *
 * `crowd_mapped` is checked FIRST, ahead of the server's own tier, and only for
 * that one value. /api/polling-units and /api/register/units share a `tierOf()`
 * that grades any row holding `lat` as `verified` — including the crowd
 * promotions THIS screen creates, since POST /api/mappings writes the clustered
 * median into `lat` alongside `coords_source = 'crowd_mapped'`
 * (backend/src/routes/mapping.js). /api/mapping/nearby reads coords_source and
 * calls the same row `crowd`, and report/result.tsx shows it that way. Without
 * this line an observer is told "this unit is now crowd-confirmed", sees it go
 * green and "Verified location" here, and blue and "Crowd-confirmed location"
 * on the reporting screen. Zero rows are crowd_mapped today; every promotion
 * after launch is one, and the browse path has no /mapping/nearby row to be
 * corrected by.
 */
const rowTier = (u: Unit): RowTier => {
  // Ahead of locationTier, and the old fallback copy of this test below is gone
  // with it — leaving a second, unreachable one would read as a disagreement
  // about which check owns this value.
  if (u.coords_source === 'crowd_mapped') return 'crowd';
  if (u.locationTier) return u.locationTier === 'unmapped' ? 'unmapped' : toTier(u.locationTier);
  if (u.coords_source === 'geocoded') return 'approx';
  if (u.coords_source && u.coords_source !== 'sample') return 'verified';
  return 'unmapped';
};

/**
 * What the tier alone does not say, in the same shape report/result.tsx uses for
 * its nearby rows. An approx unit's envelope is the fact that matters — it is
 * the area one fix collapses — and elsewhere the count of fixes that already
 * agreed. `crowd_reports` is only ever written alongside a crowd coordinate
 * (backend/src/services/aggregate.js), so it never contradicts the tier here.
 *
 * This line now carries envelopes the map deliberately refuses to draw. Real
 * radii average 2.8km against an 800m search, and a circle with no visible edge
 * is a wash rather than a shape (see the ENVELOPE RULE in components/unit-map),
 * so for most approx units these words are the only statement of the number.
 *
 * The wording comes from components/unit-map's own envelopeText() rather than
 * being spelled again here. Both screens describe the same envelope for the same
 * unit, and a local Math.round against the other's toLocaleString printed one
 * 1200m envelope as "~1200m" here and "~1,200m" there — two renderings of one
 * fact, which is exactly the drift the shared vocabulary above exists to stop.
 */
const tierDetail = (u: Unit, tier: RowTier) =>
  tier === 'approx' && u.envelope
    ? envelopeText(u.envelope.radiusM)
    : // Same sentence for a unit whose pin is a crowd fix: the size is known,
      // the centre is elsewhere, so it is stated rather than drawn. Silence
      // here was what made this screen and report/result.tsx contradict each
      // other on the geocoded units.
      tier === 'approx' && u.areaOnlyM
      ? envelopeText(u.areaOnlyM)
      : u.crowd_reports
        ? ` · ${u.crowd_reports} observer fix(es)`
        : '';

/** Tailwind's emerald-100 — the colour a row's sub-text already switches to on
 *  the selected (hawk-green) row, so the dot matches the line it sits in. */
const SELECTED_SUB = '#d1fae5';

/**
 * A row's tier as the very colour the map draws that unit in, so a row and its
 * pin can never disagree. The white keyline is there for the reason the map's
 * own pins carry one: it is the only edge that survives both the pale card and
 * the dark green of a selected row.
 *
 * `unmapped` is hollow on purpose. It has no tier colour because it has no pin
 * — the map cannot place it at all — and an empty ring is the honest glyph for
 * "nothing here yet". Amber is already taken by "approximate, still needs
 * mapping", and red is not in the palette: none of these states is an error.
 */
function TierDot({ tier, on }: { tier: RowTier; on: boolean }) {
  const ui = useUi();
  return (
    <View
      className="mr-1.5 h-2.5 w-2.5 rounded-full"
      style={
        tier === 'unmapped'
          ? { borderWidth: 1.5, borderColor: on ? SELECTED_SUB : ui.faint }
          : { backgroundColor: TIER_COLOR[tier], borderWidth: 1, borderColor: '#ffffff' }
      }
    />
  );
}

const num = (v: number) => v.toLocaleString();

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <View className="flex-1 pr-2">
      <Text className="text-lg font-bold text-ink">{value}</Text>
      <Text className="text-[11px] leading-4 text-muted">{label}</Text>
    </View>
  );
}

/**
 * Map a polling unit — stand at the unit, record one GPS fix.
 *
 * INEC's official coordinate database is not public, so most register rows have
 * no verified location. When enough independent observer fixes cluster tightly,
 * the median is promoted to the unit's coordinate and it becomes geofence-ready.
 * That is why this screen matters out of proportion to its size: every unit
 * mapped before election day is a unit whose result reports can be location-proven.
 *
 * Unlike results, this is a plain JSON POST — no photos, no signature.
 */
export default function MapUnit() {
  const ui = useUi();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unit, setUnit] = useState<Unit | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [saved, setSaved] = useState<SavedUnit | null>(null);
  const [saving, setSaving] = useState(false);

  const [nearby, setNearby] = useState<Unit[]>([]);
  /** Kept after the lookup so the map has something to centre and size on. */
  const [fix, setFix] = useState<Fix | null>(null);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  /** What the last run actually searched — the map ring, the empty state and
   *  the truncation note are all read off this rather than off the radius the
   *  screen would like to have searched. */
  const [searched, setSearched] = useState<Searched | null>(null);
  const [browse, setBrowse] = useState(false);
  /** True while the observer is typing a search — see the note at UnitSearch. */
  const [searchTyping, setSearchTyping] = useState(false);
  /** Engaging search OR the register drill hides the map + nearby list above. */
  const searchBusyHiding = searchTyping || browse;
  /** Set only when the last GPS failure is one the settings app has to fix
   *  (location off, or permission blocked with no dialog left). A timeout must
   *  never raise it — permission is granted in that case, and saying otherwise
   *  is what sent observers hunting a setting that was never wrong. */
  const [gpsSettings, setGpsSettings] = useState(false);

  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; line: string } | null>(null);

  // NO contest filter: mapping is election-independent and nationwide. Passing
  // a contest narrows the register to that race's states (today: Osun only),
  // which made the whole rest of the country unmappable for no reason.
  useEffect(() => {
    regFetch(`${REG}/states`)
      .then((r) => r.json())
      .then(setStates)
      .catch(() => {});
  }, []);

  // Coverage is the argument for doing this at all — an observer who can see
  // that most of the register has no location understands why one fix matters.
  useEffect(() => {
    fetch(`${BASE}/api/mapping/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {
        // Motivational, not functional — a failed count must not block mapping.
      });
  }, []);

  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let live = true;
    authedGet<{ unit: SavedUnit | null }>('/api/observers/my-unit')
      .then((r) => {
        if (live) setSaved(r.unit ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [auth.status]);

  useEffect(() => {
    if (!stateSel) return;
    regFetch(`${REG}/lgas?state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json())
      .then(setLgas)
      .catch(() => {});
  }, [stateSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel) return;
    regFetch(`${REG}/wards?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`)
      .then((r) => r.json())
      .then(setWards)
      .catch(() => {});
  }, [stateSel, lgaSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel || !wardSel) return;
    fetch(
      `${REG}/units?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}&ward=${encodeURIComponent(wardSel)}`,
    )
      .then((r) => r.json())
      .then((d) => setUnits(d.units ?? []))
      .catch(() => {});
  }, [stateSel, lgaSel, wardSel]);

  // Backing out must drop the selection, or the CTA stays live for a hidden unit.
  useEffect(() => {
    setUnit(null);
  }, [stateSel, lgaSel, wardSel]);

  /**
   * The map draws exactly the list below it, never its own query — the two
   * disagreeing is the one failure mode that would make an observer distrust
   * both. Units without a coordinate are dropped rather than guessed at.
   */
  const mapUnits = useMemo<MarkerUnit[]>(() => {
    const drawn: MarkerUnit[] = [];
    for (const u of nearby) {
      // Same rowTier() the list rows are labelled from, so a pin and the row
      // under it cannot be graded by two different rules — and an unmapped unit
      // is dropped rather than drawn at a guessed point, which is the one thing
      // a map that exists to collect positions must never do.
      const tier = rowTier(u);
      if (u.mapLat == null || u.mapLng == null || tier === 'unmapped') continue;
      drawn.push({
        puCode: u.pu_code,
        name: u.name,
        lat: u.mapLat,
        lng: u.mapLng,
        tier,
        // Passed whole or not at all. It is only ever set where the point above
        // IS its centre, so the map can draw it about itself without having to
        // trust that this screen paired the two honestly.
        envelope: u.envelope,
      });
    }
    return drawn;
  }, [nearby]);

  /**
   * The circle to draw. Normally the envelope search, the wider of the two and
   * so the one that frames every result — but if only the register lookup
   * answered, the ring drops to what IT searched rather than standing at four
   * times the radius anything was actually queried at.
   */
  const ringM = searched?.envelopeM ?? searched?.registerM ?? MAPPING_RADIUS_M;

  /**
   * GPS discovery — the primary path, as on the web. An observer standing at
   * their unit knows where they are, not how their ward is spelled in the
   * register, and the drill-down is four taps deep before it shows a unit.
   *
   * Two lookups, because neither alone answers "which unit am I at?" on THIS
   * screen. /polling-units returns only units that already hold a coordinate —
   * exactly the ones that need no mapping — so on its own it hands an observer
   * at an unmapped unit an empty list. /mapping/nearby also returns units
   * placed only by a GRID3 approx envelope, which is the population this
   * screen exists to fix, but it carries no LGA and cannot replace the first.
   *
   * THE TWO SEARCH DIFFERENT AREAS, and nothing on screen may pretend otherwise.
   * /polling-units measures at config.discoveryRadiusM and caps at
   * config.discoveryMaxRows — both of which it reports on the wire, so the copy
   * quotes them rather than mirroring them — while /mapping/nearby honours
   * MAPPING_RADIUS_M (5km) and returns up to 200. So an empty result is never
   * "there is no unit within 800m of you": a crowd-located unit can sit inside
   * the ring and outside the only lookup that can see it. Both numbers are named
   * in the copy for that reason.
   */
  const findNearby = async () => {
    setNearBusy(true);
    setNearby([]);
    // A stale fix would leave the map drawing a ring around where the observer
    // used to be, which is worse than drawing no ring at all — and a stale
    // scope would caption that ring with the last run's numbers.
    setFix(null);
    setSearched(null);
    setGpsSettings(false);
    setNearLine('Getting your location…');
    try {
      // Quick fix, not the submit-grade one: this only shortlists candidates.
      // The accurate fix is taken again at submit, where the server checks it.
      //
      // The failure is DISCRIMINATED and named. One message for all of them
      // told observers with working permission that they had none — and this
      // screen exists to recruit exactly those people into mapping units.
      const r = await tryQuickFix();
      if (!r.ok) {
        const d = describeFixFailure(r);
        setNearLine(`${d.lead}, or browse the register below. (${d.code})`);
        setGpsSettings(d.settings);
        return;
      }
      const fix = r.fix;
      setFix(fix);
      setNearLine(`Location fixed (±${Math.round(fix.accuracy)}m). Looking up units around you…`);

      const [located, envelope] = await Promise.all([
        fetch(`${BASE}/api/polling-units?lat=${fix.lat}&lng=${fix.lng}`).catch(() => null),
        // Mapping searches 5km on purpose (see MAPPING_RADIUS_M): this screen
        // below draws, and a ring that is not the area actually searched turns
        // the map from evidence into decoration.
        fetch(
          `${BASE}/api/mapping/nearby?lat=${fix.lat}&lng=${fix.lng}&radiusM=${MAPPING_RADIUS_M}`,
        ).catch(() => null),
      ]);

      // Either lookup may fail alone; only losing both is fatal. Each sees a
      // population the other cannot — and this screen's whole reason to exist
      // is the envelope-only units, so a register outage must not take them
      // down with it. What was and was not searched is then said out loud.
      if (!located?.ok && !envelope?.ok) {
        const status = located?.status ?? envelope?.status;
        setNearLine(
          `Could not look up nearby units. Search for yours by name below — the polling unit list works without a connection. (lookup_failed${status ? ` / HTTP ${status}` : ''})`,
        );
        return;
      }

      const body: {
        radiusM?: number;
        maxRows?: number;
        capped?: boolean;
        units?: LocatedRow[];
      } = located?.ok ? await located.json().catch(() => ({})) : {};
      const extra = envelope?.ok
        ? (((await envelope.json().catch(() => ({}))) as { units?: NearbyRow[] }).units ?? [])
        : [];

      /**
       * Recorded BEFORE the merge, because afterwards the two populations are
       * indistinguishable and every sentence about "within Xm" needs to know
       * which circle it means. The register lookup reports the radius it used,
       * so that beats the local mirror; a lookup that did not answer
       * contributes no radius rather than its intended one, since nothing
       * inside it was searched at all.
       *
       * Its cap and its truncation flag are taken the same way and for the same
       * reason: the server owns those numbers, and a mirror of one is wrong the
       * moment the server moves it.
       */
      const registerMaxRows = Number.isFinite(body.maxRows)
        ? Number(body.maxRows)
        : REGISTER_MAX_ROWS;
      const scope: Searched = {
        registerM: located?.ok
          ? Number.isFinite(body.radiusM)
            ? Number(body.radiusM)
            : REGISTER_RADIUS_M
          : null,
        envelopeM: envelope?.ok ? MAPPING_RADIUS_M : null,
        maxRows: registerMaxRows,
        // Only inferred against a server too old to send `capped` — there a
        // full answer and a truncated one look identical on the wire, so a full
        // one is treated as truncated.
        capped:
          typeof body.capped === 'boolean'
            ? body.capped
            : (body.units?.length ?? 0) >= registerMaxRows,
      };
      setSearched(scope);

      const merged = new Map<string, Unit>();
      for (const u of body.units ?? []) {
        // A unit here is listed because it holds a coordinate, but which column
        // that is depends on how it was located; the map only cares that there
        // is one. Nullish, not `||`, so a genuine 0 is not thrown away.
        const uLat = u.lat ?? u.crowd_lat;
        const uLng = u.lng ?? u.crowd_lng;
        merged.set(u.pu_code, {
          ...u,
          mapLat: uLat ?? undefined,
          mapLng: uLng ?? undefined,
          // NO ENVELOPE, deliberately, even though `approx_radius_m` is right
          // there on the row. A unit reaches this list by holding `lat` or
          // `crowd_lat`, so the point above is one of those — and the envelope
          // is centred on `approx_lat/approx_lng`, a median 2.5km away. The
          // radius describes that other place, not this pin.
          //
          // The SIZE still matters though, so it is kept in a field that can
          // never be drawn. Withholding it entirely left this screen saying
          // only "record a fix here to confirm it" for all 109,507 geocoded
          // units, while report/result named the radius and explained the
          // offset centre — the same unit described in contradictory terms on
          // two screens. Never assign this to MapUnit.envelope.
          areaOnlyM:
            u.lat == null && (u.approx_radius_m ?? 0) > 0 ? (u.approx_radius_m as number) : undefined,
        });
      }
      for (const n of extra) {
        const seed = merged.get(n.puCode);
        if (seed) {
          // The register row wins on everything it knows — state, LGA,
          // coords_source, and the position both screens draw. Only the TIER is
          // taken from here, and only when the two rows describe the SAME
          // POINT: /mapping/nearby draws `lat ?? approx_lat` while the register
          // row draws `lat ?? crowd_lat`, and those coincide exactly when
          // `status` is not 'approx'. When it IS approx, this row is grading a
          // GRID3 box a median 2.5km from the fix above — a different place,
          // whose tier belongs to it and not to the pin we are drawing, which
          // its crowd position has already superseded.
          if (n.status !== 'approx') {
            /**
             * `fixes` comes across too, and it has to: `crowd_reports` on the
             * register row is written only by aggregate.js, which runs inside
             * `if (pu.lat == null)`. The moment THIS screen promotes a unit
             * (mapping.js sets lat + coords_source='crowd_mapped') that branch
             * is false forever, so the column freezes at 0 while
             * /api/mapping/nearby's `fixes` is a live COUNT over pu_mappings.
             * Leaving the stale column made this screen show no fix count on
             * the very unit it had just crowd-confirmed, while report/result
             * showed the real one — same unit, two stories.
             */
            merged.set(n.puCode, {
              ...seed,
              locationTier: n.status,
              crowd_reports: n.fixes || seed.crowd_reports,
            });
          }
          continue;
        }
        merged.set(n.puCode, {
          pu_code: n.puCode,
          name: n.name,
          ward: n.ward,
          lga: '',
          coords_source: null,
          crowd_reports: n.fixes,
          locationTier: n.status,
          distanceM: n.distanceM,
          mapLat: n.lat,
          mapLng: n.lng,
          // Here — and only here — the drawn point IS the envelope's centre:
          // the endpoint coalesces to approx_lat/approx_lng when `lat` is null,
          // which is exactly when it reports `approx` and fills approxRadiusM.
          // So the two are one fact and may travel together.
          envelope:
            n.status === 'approx' && n.approxRadiusM && n.approxRadiusM > 0
              ? { lat: n.lat, lng: n.lng, radiusM: n.approxRadiusM }
              : undefined,
        });
      }
      const all = [...merged.values()].sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
      const found = all.slice(0, MAX_NEARBY);

      setNearby(found);
      if (found.length === 0) {
        // NOT "within 800m": the units only /api/polling-units can see were
        // searched at the narrower radius it reports for itself, so one radius
        // in this sentence would be a positive claim about a circle nothing ever
        // looked in — and would send an observer hunting for a unit the app
        // never asked about.
        setNearLine(nothingFoundLine(scope));
        return;
      }
      setNearLine(
        all.length > found.length
          ? `Tap the unit you are standing at — the ${found.length} closest of the ${all.length} found:`
          : 'Tap the unit you are standing at:',
      );
    } catch (e) {
      setNearLine(
        `Could not look up nearby units. Search for yours by name below — the polling unit list works without a connection. (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setNearBusy(false);
    }
  };

  /**
   * GPS FIRST here too. Mapping a unit is the one flow where the observer is
   * definitionally standing at the thing they are describing, so opening this
   * screen IS the request to find what is around them. Same rule as the report
   * flows: once per arrival, suggests only, and every failure path inside
   * findNearby already lands somewhere usable.
   */
  const [autoNearRan, setAutoNearRan] = useState(false);
  useEffect(() => {
    if (autoNearRan || unit) return;
    setAutoNearRan(true);
    void findNearby();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNearRan, unit]);

  /** Errors go to a modal: inline text below a long unit list is never seen. */
  const fail = (msg: string) => {
    setLine(msg);
    Alert.alert('Could not record the fix', msg);
  };

  const isSaved = !!unit && saved?.pu_code === unit.pu_code;

  /**
   * The star is the alert switch, not a bookmark: the server subscribes the
   * observer to every result report and approved incident at the saved unit,
   * and report/incident.tsx reads this same code to route an incident to a
   * unit. Asking here is the cheapest moment — they have just told us which
   * unit they are standing at.
   *
   * One saved unit per observer (saved_units is keyed by observer id), so
   * saving a different unit replaces the old one rather than adding to it.
   */
  const toggleSaved = async () => {
    if (!unit) return;
    const removing = isSaved;
    setSaving(true);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const id = await getIdentity();
      const res = await fetch(`${BASE}/api/observers/my-unit${removing ? '/clear' : ''}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify(removing ? {} : { puCode: unit.pu_code }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        const code = body.error ?? `http_${res.status}`;
        Alert.alert(
          removing ? 'Could not remove your polling unit' : 'Could not save your polling unit',
          code === 'unknown_unit'
            ? `${unit.name} is not in the register. (${code} / HTTP ${res.status})`
            : `Please check your connection and try again. (${code} / HTTP ${res.status})`,
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSaved(
        removing
          ? null
          : {
              pu_code: unit.pu_code,
              name: unit.name,
              ward: unit.ward,
              lga: unit.lga,
              state: unit.state ?? null,
            },
      );
    } catch (e) {
      Alert.alert(
        'Could not update your polling unit',
        `Please try again. (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = async () => {
    tap();
    if (!unit) return;
    setBusy(true);
    setLine('Getting an accurate fix — stand still…');
    try {
      // Named failure, not "no GPS fix". Mapping a unit is a standing-outside
      // task, so a timeout here is genuinely a signal problem and should say
      // so — while a real permission or services problem gets its own words
      // instead of hiding behind the same sentence.
      const got = await trySubmitFix();
      if (!got.ok) {
        const d = describeFixFailure(got);
        fail(`${d.lead}. (${d.code})`);
        setBusy(false);
        return;
      }
      const fix = got.fix;
      const id = await getIdentity();
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const res = await fetch(`${BASE}/api/mappings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify({
          puCode: unit.pu_code,
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        fixes?: number;
        needed?: number;
        mapped?: boolean;
        replaced?: boolean;
        error?: string;
        maxAccuracyM?: number;
      };
      if (res.ok && body.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone(
          body.mapped
            ? {
                title: 'Unit confirmed',
                line: `${unit.name} is now crowd-confirmed — ${body.fixes} observer fixes agreed. Result reports here can now be location-verified.`,
              }
            : {
                title: body.replaced ? 'Fix updated' : 'Fix recorded',
                line: `${body.fixes} of ${body.needed} observers needed to confirm ${unit.name}. Ask others at this unit to map it too.`,
              },
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const code = body.error ?? `http_${res.status}`;
      fail(
        code === 'gps_accuracy_too_low'
          ? `GPS accuracy too low (needs ${body.maxAccuracyM ?? 100}m or better) — step into the open and retry.`
          : code === 'too_far_from_unit'
            ? 'You are too far from this unit — map it while standing at the unit.'
            : code === 'unknown_polling_unit'
              ? 'That unit is not in the register.'
              : `Could not record the fix. (${code} / HTTP ${res.status})`,
      );
    } catch (e) {
      fail(`Could not record the fix. (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  if (auth.status !== 'signedIn') {
    return (
      <View className="flex-1 items-center justify-center bg-surface px-8">
        <Feather name="lock" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-ink">
          Sign in to map a polling unit
        </Text>
        <Pressable
          className="mt-4 rounded-2xl bg-hawk-green px-6 py-3"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={() => router.back()}>
          <Text className="text-sm text-muted">Not now</Text>
        </Pressable>
      </View>
    );
  }

  if (done) {
    return (
      <View className="flex-1 items-center justify-center bg-surface px-8">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
          <Feather name="map-pin" size={28} color={BRAND.gold} />
        </View>
        <Text className="pt-4 text-center text-lg font-bold text-ink">{done.title}</Text>
        <Text className="pt-2 text-center text-sm text-muted">{done.line}</Text>
        <Pressable
          className="mt-6 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
          onPress={() => router.back()}
        >
          <Text className="text-base font-bold text-hawk-gold">Done</Text>
        </Pressable>
      </View>
    );
  }

  const Chip = ({ label, onPress }: { label: string; onPress: () => void }) => (
    <Pressable
      onPress={onPress}
      className="mb-2 mr-2 rounded-full bg-card px-4 py-2 active:opacity-70"
    >
      <Text className="text-sm font-semibold text-ink">{label}</Text>
    </Pressable>
  );

  const UnitRow = ({ u }: { u: Unit }) => {
    const on = unit?.pu_code === u.pu_code;
    const tier = rowTier(u);
    return (
      <Pressable
        onPress={() => setUnit(u)}
        className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-card'}`}
      >
        <View className="flex-1 pr-2">
          <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-ink'}`}>
            {u.name}
          </Text>
          <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-muted'}`}>
            {u.distanceM != null ? `${u.pu_code} · ${u.distanceM}m away` : u.pu_code}
          </Text>
          {/* The tier gets its own line beside its dot rather than trailing the
              code on one: this is the line the map above is read against, and a
              wrap would otherwise orphan the dot from the words it colours. */}
          <View className="flex-row items-center pt-0.5">
            <TierDot tier={tier} on={on} />
            <Text className={`flex-1 text-xs ${on ? 'text-emerald-100' : 'text-muted'}`}>
              {ROW_LABEL[tier]}
              {tierDetail(u, tier)}
            </Text>
          </View>
        </View>
        {saved?.pu_code === u.pu_code ? (
          <Feather name="star" size={16} color={on ? BRAND.gold : BRAND.leaf} />
        ) : null}
      </Pressable>
    );
  };

  const pct = stats && stats.total ? (stats.verified / stats.total) * 100 : 0;

  /** Envelope radius of the selected unit, when it has one — i.e. when the unit
   *  is known as an area rather than a point. Read off the envelope itself, so
   *  it can only ever be the radius of the thing the pin is standing in.
   *
   *  Kept a NUMBER, not a formatted string: the footer below tests it for
   *  truthiness, and a rounded-to-"0" radius must fall through to the plainer
   *  sentence rather than promise an area of nothing. Grouping is applied where
   *  it is printed. */
  const envelopeM =
    unit && rowTier(unit) === 'approx' && unit.envelope
      ? Math.round(unit.envelope.radiusM)
      : null;

  /** The selected unit has no position at all — and we were actually told so.
   *  The saved-unit card above builds a Unit with no tier of its own (/my-unit
   *  reports none), and a unit must never be captioned as unlocated merely
   *  because this screen does not know. */
  const selUnlocated = unit != null && !!unit.locationTier && rowTier(unit) === 'unmapped';

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader
        title="Map a polling unit"
        translateY={translateY}
        onClose={() => router.back()}
      />

      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 32 }}
        /* Same first-tap-eaten bug fec1235 fixed on result/collation: the search
           field lives on this screen, so without this the first tap on a state
           chip only dismissed the keyboard. This screen was missed then. */
        keyboardShouldPersistTaps="handled"
      >
        {/* The instruction stays visible — it is what to do, not why. */}
        <View className="flex-row items-center pb-3">
          <Text className="flex-1 text-sm text-muted">
            Stand at the polling unit and record one GPS fix.
          </Text>
          <InfoDot
            title="Why mapping units matters"
            text="Most polling units have no confirmed location on record, so results reported from them cannot be location-checked. When enough independent observers agree on a unit's position it becomes location-verified, and every result filed there on election day can be matched against it."
          />
        </View>

        {stats ? (
          <View className="mb-3 rounded-2xl bg-card px-4 py-3">
            <Text className="pb-2 text-[11px] font-bold uppercase tracking-wider text-faint">
              Nationwide mapping coverage
            </Text>
            <View className="flex-row">
              <StatCell
                value={`${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`}
                label={`${num(stats.verified)} of ${num(stats.total)} located`}
              />
              <StatCell value={num(stats.crowdMapped)} label="crowd-mapped by observers" />
              <StatCell value={num(stats.unitsWithFixes)} label="have at least one fix" />
            </View>
          </View>
        ) : null}

        {saved ? (
          <Pressable
            onPress={() =>
              setUnit({
                pu_code: saved.pu_code,
                name: saved.name ?? saved.pu_code,
                ward: saved.ward ?? '',
                lga: saved.lga ?? '',
                state: saved.state ?? undefined,
                // Unknown from /my-unit, and never shown: this row is a jump
                // target for the footer, not a tier badge.
                coords_source: null,
                crowd_reports: 0,
              })
            }
            className={`mb-3 flex-row items-center rounded-2xl px-4 py-3 active:opacity-70 ${
              unit?.pu_code === saved.pu_code ? 'bg-hawk-green' : 'bg-card'
            }`}
          >
            <Feather
              name="star"
              size={18}
              color={unit?.pu_code === saved.pu_code ? BRAND.gold : BRAND.leaf}
            />
            <View className="flex-1 pl-2">
              <Text
                className={`text-[11px] font-bold uppercase tracking-wider ${
                  unit?.pu_code === saved.pu_code ? 'text-emerald-100' : 'text-faint'
                }`}
              >
                Your polling unit
              </Text>
              <Text
                className={`text-base font-semibold ${
                  unit?.pu_code === saved.pu_code ? 'text-white' : 'text-ink'
                }`}
              >
                {saved.name ?? saved.pu_code}
              </Text>
              <Text
                className={`text-xs ${
                  unit?.pu_code === saved.pu_code ? 'text-emerald-100' : 'text-muted'
                }`}
              >
                {[saved.ward ? `${saved.ward} ward` : null, saved.lga, saved.state]
                  .filter(Boolean)
                  .join(', ') || saved.pu_code}
              </Text>
            </View>
          </Pressable>
        ) : null}

        {/* GPS FIRST. The drill-down is four taps deep before it shows a unit;
            someone standing at their unit should not have to spell their ward. */}
        <Pressable
          disabled={nearBusy}
          onPress={findNearby}
          className={`flex-row items-center justify-center rounded-2xl py-4 ${nearBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
        >
          {nearBusy ? (
            <ActivityIndicator color={BRAND.gold} />
          ) : (
            <>
              <Feather name="crosshair" size={17} color={BRAND.gold} />
              <Text className="pl-2 text-base font-bold text-hawk-gold">Find units near me</Text>
            </>
          )}
        </Pressable>

        {/* text-warn-ink, not amber-800: this line sits on bg-surface, and the
            fixed amber failed contrast on the light surface and vanished into
            the dark one. The semantic token is the pair that is legible in both. */}
        {nearLine ? (
          <Text className="pt-3 text-sm font-semibold text-warn-ink">{nearLine}</Text>
        ) : null}

        {/* Only for the failures the settings app is the cure for. The button
            above is already the retry, so a weak-signal timeout gets the honest
            sentence and another tap, not a detour into system settings. */}
        {gpsSettings ? (
          <Pressable
            onPress={() => Linking.openSettings()}
            className="mt-2 flex-row items-center self-start rounded-xl border border-line px-3 py-2 active:opacity-70"
          >
            <Feather name="settings" size={14} color={ui.muted} />
            <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
          </Pressable>
        ) : null}

        {/* The register lookup caps its answer. In a dense ward the unit the
            observer is standing at can be the row past the cap — and the list
            above would look complete. Said once, and only when the server
            reports the answer as truncated; the cap and the radius quoted here
            are its numbers, off the wire, not a mirror of them. */}
        {searched?.capped && nearby.length ? (
          <Text className="pt-1 text-xs text-muted">
            Units already placed by observers are looked up {searched.maxRows} at a time within{' '}
            {searched.registerM}m, and that limit was reached — if yours is not listed, browse the
            register below.
          </Text>
        ) : null}

        {/* Under the status line, over the list: the map answers the one
            question the list cannot — which of these am I actually standing
            at. It is drawn even when nothing was found, because an empty ring
            is a claim about the specific circle that was searched, where an
            empty list is just a shrug.
            Kept a little under the component's own default height: this screen
            carries a coverage card and a saved-unit card above the map and a
            two-button footer below it, so the map earns its space but does not
            take the first list rows with it.

            Gated on `searched` as well as on the fix, and that pairing is the
            point: the ring is only honest while something can say what it is.
            When BOTH lookups fail the fix has already been stored but no scope
            ever was, so the map would draw an 800m ring off `ringM`'s default —
            a circle nothing was ever searched in — while ringLine(), guarded on
            the same missing scope, printed nothing to name it. An unlabelled
            ring reads as "everything in here was checked", which is the one
            claim this screen must never make by accident. No scope, no map: the
            failure line above already says the lookup died, and the register
            browser below is the way out. report/result.tsx runs the identical
            pair of lookups and takes the identical gate. */}
        {fix && searched && mapAvailable() && !searchBusyHiding ? (
          <View className="pt-3">
            <UnitMap
              center={{ lat: fix.lat, lng: fix.lng }}
              accuracyM={fix.accuracy}
              units={mapUnits}
              selected={unit?.pu_code}
              onSelect={(code) => {
                const u = nearby.find((x) => x.pu_code === code);
                if (u) setUnit(u);
              }}
              radiusM={ringM}
              height={264}
            />
            {/* An unlabelled ring is read as "everything in here was checked",
                and that is false: the units this screen most needs to reach are
                found by a lookup that searched only the narrower radius it
                reports for itself. The ring is therefore named, at whatever
                radius came back, rather than merely drawn. */}
            {searched && ringLine(searched) ? (
              <Text className="pt-2 text-xs leading-4 text-muted">{ringLine(searched)}</Text>
            ) : null}
            {/* The amber dot's four-line explanation used to sit here. Removed:
                this screen already says it three shorter ways — the legend
                names "Approximate area only", each row carries its own tier
                badge, and the ring line above states the radius. A paragraph
                restating all of it pushed the unit list and the record-fix
                button further down a screen whose whole job is to get someone
                standing at a unit to tap one button. */}
          </View>
        ) : null}

        {nearby.length && !searchBusyHiding ? (
          <View className="pt-3">
            {nearby.map((u) => (
              <UnitRow key={u.pu_code} u={u} />
            ))}
          </View>
        ) : null}

        {/* Search by name/code, above the cascade — knowing the unit's name but
            not its ward is the case the cascade cannot serve. While it (or the
            register drill) is in use, the map and the nearby list above give
            way: typing means "my unit is NOT in what you showed me", so keeping
            them pushes the observer's actual task off-screen. Clearing the
            search (or closing the drill) brings them straight back. */}
        <UnitSearch<Unit> onSelect={(u) => setUnit(u)} onEngaged={setSearchTyping} selectedCode={unit?.pu_code} />
        <Pressable
          onPress={() => setBrowse((b) => !b)}
          className="mt-4 flex-row items-center rounded-2xl bg-hawk-green px-4 py-3.5 active:opacity-80"
        >
          <Feather name={browse ? 'chevron-down' : 'chevron-right'} size={16} color={BRAND.gold} />
          <Text className="flex-1 pl-2 text-base font-bold text-hawk-gold">
            Browse the register instead
          </Text>
          <Text className="text-xs text-emerald-100">state › LGA › ward</Text>
        </Pressable>

        {browse ? (
          <View className="pt-3">
            {!stateSel ? (
              <>
                <Prompt>Select the state</Prompt>
                <View className="flex-row flex-wrap">
                  {states.map((s) => (
                    <Chip key={s} label={s} onPress={() => setStateSel(s)} />
                  ))}
                </View>
              </>
            ) : null}

            {stateSel && !lgaSel ? (
              <>
                <Crumb label={stateSel} onPress={() => setStateSel(null)} />
                <Prompt>Select the LGA</Prompt>
                <View className="flex-row flex-wrap">
                  {lgas.map((l) => (
                    <Chip key={l} label={l} onPress={() => setLgaSel(l)} />
                  ))}
                </View>
              </>
            ) : null}

            {lgaSel && !wardSel ? (
              <>
                <Crumb label={lgaSel} onPress={() => setLgaSel(null)} />
                <Prompt>Select the ward</Prompt>
                <View className="flex-row flex-wrap">
                  {wards.map((w) => (
                    <Chip key={w} label={w} onPress={() => setWardSel(w)} />
                  ))}
                </View>
              </>
            ) : null}

            {wardSel ? (
              <>
                <Crumb label={`${lgaSel} · ${wardSel}`} onPress={() => setWardSel(null)} />
                <Prompt>Select the unit you are standing at</Prompt>
                {units.map((u) => (
                  <UnitRow key={u.pu_code} u={u} />
                ))}
                {units.length === 0 ? (
                  <Text className="pt-2 text-sm text-muted">
                    No units in the register for this ward yet.
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}
      </Animated.ScrollView>

      {unit ? (
        <View
          className="border-t border-line bg-surface px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          {/* An unlocated unit is known only as an area — one the map outlines
              when it is small enough to fit and leaves to these words when it is
              not. Naming its size here is what makes the CTA below read as
              "collapse this to where I am standing" rather than a generic
              submit, and it is the only statement of the number for the large
              majority of envelopes, which the map does not draw. */}
          <Text className="pb-2 text-xs leading-4 text-muted">
            Selected: <Text className="font-semibold text-ink">{unit.name}</Text>
            {envelopeM
              ? ` — its position is known only to within ${envelopeM.toLocaleString()}m. Your fix replaces that whole area with a point.`
              : selUnlocated
                ? ' — it has no recorded position at all, which is why it has no pin on the map. Your fix is what puts it there.'
                : ' — record a fix here to confirm it.'}
          </Text>

          {/* The star commits server-side state of its own, so it belongs in the
              footer with the CTA rather than somewhere up the unit list. */}
          <Pressable
            disabled={saving}
            onPress={toggleSaved}
            className="mb-2 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-70"
          >
            {saving ? (
              <ActivityIndicator color={BRAND.leaf} />
            ) : (
              <Feather name="star" size={18} color={isSaved ? BRAND.gold : BRAND.leaf} />
            )}
            <View className="flex-1 pl-2">
              <Text className="text-sm font-bold text-hawk-leaf">
                {isSaved ? 'Saved as your polling unit — tap to remove' : 'Save as my polling unit'}
              </Text>
              <Text className="text-xs text-muted">
                {isSaved
                  ? 'You are alerted for every result report and approved incident here.'
                  : saved
                    ? `Alerts you to every result and approved incident here — replaces ${saved.name ?? saved.pu_code}.`
                    : 'Alerts you to every result report and approved incident at this unit.'}
              </Text>
            </View>
          </Pressable>

          <Pressable
            disabled={busy}
            onPress={onSubmit}
            className={`items-center rounded-2xl py-4 ${busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
          >
            {busy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <Text className="text-base font-bold text-hawk-gold">
                I am standing here — record fix
              </Text>
            )}
          </Pressable>

          {line ? (
            <Text className="pt-3 text-sm font-semibold text-warn-ink">{line}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
