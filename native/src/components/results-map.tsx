import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { loadStatesGeo } from '@/components/nigeria-map';
import { useUi } from '@/lib/theme';

const BASE = 'https://hawkeye.com.ng';

/**
 * The region a contest divides into, exactly as GET /api/national/:contest
 * reports it in `level` (backend/src/routes/national.js:LEVEL).
 *
 * `lga` is the State Assembly's level NAME, but that route buckets SHA reports
 * by `polling_units.state` — the same column presidential and governorship
 * reports use. So an SHA tally is state-keyed data wearing an LGA label, and the
 * honest picture of it is state shapes. See `geoLevelOf`.
 */
export type MapLevel = 'state' | 'lga' | 'senatorial' | 'federal';

/** The geometry file a level is drawn from. `lga` deliberately borrows `state`. */
export type GeoLevel = 'state' | 'senatorial' | 'federal';

const LEVELS = new Set<MapLevel>(['state', 'lga', 'senatorial', 'federal']);

/**
 * `level` off the wire is a plain string, and an unknown one must not silently
 * become a state map — the caller has to be able to say "this is not a level I
 * can draw". Hence null rather than a default.
 */
export function asMapLevel(level: string | null | undefined): MapLevel | null {
  return LEVELS.has(level as MapLevel) ? (level as MapLevel) : null;
}

export const geoLevelOf = (level: MapLevel): GeoLevel => (level === 'lga' ? 'state' : level);

/** What one region of each level is called, for headings and sentences. */
export const LEVEL_WORD: Record<MapLevel, { one: string; many: string }> = {
  state: { one: 'state', many: 'states' },
  lga: { one: 'state', many: 'states' },
  senatorial: { one: 'senatorial district', many: 'senatorial districts' },
  federal: { one: 'federal constituency', many: 'federal constituencies' },
};

/**
 * How a region name is shown to a reader. The outline files are title-cased
 * machine keys, and one of them reads badly: states_geo.json calls the Federal
 * Capital Territory "Fct". Every other name in all three files is already a
 * place name, so this is a one-entry map rather than a re-casing pass that would
 * mangle "Kala-Balge" or "Ikot Ekpene/Essien Udim".
 */
const LABEL: Record<string, string> = { Fct: 'FCT (Abuja)' };
export const regionLabel = (name: string) => LABEL[name] ?? name;

const FCT = /fct|federal capital|abuja/;

/**
 * Comparison key for a region name. The register, the geo files and
 * lib/races.ts each punctuate and case these differently ("Akwa  Ibom",
 * "Kala-Balge", "Ikot Ekpene/Essien Udim/ Obot Akara F"), so nothing may be
 * compared raw.
 *
 * The FCT is folded onto one key at every level EXCEPT `federal`, and that
 * exception is the whole reason this is not just `normState`: the FCT is a
 * single state and a single senatorial district (the register and
 * district_geo.json both call it "Abuja"), but it is TWO federal
 * constituencies. The register spells one of them "Abuja Municipal/Bwari";
 * folding anything containing "abuja" to "fct" would make that name stand for
 * the whole territory, so the first FCT row to arrive would claim its sibling's
 * shape as well. Checked against all 358 mapped constituencies and all 355
 * register-side names: no pair of federal names actually collides either way,
 * so this exception costs nothing and removes the one way the territory could
 * have been painted from a single seat's votes.
 */
export function regionKey(level: MapLevel, name: string): string {
  const n = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (level === 'federal') return n;
  return FCT.test(n) ? 'fct' : n;
}

/**
 * Order-insensitive key for a compound region name. Federal constituencies are
 * named by the LGAs they merge, and the sources disagree on the order:
 * lib/races.ts has "Obingwa/Osisioma/Ugwunagbo" where the register (and so the
 * tally and the geo file) has "Obingwa/Ugwunagbo/Osisioma". Sorting the words
 * reconciles 65 of the 360 seats that exact comparison misses, and — checked
 * against all 358 mapped constituencies and all 109 districts — collides with
 * nothing, so a match through it is never a guess between two regions.
 */
