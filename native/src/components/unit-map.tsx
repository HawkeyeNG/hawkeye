import { Feather } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import Svg, { Circle as SvgCircle, Path } from 'react-native-svg';

import type { MapStyleElement, Region } from 'react-native-maps';

import { BRAND } from '@/lib/api';
import { DISCOVERY_RADIUS_M } from '@/lib/location';
import { useUi } from '@/lib/theme';

/**
 * Native module, so it exists in a dev/production build and NOT in Expo Go —
 * probed exactly like the document scanner (lib/scan.ts). The probe has to be a
 * require rather than an import because the package resolves its native views
 * at module scope, which throws outright when the native side is absent; a
 * static import would take the whole screen down with it.
 *
 * The `import type` above is erased at compile time, so it costs nothing here.
 */
type MapsModule = typeof import('react-native-maps');
type MapHandle = InstanceType<MapsModule['default']>;

function loadMaps(): MapsModule | null {
  // react-native-web has no Google Maps view; the caller's list is the whole
  // experience there, and a thrown require would take it down with the map.
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-maps') as Partial<MapsModule> | undefined;
    return mod?.default && mod.Marker && mod.Circle ? (mod as MapsModule) : null;
  } catch {
    return null;
  }
}

const RNMaps = loadMaps();

/** True in a dev/production build, false in Expo Go. Callers may use it to
 *  decide whether the map is worth reserving space for at all. */
export const mapAvailable = () => RNMaps != null;

/**
 * Google's Android SDK does not fail loudly on a missing or wrong key — it
 * renders a blank grey grid and writes the real reason to logcat, which nobody
 * holding a phone in a polling unit will ever read. app.config.js injects the
 * key into `android.config.googleMaps.apiKey`, and expo-constants hands the
 * resolved config back at runtime, so an absent key is detectable here and can
 * be said out loud instead of shown as a grey void.
 *
 * Only ABSENCE is detectable. A key that exists but is restricted to the wrong
 * package or signing SHA-1 still renders grey, and nothing in the JS layer is
 * told about it — that one is caught by looking at the phone, not by code.
 *
 * Gated on `android.package` rather than on `expoConfig` merely being non-null,
 * and that is the important part: this check can only ever REMOVE a map, so a
 * false positive is worse than the grey void it is meant to prevent. Seeing the
 * package name proves the android section survived into the runtime manifest,
 * so a missing key underneath it is a real missing key rather than a config we
 * were never handed.
 */
const androidConfig = Constants.expoConfig?.android;
const KEY_MISSING =
  Platform.OS === 'android' &&
  androidConfig?.package != null &&
  !androidConfig.config?.googleMaps?.apiKey;

/**
 * Confidence in a unit's coordinates. These are the three states
 * /api/mapping/nearby reports.
 */
export type UnitTier = 'verified' | 'crowd' | 'approx';

/**
 * THE tier vocabulary — the map legend and the caller's list rows both read
 * from here, because a map that grades a unit differently from the row one line
 * under it is worse than no map. Worded to stand alone on a list row: callers
 * append their own detail (`— within ~400m`, `· 3 observer fix(es)`) after it.
 */
export const TIER_LABEL: Record<UnitTier, string> = {
  verified: 'Verified location',
  crowd: 'Crowd-confirmed location',
  approx: 'Approximate area only',
};

/**
 * THE tier palette — one set of three colours across the app and the website,
 * which has been teaching them since launch (app/map-unit.html). Exported so a
 * list row can carry the same coloured dot as the pin it refers to rather than
 * inventing its own symbol.
 *
 * Amber is not a warning here, it is a job: "this unit still needs mapping".
 * Red is deliberately absent — it reads as an error state, and none of these
 * three tiers is an error.
 */
export const TIER_COLOR: Record<UnitTier, string> = {
  verified: '#008751', // Nigeria green — official / field-verified coordinates
  crowd: '#1565c0', // blue — confirmed by clustered observer fixes
  approx: '#f9a825', // amber — approximate area only, still needs mapping
};

