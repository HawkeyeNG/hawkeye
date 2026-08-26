import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Svg, { G, Image as SvgImage, Path, Rect } from 'react-native-svg';

import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

type GeoState = {
  name: string;
  key: string;
  path: string;
  cx: number;
  cy: number;
  /**
   * Where a badge goes, and how much room there is for it — the pole of
   * inaccessibility and its radius, in viewBox units, computed by
   * backend/scripts/build_states_from_wards.js.
   *
   * Optional because a client may still be holding a cached copy of the older
   * file, which had neither. Everything below degrades to "no badges" then,
   * rather than stacking every emblem in the top-left corner.
   */
  lx?: number;
  ly?: number;
  lr?: number;
};
type Geo = { viewBox: string; states: GeoState[] };

/**
 * The same key normalisation app/political.html and app/results.html use, so a
 * caller can hand us "Osun", "osun", "Akwa  Ibom", "FCT", "Abuja" or "Federal
 * Capital Territory" and still hit the right shape. The register, the political
 * data file and the geo file each spell states slightly differently.
 */
export function normState(s: string) {
  const n = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
}

/**
 * states_geo.json is ~118 KB of SVG paths served from the same origin as the
 * API — dissolved from ward polygons through one topology, so neighbouring
 * borders are the SAME arc and the map has no slivers between states
 * (backend/scripts/build_states_from_wards.js). It was 23 KB of per-state
 * ArcGIS output at 47.8% shared vertices, which is what put visible tears
 * through every block of same-coloured states. Fetched, not bundled: the shapes are the website's, and a
 * copy in the app binary would be one more thing to keep in sync. Memoised for
 * the run — three screens can want it and it never changes mid-session. A
 * failed fetch clears the cache so the next mount retries instead of replaying
 * the same rejection for the rest of the app's life.
 */
let cache: Promise<Geo> | null = null;

