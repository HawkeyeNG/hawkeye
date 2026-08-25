import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

type GeoState = { name: string; key: string; path: string; cx: number; cy: number };
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
 * states_geo.json is 23 KB of pre-simplified SVG paths served from the same
 * origin as the API. Fetched, not bundled: the shapes are the website's, and a
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
  accessibilityLabel?: string;
};

/**
 * Choropleth of Nigeria's 36 states + the FCT — the native twin of the SVG map
 * app/political.html and app/results.html draw from the same file.
 *
 * Colour is the only channel: no party badges. The web draws a 22 px emblem at
 * each state's centroid, which at phone width scales to about 10 px — smaller
 * than the smallest legible mark. The legend and the tap-for-details panel do
 * that job instead.
 */
export function NigeriaMap({
  fills,
  onPress,
  selected,
  emptyFill,
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
        </Svg>
      )}
    </View>
  );
}