/**
 * How an envelope radius reads in a list row. Lives here, next to the palette,
 * because both screens describe the same envelope and had drifted: one used
 * toLocaleString and the other Math.round, so a 1200m envelope read "~1,200m"
 * on one screen and "~1200m" on the other for the same unit. Same fact, same
 * words — which is the invariant both files claim in their docblocks.
 *
 * This is also the ONLY channel for a large envelope now that the map skips
 * drawing anything bigger than the frame, so the wording carries real weight.
 */
export const envelopeText = (radiusM: number) =>
  ` — within ~${Math.round(radiusM).toLocaleString()}m`;

/**
 * Anything that is not an outright verified or crowd-confirmed fix is drawn as
 * an area. `geocoded` in particular looks precise in the register and is not —
 * it came from map data nobody stood at — so it is deliberately folded in with
 * `approx` rather than given a pin it has not earned.
 */
export function toTier(status?: string | null): UnitTier {
  return status === 'verified' || status === 'crowd' ? status : 'approx';
}

/**
 * The area a unit is known to sit somewhere inside — carrying its OWN centre.
 *
 * The centre belongs to the envelope rather than being inherited from the
 * unit's point, and that is the whole design. In the register the two are
 * DIFFERENT places: a unit's drawn point comes from `lat` or `crowd_lat` (a
 * position somebody actually stood at), while the envelope is a GRID3
 * ward-scale box centred on `approx_lat`/`approx_lng` — a median 2.5km from the
 * crowd point, 10km at p90, 145km at worst, with radii averaging 2.8km.
 *
 * The old shape took a bare `approxRadiusM`, so a caller could pair one
 * source's point with another source's radius by simply reading two columns off
 * the same row. Both callers did. Inside a map framed to ~1km that drew a solid
 * multi-kilometre amber disc over the entire viewport — every pin, the accuracy
 * halo and the search ring buried under it — asserting an area centred on a
 * point that was not the envelope's centre. A radius can no longer travel
 * without the point it belongs to.
 */
export type MapEnvelope = {
  lat: number;
  lng: number;
  /** Metres, about this envelope's own centre above. */
  radiusM: number;
};

/**
 * A unit as the map draws it: a POINT, optionally accompanied by an AREA that
 * knows where it is.
 *
 * There is deliberately no way to express "radius, centre unknown". A caller
 * holding only a crowd or verified fix omits `envelope` and no circle is drawn
 * — which is the honest outcome, because it has nothing to draw a circle from.
 */
export type MapUnit = {
  puCode: string;
  name: string;
  lat: number;
  lng: number;
  tier: UnitTier;
  /** Set ONLY from a real envelope row — centre and radius read together. */
  envelope?: MapEnvelope;
  /**
   * The retired centre-less radius, kept as `never` so passing one is a
   * compile error rather than a silent drop.
   *
   * Excess-property checking alone does not cover this. One caller builds its
   * units with `useMemo<MapUnit[]>(() => rows.map((n) => ({ … })))`, and object
   * literal freshness is discarded when it passes through `map`'s generic
   * inference — so simply deleting the field left that screen compiling clean
   * while its radii went nowhere. Typed `never`, `approxRadiusM: n.something`
   * fails on assignability instead, which survives inference.
   */
  approxRadiusM?: never;
};

export type UnitMapProps = {
  /** The observer's own position — the blue dot, and where recentre returns to. */
  center: { lat: number; lng: number };
  /** GPS accuracy in metres; drawn as the translucent halo around the dot. */
  accuracyM?: number;
  units: MapUnit[];
  /** `puCode` of the highlighted unit. */
  selected?: string;
  onSelect?: (puCode: string) => void;
  /** The circle the unit lookup actually searched. */
  radiusM?: number;
  /** Bounded on purpose — see the note on the component. */
  height?: number;
};

/**
 * A block, not a screen. Both callers put a unit list and a pinned CTA under
 * the map, and a full-bleed map would bury the very thing the observer came to
 * tap. Clamped rather than merely defaulted so a caller cannot accidentally
 * turn it back into a takeover.
 */
const MIN_H = 240;
const MAX_H = 340;
const DEFAULT_H = 288;

/** Metres per degree of latitude — near enough constant anywhere on the globe. */
const M_PER_DEG_LAT = 111_320;