const tokenKey = (name: string) =>
  String(name ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .sort()
    .join(' ');

/**
 * Same idea as `tokenKey`, one step blunter: each word clipped to its first four
 * letters, deduplicated and sorted. It exists because the register and the
 * boundary file disagree by a letter on names that are plainly the same seat —
 * "Nangere/Potiskum" vs "Nangere/Potiskm", "Calabar Municipal/Odukpani" vs
 * "Calabar Municipality/Odukpani", "Aniocha North/Aniocha South/Oshimili
 * North/Oshimili South" vs "…/Oshimili North & South". `tokenKey` cannot see
 * past a dropped letter or an ampersand; this can.
 *
 * Its safety was measured, not assumed. Across the 358 mapped constituencies
 * this key is unique except for {Burutu, Buruku} and {Kaura, Kauru} — and the
 * uniqueness requirement in `matchRegion` rejects exactly those, so a real
 * near-miss between two seats can never be resolved by guessing. Against the
 * 355 register-side names it recovers 10 constituencies that would otherwise go
 * uncoloured, every one of them a verified typo pair, and introduces no pairing
 * that the stricter tiers had already got right. It never runs at the state or
 * senatorial level: both match 100% exactly (109 of 109 districts), so this
 * tier is unreachable there.
 */
const stemKey = (name: string) =>
  [
    ...new Set(
      String(name ?? '')
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(Boolean)
        .map((w) => w.slice(0, 4)),
    ),
  ]
    .sort()
    .join(' ');

/**
 * Find `wanted` among `candidates`: exact key first, then a UNIQUE order-
 * insensitive match, then a UNIQUE stem match, then nothing. Uniqueness is
 * required at every loose tier rather than first-wins — a leaderboard would
 * rather show no region than the wrong one — and the tiers run strictest first,
 * so a name that matches exactly is never re-decided by a blunter rule.
 *
 * One matcher for every lookup on the results screen (the tally row the board
 * ranks, and the shape the map highlights) is what keeps the map and the table
 * from ever naming different regions for the same race.
 */
export function matchRegion<T>(
  level: MapLevel,
  wanted: string | null | undefined,
  candidates: readonly T[],
  nameOf: (c: T) => string,
): T | null {
  if (!wanted) return null;
  const key = regionKey(level, wanted);
  if (!key) return null;
  const exact = candidates.find((c) => regionKey(level, nameOf(c)) === key);
  if (exact) return exact;
  const only = <K,>(keyOf: (n: string) => K, want: K): T | null => {
    const hits = candidates.filter((c) => keyOf(nameOf(c)) === want);
    return hits.length === 1 ? hits[0] : null;
  };
  const tk = tokenKey(wanted);
  if (!tk) return null;
  return only(tokenKey, tk) ?? only(stemKey, stemKey(wanted));
}

export type MapShape = { name: string; key: string; path: string };
export type MapGeo = { viewBox: string; geoLevel: GeoLevel; shapes: MapShape[] };

/**
 * Merged region outlines, from the same files app/results.html draws:
 * states_geo.json (37), district_geo.json (109 senatorial districts) and
 * constituency_geo.json (358 of the 360 federal constituencies — two have no
 * mapped boundary, which the screen says out loud rather than quietly omitting).
 *
 * Fetched, not bundled, for the reason components/nigeria-map.tsx gives: these
 * are the website's shapes and a copy in the binary is one more thing to drift.
 * Memoised per level for the run; a failure clears its slot so the next mount
 * retries. The `state` level reuses nigeria-map's own cache, so a screen that
 * has already drawn the state map pays nothing to draw it again here.
 */
const FILES: Record<Exclude<GeoLevel, 'state'>, string> = {
  senatorial: 'district_geo.json',
  federal: 'constituency_geo.json',
};

/**
 * Districts whose neighbours' shapes overlap them, carried over verbatim from
 * app/results.html:231. SVG has no z-index: painting these last is what stops a
 * neighbour drawn afterwards from cutting into them.
 */
const FRONT = ['Ogun West', 'Kaduna South', 'Kebbi Central', 'Ondo Central'];

type RawRegions = { viewBox: string; regions: { name: string; path: string }[] };

const cache: Partial<Record<GeoLevel, Promise<MapGeo>>> = {};

export function loadMapGeo(level: MapLevel): Promise<MapGeo> {
  const geoLevel = geoLevelOf(level);
  const hit = cache[geoLevel];
  if (hit) return hit;

  const key = (name: string) => regionKey(geoLevel === 'federal' ? 'federal' : 'state', name);

  const load: Promise<MapGeo> =
    geoLevel === 'state'
      ? loadStatesGeo().then((g) => ({
          viewBox: g.viewBox,
          geoLevel,
          shapes: g.states.map((s) => ({ name: s.name, key: key(s.name), path: s.path })),
        }))
      : fetch(`${BASE}/${FILES[geoLevel]}`, { headers: { accept: 'application/json' } })
          .then(async (r) => {
            if (!r.ok) throw new Error(`${FILES[geoLevel]} → HTTP ${r.status}`);
            const raw = (await r.json()) as RawRegions;
            if (!raw?.regions?.length) throw new Error(`${FILES[geoLevel]} → no region shapes`);
            const ordered = [...raw.regions].sort(
              (a, b) => FRONT.indexOf(a.name) - FRONT.indexOf(b.name),
            );
            return {
              viewBox: raw.viewBox,
              geoLevel,
              shapes: ordered.map((r2) => ({ name: r2.name, key: key(r2.name), path: r2.path })),
            };
          });

  cache[geoLevel] = load.catch((e) => {
    delete cache[geoLevel];
    throw e;
  });
  return cache[geoLevel] as Promise<MapGeo>;
}

/** Shape of the box before the geometry lands — keeps the card from jumping. */
const FALLBACK_ASPECT = 800 / 660;

export type ResultsMapProps = {
  level: MapLevel;
  /** region name → fill colour. Keys are matched by `regionKey`, so any spelling works. */
  fills: Record<string, string>;
  /** Outlined and painted last, so neighbours cannot clip the highlight. */
  selected?: string | null;
  /** Receives the geo file's own name for the tapped region. */
  onPress?: (region: string) => void;
  /** Fill for regions absent from `fills`. Defaults to the theme's `noData`. */
  emptyFill?: string;
  accessibilityLabel?: string;
};

/**
 * Choropleth of one contest's regions — states, senatorial districts or federal
 * constituencies — the native twin of app/results.html's results map.
 *
 * Colour is the only channel, as in components/nigeria-map.tsx: the web paints
 * every reporting region the same pale green and identifies the leader with a
 * 22 px party emblem at the shape's centre, which at phone width comes out
 * around 10 px for a state and under 4 px for a constituency — illegible, and
 * 358 of them overplot into noise. Filling the shape with the leading party's
 * colour says the same thing at any size; the legend names the parties and the
 * tap-for-details panel carries the numbers.
 */
export const ResultsMap = memo(function ResultsMap({
  level,
  fills,
  selected,
  onPress,
  emptyFill,
  accessibilityLabel,
}: ResultsMapProps) {
  const ui = useUi();
  const empty = emptyFill ?? ui.noData;
  const [geo, setGeo] = useState<MapGeo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [width, setWidth] = useState(0);

  const geoLevel = geoLevelOf(level);

  useEffect(() => {
    let alive = true;
    // Drop geometry from a DIFFERENT level while the new file downloads — the old
    // shapes under the new level's colours would be a wrong map, not a stale one.
    // Switching between `state` and `lga` shares one geometry, so the updater
    // returns the same object and nothing re-renders.
    setGeo((g) => (g?.geoLevel === geoLevel ? g : null));
    setErr(null);
    loadMapGeo(level)
      .then((g) => alive && setGeo(g))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [level, geoLevel]);

  // viewBox is "minX minY width height". Trusting it blindly would render a
  // blank box, so an unusable one is reported like any other failure.
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
    for (const [region, colour] of Object.entries(fills)) {
      if (colour) m[regionKey(level, region)] = colour;
    }
    return m;
  }, [fills, level]);

  const selKey = useMemo(() => {
    if (!geo || !selected) return null;
    const hit = matchRegion(level, selected, geo.shapes, (s) => s.name);
    return hit ? hit.key : null;
  }, [geo, level, selected]);

  // Hairlines: a constituency is a few pixels wide on a phone, and a 1-unit
  // border on 358 of them eats the fill it is supposed to separate.
  const border = geoLevel === 'federal' ? 0.5 : geoLevel === 'senatorial' ? 0.8 : 1;

  const paths = useMemo(() => {
    if (!geo) return null;
    const ordered = selKey
      ? [...geo.shapes].sort((a, b) => Number(a.key === selKey) - Number(b.key === selKey))
      : geo.shapes;
    return ordered.map((s) => {
      const fill = byKey[s.key];
      const sel = s.key === selKey;
      return (
        <Path
          key={s.key}
          d={s.path}
          fill={fill ?? empty}
          fillRule="evenodd"
          fillOpacity={fill ? 0.92 : 1}
          stroke={sel ? ui.tint.good.ink : ui.mapLine}
          strokeWidth={sel ? 2.5 : border}
          strokeLinejoin="round"
          onPress={onPress ? () => onPress(s.name) : undefined}
        />
      );
    });
  }, [geo, selKey, byKey, empty, border, onPress, ui.tint.good.ink, ui.mapLine]);

  if (err || (geo && !box)) {
    return (
      <View className="items-center justify-center rounded-2xl bg-card px-6 py-10">
        <Text className="text-sm font-semibold text-warn-ink">Map Unavailable</Text>
        <Text className="pt-1 text-center text-xs text-muted">
          {err ?? `region outlines → unusable viewBox "${geo?.viewBox}"`}
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
      {!geo || !box || !paths || width <= 0 ? (
        <ActivityIndicator color={ui.tint.good.ink} />
      ) : (
        <Svg
          width={width}
          height={width / aspect}
          viewBox={geo.viewBox}
          accessibilityLabel={accessibilityLabel ?? 'Map of Nigeria by region'}
        >
          {paths}
        </Svg>
      )}
    </View>
  );
});