export function loadStatesGeo(): Promise<Geo> {
  if (!cache) {
    cache = fetch(`${BASE}/states_geo.json`, { headers: { accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`states_geo.json → HTTP ${r.status}`);
        const g = (await r.json()) as Geo;
        if (!g?.states?.length) throw new Error('states_geo.json → no state shapes in payload');
        return g;
      })
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

/** Shape of the box before we know it — keeps the placeholder from jumping. */
const FALLBACK_ASPECT = 800 / 660;

/**
 * Unfilled land: a state the caller had nothing to say about — the light-theme
 * value, exported so a legend can show the grey the map painted.
 *
 * Prefer `useUi().noData`, which is this colour on the light theme and a dark
 * one on the dark theme; a module constant cannot follow the OS. A legend still
 * hardcoding this will show a pale swatch beside a dark map.
 */
export const NO_DATA_FILL = '#e9eeea';

export type NigeriaMapProps = {
  /** state name → fill colour. Keys are normalised, so any spelling works. */
  fills: Record<string, string>;
  /** Receives the geo file's own name for the tapped state (e.g. "Akwa Ibom"). */
  onPress?: (state: string) => void;
  /** Outlined and drawn last so neighbours can't clip the highlight. */
  selected?: string | null;
  /** Fill for states absent from `fills`. Defaults to the theme's `noData`. */
  emptyFill?: string;
  /**
   * state name → party code, for the emblem drawn inside each state. Keys are
   * normalised like `fills`, so any spelling works. Omit for a plain choropleth.
   */
  badges?: Record<string, string>;
  /** party code → emblem url, the same manifest the rest of the app uses. */
  logos?: Record<string, string>;
  accessibilityLabel?: string;
};

/**
 * BADGE SIZING — every emblem is as large as its own state can hold.
 *
 * The web draws all 37 at one constant size (viewBox/80 ≈ 20 units wide), which
 * is fine on a desktop map and was the reason this component carried no badges
 * at all: at phone width that constant lands at about 9 px, smaller than the
 * smallest legible mark, and on the tight south-eastern states it overhangs the
 * borders anyway.
 *
 * So the size comes from `lr`, the radius of the largest circle that fits inside
 * the state. A badge never exceeds the room measured for it, and it never grows
 * past MAX — a 60-unit emblem on Borno would read as a sticker on the map rather
 * than a label of it.
 *
 * Below MIN_ROOM there is no size that is both legible and inside the state, so
 * nothing is drawn. That is three states — Lagos, Abia, Anambra — where the
 * colour, the legend and the tap-for-details panel carry it instead. Drawing a
 * mark that spills across two borders would say something false about a map
 * whose whole subject is which state holds what.
 */
const BADGE_MIN_ROOM = 15;
const BADGE_MAX_HALF_W = 22;
const BADGE_ASPECT = 0.72; // emblems are wider than tall

/**
 * Choropleth of Nigeria's 36 states + the FCT — the native twin of the SVG map
 * app/political.html and app/results.html draw from the same file.
 *
 * Colour AND emblem, when `badges` and `logos` are given. This used to say
 * colour was the only channel, because the web's constant-size badge is about
 * 9 px at phone width and the runtime placement it depends on (map-label.js,
 * which needs getBBox / getTotalLength / isPointInFill) does not exist in
 * react-native-svg. Both objections are answered now: the builder ships a label
 * point and the room around it per state, so each emblem is placed properly and
 * sized to the state that holds it. See BADGE_MIN_ROOM above.
 */
export function NigeriaMap({
  fills,
  onPress,
  selected,
  emptyFill,
  badges,
  logos,
  accessibilityLabel = 'Map of Nigeria by state',
}: NigeriaMapProps) {
  const ui = useUi();
  const empty = emptyFill ?? ui.noData;
  const [geo, setGeo] = useState<Geo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let alive = true;
    loadStatesGeo()
      .then((g) => alive && setGeo(g))
      .catch((e) => alive && setErr(humanError(e, 'Could not load the map.')));
    return () => {
      alive = false;
    };
  }, []);

  // viewBox is "minX minY width height". Trusting it blindly would silently
  // render a blank box, so an unusable one is reported like any other failure.
  const box = useMemo(() => {
    if (!geo) return null;
    const n = String(geo.viewBox ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2] <= 0 || n[3] <= 0) return null;
    return { w: n[2], h: n[3] };
  }, [geo]);

  const byKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [state, colour] of Object.entries(fills)) {
      if (colour) m[normState(state)] = colour;
    }
    return m;
  }, [fills]);

  const selKey = selected ? normState(selected) : null;

  const badgeByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [state, party] of Object.entries(badges ?? {})) {
      if (party) m[normState(state)] = party;
    }
    return m;
  }, [badges]);

  /**
   * The emblems to draw, resolved once. Drawn AFTER every path, in their own
   * pass — SVG has no z-index, so a badge painted with its own state would be
   * partly covered by whichever neighbour is drawn next.
   */
  const marks = useMemo(() => {
    if (!geo || !logos || !Object.keys(badgeByKey).length) return [];
    return geo.states.flatMap((s) => {
      const party = badgeByKey[s.key];
      const href = party ? logos[party] : null;
      if (!href || s.lx == null || s.ly == null || !s.lr) return [];
      if (s.lr < BADGE_MIN_ROOM) return [];
      const halfW = Math.min(s.lr * 0.9, BADGE_MAX_HALF_W);
      const halfH = halfW * BADGE_ASPECT;
      return [{ key: s.key, href, x: s.lx - halfW, y: s.ly - halfH, w: halfW * 2, h: halfH * 2 }];
    });
  }, [geo, logos, badgeByKey]);

  // SVG has no z-index: a path drawn later covers the one before it, and
  // Nigeria's shapes share borders. Painting the selected state last is what
  // keeps its outline from being half-eaten by its neighbours.
  const ordered = useMemo(() => {
    if (!geo) return [];
    if (!selKey) return geo.states;
    return [...geo.states].sort((a, b) => Number(a.key === selKey) - Number(b.key === selKey));
  }, [geo, selKey]);

  if (err || (geo && !box)) {
    return (
      <View
        className="items-center justify-center rounded-2xl bg-card px-6 py-10"
        style={{ width: '100%' }}
      >
        <Text className="text-sm font-semibold text-warn-ink">Map Unavailable</Text>
        <Text className="pt-1 text-center text-xs text-muted">
          {err ?? `states_geo.json → unusable viewBox "${geo?.viewBox}"`}
        </Text>
      </View>
    );
  }

  const aspect = box ? box.w / box.h : FALLBACK_ASPECT;

  return (
    <View
      className="items-center justify-center overflow-hidden rounded-2xl bg-card"
      style={{ width: '100%', aspectRatio: aspect }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {!geo || !box || width <= 0 ? (
        <ActivityIndicator color={ui.tint.good.ink} />
      ) : (
        <Svg
          width={width}
          height={width / aspect}
          viewBox={geo.viewBox}
          accessibilityLabel={accessibilityLabel}
        >
          {ordered.map((s) => {
            const fill = byKey[s.key];
            const sel = s.key === selKey;
            return (
              <Path
                key={s.key}
                d={s.path}
                fill={fill ?? empty}
                fillOpacity={fill ? 0.9 : 1}
                stroke={sel ? ui.tint.good.ink : ui.mapLine}
                strokeWidth={sel ? 3 : 1}
                strokeLinejoin="round"
                onPress={onPress ? () => onPress(s.name) : undefined}
              />
            );
          })}
          {/* THE EMBLEMS, in their own pass over the top.
              A white plate under each one, exactly as results.html and
              political.html do it: party emblems are transparent PNGs drawn in
              their own colours, several of them dark, and on a saturated
              choropleth fill they would disappear into the state they label.
              pointerEvents none so the badge never eats the tap that belongs to
              the state under it. */}
          {marks.map((m) => (
            <G key={`b-${m.key}`} pointerEvents="none">
              <Rect
                x={m.x - 1}
                y={m.y - 1}
                width={m.w + 2}
                height={m.h + 2}
                rx={2.5}
                fill="#fff"
                stroke="rgba(0,0,0,.25)"
                strokeWidth={0.8}
              />
              <SvgImage
                href={{ uri: m.href }}
                x={m.x}
                y={m.y}
                width={m.w}
                height={m.h}
                preserveAspectRatio="xMidYMid meet"
              />
            </G>
          ))}
        </Svg>
      )}
    </View>
  );
}