/** How far past the searched radius the camera is framed, so the ring is not
 *  flush against the glass. Half the visible extent is therefore
 *  `frameM * FRAME_FACTOR` metres — the number the envelope rule is measured in. */
const FRAME_FACTOR = 1.25;

/**
 * ENVELOPE RULE — how much of an area is worth drawing, in multiples of the
 * searched radius (`frameM` below).
 *
 * An envelope is only information while the observer can see where it ENDS. One
 * that reaches past every edge of the viewport is not "a big circle", it is a
 * full-bleed amber wash: it says nothing the list row's "— within ~2,800m"
 * does not say in words, and it costs the observer every pin, the accuracy halo
 * and the search ring underneath it. Real radii average 2.8km against an 800m
 * search, so this is the common case, not the edge case.
 *
 * Hence two thresholds rather than one, both scaled to the search so a caller
 * that searches wider gets proportionally more:
 *
 *  - up to 1x the searched radius: a bounded area sitting inside the ring, and
 *    small enough that a fill still reads as one shape among several. Filled.
 *  - up to FRAME_FACTOR: its edge can still fall on screen, but a fill this
 *    size would tint everything under it. Outline only — de-emphasised, no fill,
 *    so it can be seen without being able to swamp anything.
 *  - beyond: not drawn at all. There is no honest way to render an area whose
 *    boundary is nowhere on the map; the caller's own copy carries the number.
 */
const ENVELOPE_FILL_MAX = 1;
const ENVELOPE_DRAW_MAX = FRAME_FACTOR;

/** How the map died. Kept apart because the two need different words, and
 *  because a timeout that fires behind an already-crashed map would otherwise
 *  silently rewrite the message the observer is reading. */
type MapFailure = 'timeout' | 'crash';

/** Mount attempts before the map is declared unavailable on this device — i.e.
 *  one Retry. See `exhausted` in the component for why it is not more. */
const MAX_ATTEMPTS = 2;

/**
 * Google's own cartography, minus the parts that fight the overlay. POI and
 * transit labels are the noisiest layer on an Android basemap and none of them
 * is the thing being chosen — a restaurant pin next to a polling-unit pin is a
 * genuine misread risk, not just clutter.
 *
 * Only the Google provider honours these, so they are Android-only in practice;
 * Apple Maps ignores customMapStyle and is left as it comes.
 */
const LIGHT_STYLE: MapStyleElement[] = [
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

/** The dark counterpart. Google has no "dark" toggle — a night basemap is a
 *  style or it is nothing, so the geometry/label pairs are spelled out. */
const DARK_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#12211b' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ea79a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0d1a15' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#33493f' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#16281f' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22362d' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#7d968a' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2f4a3d' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a1712' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4d6a5c' }] },
];

/**
 * Map chrome — everything that is NOT a tier. Kept apart from TIER_COLOR on
 * purpose: the three tier colours mean a unit's mapping status and nothing
 * else, so no ring, halo or selection accent is allowed to borrow one.
 */
function chrome(dark: boolean) {
  return {
    /** Outline that lifts a marker off busy map detail. White in both themes:
     *  the light basemap is pale paper and the dark one is near-black, and a
     *  white keyline is the only edge that survives both. */
    ring: '#ffffff',
    /** The universal "you are here" blue. Close to crowd-blue by hue, kept
     *  apart by form instead: this is a haloed dot, crowd units are teardrop
     *  pins, and only this one carries a GPS accuracy circle. */
    me: '#1a73e8',
    /**
     * Selection accent. NOT BRAND.gold — the app's usual active colour is
     * within a few percent of the approx amber above, so a gold ring on an
     * amber dot would be an invisible selection. A near-black/near-white ring
     * collides with no tier by construction.
     */
    pick: dark ? '#e8f2ec' : '#10221a',
    /** The searched circle is chrome, not a tier: neutral so it cannot be read
     *  as a verdict about any unit inside it. */
    radius: dark ? '#8fa79a' : '#5c7166',
  };
}

/**
 * The pin body as one path: a circle of radius 10 about (12,12) joined to a tip
 * at (12,31) along both tangents, so head and tail are a single filled outline
 * with no seam down the shoulders. The viewBox is padded on all sides to leave
 * room for the selection ring without clipping it.
 */
const PIN_PATH = 'M3.5 17.26 A10 10 0 1 1 20.5 17.26 L12 31 Z';
const PIN_VB = { x: -4, y: -4, w: 32, h: 40 };
/** Where the tip sits inside the padded box, as a 0-1 fraction of each side —
 *  which is exactly what Google's marker `anchor` wants. */
const PIN_ANCHOR = {
  x: (12 - PIN_VB.x) / PIN_VB.w,
  y: (31 - PIN_VB.y) / PIN_VB.h,
};

type PinProps = { color: string; ring: string; pick: string | null; width: number };

function Pin({ color, ring, pick, width }: PinProps) {
  const scale = width / PIN_VB.w;
  return (
    <Svg
      width={width}
      height={PIN_VB.h * scale}
      viewBox={`${PIN_VB.x} ${PIN_VB.y} ${PIN_VB.w} ${PIN_VB.h}`}
    >
      {pick ? (
        <SvgCircle cx={12} cy={12} r={13.2} stroke={pick} strokeWidth={2.4} fill="none" />
      ) : null}
      <Path
        d={PIN_PATH}
        fill={color}
        stroke={ring}
        strokeWidth={pick ? 2.4 : 1.8}
        strokeLinejoin="round"
      />
      <SvgCircle cx={12} cy={12} r={4} fill={ring} />
    </Svg>
  );
}

/** An approx unit gets a dot, never a pin: a pin claims a point, and the whole
 *  argument of this map is that an approx unit is a region. */
function Dot({ color, ring, pick, width }: PinProps) {
  return (
    <Svg width={width} height={width} viewBox="0 0 32 32">
      {pick ? (
        <SvgCircle cx={16} cy={16} r={11.5} stroke={pick} strokeWidth={2.4} fill="none" />
      ) : null}
      <SvgCircle cx={16} cy={16} r={7} fill={color} stroke={ring} strokeWidth={2.2} />
    </Svg>
  );
}

function MeDot({ color, ring }: { color: string; ring: string }) {
  return (
    <Svg width={26} height={26} viewBox="0 0 26 26">
      <SvgCircle cx={13} cy={13} r={12} fill={color} opacity={0.18} />
      <SvgCircle cx={13} cy={13} r={6.5} fill={color} stroke={ring} strokeWidth={3} />
    </Svg>
  );
}

/**
 * A thrown render inside the native map must cost the observer the map and
 * nothing else — the unit list under it is the part that actually has to work.
 *
 * Mounted with `key={attempt}` by the caller below. A boundary latches `dead`
 * forever once it has caught, so without a changing key Retry would rebuild the
 * map inside a boundary that is still refusing to render it — the failure mode
 * that made the previous Retry button decorative.
 *
 * `onCrash` exists so a crash and a load timeout end up in ONE failure state
 * upstream. Without it the owner never learned the map had died, its 15s timer
 * kept running behind the fallback, and the observer watched the message change
 * under them from "the map engine stopped" to "the map could not be loaded" —
 * two different diagnoses of one event — while the attempt counter that decides
 * whether Retry is even offered never moved.
 */
class MapBoundary extends Component<
  { onCrash: () => void; fallback: ReactNode; children: ReactNode },
  { dead: boolean }
> {
  state = { dead: false };

  static getDerivedStateFromError() {
    return { dead: true };
  }

  componentDidCatch() {
    // Commit phase, so setState upstream is legal here; getDerivedStateFromError
    // above is render phase and is not the place for it.
    this.props.onCrash();
  }

  render() {
    return this.state.dead ? this.props.fallback : this.props.children;
  }
}

function Placeholder({
  height,
  note,
  onRetry,
}: {
  height: number;
  note: string;
  onRetry?: () => void;
}) {
  const ui = useUi();
  return (
    <View
      className="items-center justify-center rounded-2xl border border-line bg-card px-6"
      style={{ height }}
    >
      <Feather name="map" size={22} color={ui.faint} />
      <Text className="pt-2 text-sm font-semibold text-ink">Map Unavailable</Text>
      <Text className="pt-1 text-center text-xs text-muted">{note}</Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          className="mt-3 rounded-full bg-surface px-4 py-2 active:opacity-70"
        >
          <Text className="text-xs font-bold text-hawk-leaf">Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function LegendRow({ tier, ring }: { tier: UnitTier; ring: string }) {
  const area = tier === 'approx';
  return (
    <View className="flex-row items-center pt-1">
      {area ? (
        <Dot color={TIER_COLOR.approx} ring={ring} pick={null} width={14} />
      ) : (
        <Pin color={TIER_COLOR[tier]} ring={ring} pick={null} width={11} />
      )}
      <Text className="pl-1.5 text-[10px] leading-3 text-ink">{TIER_LABEL[tier]}</Text>
    </View>
  );
}

/**
 * One unit's marker.
 *
 * `tracksViewChanges` is the whole reason this is its own component. A marker
 * with React children is rasterised to a bitmap by the Android SDK; leaving
 * tracking on burns a redraw every frame for every pin, and turning it off
 * before the child has laid out ships a blank marker. So it stays on for the
 * first moments after mount, then off once the artwork has certainly been
 * captured.
 *
 * Changing the artwork therefore means MOUNTING AGAIN, which is why the caller
 * keys this on the selected state and the theme rather than letting the props
 * change under a marker that has stopped tracking — a marker whose bitmap was
 * frozen while it was small and unselected would keep drawing that bitmap
 * however loudly the props said it was now the chosen one.
 */
function UnitMarker({
  Marker,
  unit,
  on,
  ring,
  pick,
  onPress,
}: {
  Marker: MapsModule['Marker'];
  unit: MapUnit;
  on: boolean;
  ring: string;
  pick: string;
  onPress?: () => void;
}) {
  const [track, setTrack] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setTrack(false), 600);
    return () => clearTimeout(t);
  }, []);

  const area = unit.tier === 'approx';
  const w = area ? (on ? 30 : 24) : on ? 36 : 27;
  const accent = on ? pick : null;

  return (
    <Marker
      identifier={unit.puCode}
      coordinate={{ latitude: unit.lat, longitude: unit.lng }}
      // A pin points at its coordinate with its TIP, so it is anchored there
      // rather than at the centre of its box. `anchor` is what Google reads,
      // `centerOffset` is the same correction expressed the way Apple Maps
      // wants it; each platform ignores the other.
      anchor={area ? { x: 0.5, y: 0.5 } : PIN_ANCHOR}
      centerOffset={area ? { x: 0, y: 0 } : { x: 0, y: -(PIN_ANCHOR.y - 0.5) * w * (PIN_VB.h / PIN_VB.w) }}
      tracksViewChanges={track}
      // Selected pins last, so a highlighted unit is never buried under the
      // neighbour it is being distinguished from.
      zIndex={on ? 2 : 1}
      onPress={onPress}
    >
      <View accessibilityRole="button" accessibilityLabel={`${unit.name}, ${TIER_LABEL[unit.tier]}`}>
        {area ? (
          <Dot color={TIER_COLOR.approx} ring={ring} pick={accent} width={w} />
        ) : (
          <Pin color={TIER_COLOR[unit.tier]} ring={ring} pick={accent} width={w} />
        )}
      </View>
    </Marker>
  );
}

/**
 * The map behind polling-unit discovery.
 *
 * It exists to answer one question the list cannot: *where* is the unit
 * relative to where the observer is standing. The search radius is drawn as a
 * ring so "nothing near me" reads as a claim about a specific circle rather
 * than a shrug, and an approx unit whose envelope is small enough to be seen
 * whole is drawn as that envelope — an observer who can see that a unit is
 * known only to within 400m understands why walking there and recording a fix
 * is worth doing. An envelope too big to have a visible edge is not drawn at
 * all; see the ENVELOPE RULE above.
 *
 * Selection is owned by the caller: tapping a marker reports upward and the map
 * highlights whatever comes back, so a tap on the map and a tap on a list row
 * land in exactly the same state.
 */
export function UnitMap({
  center,
  accuracyM,
  units,
  selected,
  onSelect,
  radiusM = DISCOVERY_RADIUS_M,
  height = DEFAULT_H,
}: UnitMapProps) {
  const ui = useUi();
  const map = useRef<MapHandle>(null);
  const [failed, setFailed] = useState<MapFailure | null>(null);
  const [ready, setReady] = useState(false);
  // Remount key AND attempt counter: a map that failed to come up is holding a
  // dead native view, so retrying means building a new one rather than nudging
  // this one — and how many times that has been tried decides whether trying
  // again is still an honest offer.
  const [attempt, setAttempt] = useState(0);

  // A device with no Google Play services mounts the map, never fires
  // onMapReady, and will do exactly that again on every rebuild. One retry
  // covers the genuinely transient causes (a cold tile fetch on a weak
  // connection); past that, Retry is a button that cannot work, and offering it
  // lets an observer loop on identical copy instead of using the list.
  const exhausted = attempt + 1 >= MAX_ATTEMPTS;

  const h = Math.min(MAX_H, Math.max(MIN_H, height));
  const c = chrome(ui.dark);
  // Read the two numbers out once. Memoising on `center` itself would recompute
  // on every render, since callers hand us a fresh object literal.
  const lat = center?.lat;
  const lng = center?.lng;
  const valid = Number.isFinite(lat) && Number.isFinite(lng);

  const drawn = useMemo(
    () => units.filter((u) => Number.isFinite(u.lat) && Number.isFinite(u.lng)),
    [units],
  );

  /**
   * The searched radius as the map actually treats it, floored so a caller
   * passing 0 cannot collapse the frame. Both the camera and the envelope rule
   * read this one number, so the area on screen and the area an envelope is
   * judged against can never drift apart.
   */
  const frameM = Math.max(radiusM, 150);

  /**
   * Which envelopes get drawn, and how — the ENVELOPE RULE, applied.
   *
   * Each circle is centred on its OWN `envelope.lat/lng`, never on the unit's
   * point: the two are different places in the register, and drawing an area
   * around the wrong one is the bug this whole shape exists to prevent.
   *
   * Gated on `approx` as well. Amber means "approximate area only", so an amber
   * ring around a crowd-confirmed pin would contradict the pin it surrounds —
   * and ~109k units carry a GRID3 envelope alongside a crowd position they have
   * already outgrown.
   */
  const envelopes = useMemo(() => {
    const fillMax = frameM * ENVELOPE_FILL_MAX;
    const drawMax = frameM * ENVELOPE_DRAW_MAX;
    return drawn.flatMap((u) => {
      const e = u.envelope;
      if (!e || u.tier !== 'approx') return [];
      if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng)) return [];
      if (!(e.radiusM > 0) || e.radiusM > drawMax) return [];
      return [{ puCode: u.puCode, lat: e.lat, lng: e.lng, radiusM: e.radiusM, filled: e.radiusM <= fillMax }];
    });
  }, [drawn, frameM]);

  /** Frame the search circle, not the markers: the ring is the claim being made. */
  const region = useMemo<Region | null>(() => {
    if (!valid) return null;
    const span = frameM * FRAME_FACTOR;
    const dLat = span / M_PER_DEG_LAT;
    const dLng = span / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    return {
      latitude: lat,
      longitude: lng,
      latitudeDelta: dLat * 2,
      longitudeDelta: dLng * 2,
    };
  }, [valid, lat, lng, frameM]);

  /** Whether a map is actually on screen — anything else has nothing to time out. */
  const live = RNMaps != null && !KEY_MISSING && valid;

  // A map that never comes up looks identical to one that is merely slow, and
  // on a weak connection that is a blank box with no way out of it. Gated on
  // `live` so that waiting on a slow GPS fix is never reported as a dead map.
  useEffect(() => {
    if (!live || ready || failed) return;
    const t = setTimeout(() => setFailed('timeout'), 15_000);
    return () => clearTimeout(t);
  }, [live, ready, failed, attempt]);

  // Selecting from the list has to move the map, or the highlight lands
  // off-screen and the two halves of the screen stop agreeing with each other.
  // animateCamera rather than animateToRegion: it re-centres at whatever zoom
  // the observer has already pinched to instead of overruling them.
  useEffect(() => {
    if (!selected || !ready) return;
    const u = drawn.find((x) => x.puCode === selected);
    if (u) {
      map.current?.animateCamera(
        { center: { latitude: u.lat, longitude: u.lng } },
        { duration: 450 },
      );
    }
  }, [selected, ready, drawn]);

  const retry = () => {
    setFailed(null);
    setReady(false);
    setAttempt((a) => a + 1);
  };

  // Every branch below returns a Placeholder ALONE. None of the map chrome —
  // the loading veil, the legend, the recentre button — may render beside a
  // failure message: a legend for pins that are not on screen, or a permanent
  // "Loading map…" sitting on top of an error, is worse than the error alone.
  if (!RNMaps) {
    return (
      <Placeholder
        height={h}
        note="Maps need the full app — this build does not include the map engine. The list below works normally."
      />
    );
  }
  if (KEY_MISSING) {
    return (
      <Placeholder
        height={h}
        note="This build has no Google Maps key, so the map would come up blank. The list below is unaffected."
      />
    );
  }
  if (!valid || !region) {
    return <Placeholder height={h} note="No location fix yet, so there is nothing to centre on." />;
  }
  // One failure branch for both causes, and the LAST one offers no action.
  // Worded without naming Google Play services: this component also runs on
  // Apple Maps, and a diagnosis that is only sometimes true reads as noise to
  // everyone it is wrong for. What is always true is the second sentence.
  if (failed) {
    return (
      <Placeholder
        height={h}
        note={
          exhausted
            ? 'The map cannot be displayed on this device. The unit list below has everything you need and does not depend on it.'
            : failed === 'crash'
              ? 'The map engine stopped. The list below still works.'
              : 'The map could not be loaded. The unit list below is unaffected.'
        }
        onRetry={exhausted ? undefined : retry}
      />
    );
  }

  const { default: MapView, Marker, Circle, PROVIDER_GOOGLE } = RNMaps;

  // Google on Android, where app.config.js supplies the key. On iOS the Google
  // provider needs its own SDK key and pod, neither of which this app ships —
  // asking for it there buys a guaranteed blank map, where the platform default
  // (Apple Maps) needs no key and draws the same circles and markers.
  const provider = Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined;

  return (
    <MapBoundary
      // Keyed on the attempt so Retry builds a NEW boundary: `dead` latches for
      // the life of an instance, so reusing one would re-render the fallback
      // over a perfectly good map.
      key={attempt}
      onCrash={() => setFailed('crash')}
      // Held for the single commit between the catch and `onCrash` re-rendering
      // this component into the failure branch above, which owns the copy and
      // the Retry decision. No action here — offering one for that one frame
      // would be a button that races its own replacement.
      fallback={<Placeholder height={h} note="The map engine stopped. The list below still works." />}
    >
      <View className="overflow-hidden rounded-2xl border border-line bg-card" style={{ height: h }}>
        <MapView
          ref={map}
          provider={provider}
          style={{ flex: 1 }}
          initialRegion={region}
          customMapStyle={ui.dark ? DARK_STYLE : LIGHT_STYLE}
          // scrollEnabled must stay on for more than panning: Android's
          // MapView.dispatchTouchEvent only calls requestDisallowInterceptTouchEvent
          // while scroll gestures are enabled, and that call is the entire
          // reason a drag on the map is not stolen by the parent ScrollView.
          scrollEnabled
          zoomEnabled
          // Off because inside a 288px block they are almost always an accident,
          // and a tilted reference map is harder to read than a flat one.
          rotateEnabled={false}
          pitchEnabled={false}
          // Google's default is to re-centre on a tapped marker. Selection is
          // the caller's to own here, and the effect above already moves the
          // camera — leaving this on gives every tap two competing animations.
          moveOnMarkerPress={false}
          // Chrome we draw ourselves, or that has nothing to do with this task:
          // the toolbar's "open in Google Maps" button in particular would walk
          // an observer straight out of the app mid-report.
          toolbarEnabled={false}
          zoomControlEnabled={false}
          showsCompass={false}
          showsMyLocationButton={false}
          showsIndoors={false}
          poiClickEnabled={false}
          minZoomLevel={9}
          maxZoomLevel={19}
          loadingBackgroundColor={ui.dark ? '#12211b' : '#f2f5f3'}
          onMapReady={() => setReady(true)}
        >
          {/* Radius in METRES, so the circle stays the right size on the ground
              at every zoom rather than the right size on the glass. Guarded
              because a caller passing 0 (or worse, a negative) would hand the
              native SDK a degenerate circle to draw. */}
          {radiusM > 0 ? (
            <Circle
              center={{ latitude: lat, longitude: lng }}
              radius={radiusM}
              strokeColor={c.radius}
              strokeWidth={1.5}
              // Barely there on purpose: enough tint to read the searched area
              // as an area, not enough to tint the units sitting inside it.
              fillColor={`${c.radius}0f`}
              zIndex={0}
            />
          ) : null}

          {accuracyM && accuracyM > 0 ? (
            <Circle
              center={{ latitude: lat, longitude: lng }}
              radius={accuracyM}
              strokeColor={`${c.me}55`}
              strokeWidth={1}
              fillColor={`${c.me}1f`}
              zIndex={1}
            />
          ) : null}

          {/* Drawn under the markers: an envelope is context for the dot sitting
              in it, not a thing to be tapped in its own right. Selection shows
              as a heavier stroke rather than another colour — the amber IS the
              tier, and changing it would change the claim.

              Centre is `e.lat/e.lng`, the envelope's own. `filled` is the
              ENVELOPE RULE: past the searched radius the fill is dropped
              entirely and only the outline remains, so an envelope can be read
              without being able to tint the map it sits on. */}
          {envelopes.map((e) => {
            const on = e.puCode === selected;
            return (
              <Circle
                key={`env-${e.puCode}`}
                center={{ latitude: e.lat, longitude: e.lng }}
                radius={e.radiusM}
                strokeColor={`${TIER_COLOR.approx}${on ? 'ee' : 'b3'}`}
                strokeWidth={on ? 2.5 : 1}
                fillColor={
                  e.filled ? `${TIER_COLOR.approx}${on ? '47' : '21'}` : 'transparent'
                }
                zIndex={2}
              />
            );
          })}

          {drawn.map((u) => (
            <UnitMarker
              // Keyed on what the pin LOOKS like, not just which unit it is —
              // see the note on UnitMarker: its bitmap is frozen after mount,
              // so a change of artwork has to be a change of marker.
              key={`${u.puCode}:${u.puCode === selected}:${ui.dark}`}
              Marker={Marker}
              unit={u}
              on={u.puCode === selected}
              ring={c.ring}
              pick={c.pick}
              onPress={onSelect ? () => onSelect(u.puCode) : undefined}
            />
          ))}

          <Marker
            identifier="hk-me"
            coordinate={{ latitude: lat, longitude: lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
            zIndex={3}
          >
            <View accessibilityLabel="Your location">
              <MeDot color={c.me} ring={c.ring} />
            </View>
          </Marker>
        </MapView>

        {/* Controls are inset from the block's own edges rather than from the
            window's: this map is a card inside a screen that already sits in a
            SafeAreaView, so re-applying the device insets here would push them
            into the middle of a 288px box. */}
        <Pressable
          onPress={() => map.current?.animateToRegion(region, 450)}
          hitSlop={8}
          accessibilityLabel="Recentre the map on my location"
          className="absolute right-2.5 top-2.5 h-9 w-9 items-center justify-center rounded-full border border-line bg-card active:opacity-70"
        >
          <Feather name="crosshair" size={16} color={BRAND.leaf} />
        </Pressable>

        <View className="absolute bottom-2.5 left-2.5 rounded-xl border border-line bg-card/90 px-2 py-1.5">
          <LegendRow tier="verified" ring={c.ring} />
          <LegendRow tier="crowd" ring={c.ring} />
          <LegendRow tier="approx" ring={c.ring} />
        </View>

        {!ready ? (
          <View className="absolute inset-0 items-center justify-center bg-card/70">
            <Text className="text-xs font-semibold text-muted">Loading map…</Text>
          </View>
        ) : null}
      </View>
    </MapBoundary>
  );
}
