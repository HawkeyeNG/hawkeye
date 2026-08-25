import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { loadStatesGeo } from '@/components/nigeria-map';
import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

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

/**
 * The geometry file a level is drawn from. `lga` used to borrow `state`, because
 * the LGA "view" only ever tinted whole states; now that a state-scoped board is
 * genuinely per-LGA it has its own file (lga_geo.json, 774 shapes keyed
 * `"<state>|<lga>"`).
 */
export type GeoLevel = 'state' | 'lga' | 'senatorial' | 'federal';

const LEVELS = new Set<MapLevel>(['state', 'lga', 'senatorial', 'federal']);

/**
 * `level` off the wire is a plain string, and an unknown one must not silently
 * become a state map — the caller has to be able to say "this is not a level I
 * can draw". Hence null rather than a default.
 */
export function asMapLevel(level: string | null | undefined): MapLevel | null {
  return LEVELS.has(level as MapLevel) ? (level as MapLevel) : null;
}

export const geoLevelOf = (level: MapLevel): GeoLevel => level;

/** What one region of each level is called, for headings and sentences. */
export const LEVEL_WORD: Record<MapLevel, { one: string; many: string }> = {
  state: { one: 'state', many: 'states' },
  // Was "state"/"states" back when the LGA view was really a state view.
  lga: { one: 'LGA', many: 'LGAs' },
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

export type MapShape = {
  name: string;
  key: string;
  path: string;
  /** LGA shapes only — the normalised state they sit in, used to crop by state. */
  state?: string;
};
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
  lga: 'lga_geo.json',
};

/**
 * Districts whose neighbours' shapes overlap them, carried over verbatim from
 * app/results.html:231. SVG has no z-index: painting these last is what stops a
 * neighbour drawn afterwards from cutting into them.
 */
const FRONT = ['Ogun West', 'Kaduna South', 'Kebbi Central', 'Ondo Central'];

type RawRegions = { viewBox: string; regions: { name: string; path: string }[] };
/** lga_geo.json's own shape: keyed `"<state>|<lga>"`, lowercase, and no name field. */
type RawLgas = { viewBox: string; lgas: { key: string; path: string }[] };
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

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
      : geoLevel === 'lga'
      ? fetch(`${BASE}/${FILES.lga}`, { headers: { accept: 'application/json' } }).then(async (r) => {
          if (!r.ok) throw new Error(`${FILES.lga} → HTTP ${r.status}`);
          const raw = (await r.json()) as RawLgas;
          if (!raw?.lgas?.length) throw new Error(`${FILES.lga} → no LGA shapes`);
          return {
            viewBox: raw.viewBox,
            geoLevel,
            // `key` stays the FULL "state|lga" so shapes can be filtered to one
            // state; `name` is just the LGA, which is what a reader sees and what
            // the tally's region names are matched against.
            shapes: raw.lgas.map((l) => {
              const [st, lga] = l.key.split('|');
              return { name: titleCase(lga || ''), key: l.key, state: st, path: l.path };
            }),
          };
        })
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

/**
 * THE SHAPES A BOARD ACTUALLY DRAWS — one rule, exported, because the map draws
 * them and the legend counts them and the two must never disagree. They did:
 * results.tsx kept its own copy of the state crop, so a board that drew Kano's
 * 44 LGAs also captioned itself "44" while the server had said the election was
 * held in one of them.
 *
 * LGAs used to ignore `subunits` entirely — their keys name their state, so a
 * state crop was assumed to be the whole answer. It is not, once a contest can
 * be confined to named LGAs: a by-election in Dawaki Kudu drew the whole of Kano
 * with the seat merely outlined.
 *
 * TOTAL OR NOTHING. The crop is applied only if EVERY name the server sent
 * resolved to a shape. The register and the geo file disagree on ~50 LGA
 * spellings, and matchRegion recovers most but not all of them — narrowing
 * unconditionally drops 43 shapes across 26 states (Osun loses Ayedade, Lagos
 * loses Shomolu, Kano loses Dambatta and Nassarawa). A map with a hole in it
 * reads as "no LGA there", which is a lie; a map with the whole state in it
 * reads as too wide, which is merely unhelpful. Measured, both ways: under this
 * rule 11 states narrow cleanly, 26 decline and draw in full exactly as they do
 * today, and the three by-elections crop to their seats — with no state left
 * holed.
 */
export function cropShapes(
  geo: MapGeo | null,
  level: MapLevel,
  scopeState?: string | null,
  subunits?: string[] | null,
): MapShape[] | null {
  if (!geo) return null;
  if (!scopeState) return geo.shapes;

  const pool =
    geo.geoLevel === 'lga'
      ? geo.shapes.filter((s) => s.state === regionKey('state', scopeState))
      : geo.shapes;
  // Never hand back an empty map: if nothing matched, the honest fallback is the
  // full picture rather than a blank frame.
  if (!pool.length) return geo.shapes;
  if (!subunits?.length) return pool;

  if (geo.geoLevel === 'lga') {
    const keep = new Set<MapShape>();
    for (const want of subunits) {
      const hit = matchRegion(level, want, pool, (sh) => sh.name);
      if (!hit) return pool; // a name we could not place — draw the state, not a hole
      keep.add(hit);
    }
    return keep.size ? pool.filter((sh) => keep.has(sh)) : pool;
  }

  const want = new Set(subunits.map((n) => regionKey(level, n)));
  const scoped = pool.filter(
    (sh) => want.has(sh.key) || matchRegion(level, sh.name, subunits, (n) => n) != null,
  );
  return scoped.length ? scoped : pool;
}

/** Shape of the box before the geometry lands — keeps the card from jumping. */
const FALLBACK_ASPECT = 800 / 660;

/**
 * Bounding box of a set of pre-projected paths, as an SVG viewBox string.
 *
 * Every geo file shares one 800x660 projection, so drawing a SUBSET is already
 * geometrically correct — only the viewBox has to move for it to fill the frame.
 * react-native-svg has no getBBox() (the web map uses it), so the numbers are
 * read straight out of the path data, which is safe here: these paths are plain
 * absolute M/L/Z with no arcs or curves.
 */
export function bboxViewBox(paths: string[]): string | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of paths) {
    const n = String(d).match(/-?\d+(?:\.\d+)?/g);
    if (!n) continue;
    for (let i = 0; i + 1 < n.length; i += 2) {
      const x = Number(n[i]);
      const y = Number(n[i + 1]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
  return `${(x0 - pad).toFixed(1)} ${(y0 - pad).toFixed(1)} ${(x1 - x0 + pad * 2).toFixed(1)} ${(y1 - y0 + pad * 2).toFixed(1)}`;
}

export type ResultsMapProps = {
  level: MapLevel;
  /**
   * Crop to one state's sub-units and zoom to them — for a contest held in a
   * single state, where a map of all 36 others answers a question nobody asked.
   * Undefined draws the whole country.
   */
  scopeState?: string | null;
  /**
   * The sub-unit names in scope, from the API's `subunits` (the register). Used
   * for senatorial/federal crops, where the geo files carry no state property so
   * membership cannot be derived from the shapes themselves. Ignored for LGAs,
   * whose keys already name their state.
   */
  subunits?: string[] | null;
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
  scopeState,
  subunits,
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
      .catch((e) => alive && setErr(humanError(e, 'Could not load the map.')));
    return () => {
      alive = false;
    };
  }, [level, geoLevel]);

  /**
   * The shapes actually drawn. Unscoped this is the whole file; scoped it is one
   * state's sub-units — by key prefix for LGAs (whose keys name their state), and
   * by the register's `subunits` list for districts/constituencies, whose shapes
   * carry no state property at all.
   */
  const shapes = useMemo(
    () => cropShapes(geo, level, scopeState, subunits),
    [geo, scopeState, subunits, level],
  );

  // viewBox is "minX minY width height". Trusting it blindly would render a
  // blank box, so an unusable one is reported like any other failure. When the
  // map is cropped, the file's own box is replaced by the drawn subset's.
  const viewBox = useMemo(() => {
    if (!geo) return null;
    if (scopeState && shapes && shapes.length && shapes.length !== geo.shapes.length) {
      const fitted = bboxViewBox(shapes.map((s) => s.path));
      if (fitted) return fitted;
    }
    return geo.viewBox;
  }, [geo, shapes, scopeState]);

  const box = useMemo(() => {
    if (!viewBox) return null;
    const n = String(viewBox).trim().split(/[\s,]+/).map(Number);
    if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2] <= 0 || n[3] <= 0) return null;
    return { w: n[2], h: n[3] };
  }, [viewBox]);

  const byKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [region, colour] of Object.entries(fills)) {
      if (colour) m[regionKey(level, region)] = colour;
    }
    return m;
  }, [fills, level]);

  /**
   * A shape's fill. LGA shapes are keyed `"state|lga"` while the tally names a
   * bare LGA, so the shape's own key never matches — and the register and the
   * geo file disagree on ~5 spellings per state ("Ilesa" vs "ilesha"), so an
   * exact name match drops those too. Try the key, then the name, then
   * matchRegion's stem fallback, which is what resolves the rest.
   */
  const fillNames = useMemo(() => Object.keys(fills).filter((k) => fills[k]), [fills]);
  const fillOf = useMemo(() => {
    return (s: MapShape): string | undefined => {
      const direct = byKey[s.key] ?? byKey[regionKey(level, s.name)];
      if (direct) return direct;
      const hit = matchRegion(level, s.name, fillNames, (n) => n);
      return hit ? byKey[regionKey(level, hit)] : undefined;
    };
  }, [byKey, level, fillNames]);

  const selKey = useMemo(() => {
    if (!geo || !selected) return null;
    const hit = matchRegion(level, selected, shapes ?? geo.shapes, (s) => s.name);
    return hit ? hit.key : null;
  }, [geo, shapes, level, selected]);

  // Hairlines: a constituency is a few pixels wide on a phone, and a 1-unit
  // border on 358 of them eats the fill it is supposed to separate.
  //
  // Scaled by the viewBox, because stroke-width is in USER units: a cropped map
  // keeps the shared 800-wide projection but shows ~75 units, so an unscaled
  // 1-unit border rendered ~10x thicker and swallowed the small shapes it was
  // meant to separate. (The web does this with vector-effect:non-scaling-stroke;
  // react-native-svg support for that is inconsistent, so scale the number.)
  const baseBorder = geoLevel === 'federal' ? 0.5 : geoLevel === 'senatorial' ? 0.8 : 1;
  const border = baseBorder * Math.min(1, (box?.w ?? 800) / 800);

  const paths = useMemo(() => {
    if (!geo || !shapes) return null;
    const ordered = selKey
      ? [...shapes].sort((a, b) => Number(a.key === selKey) - Number(b.key === selKey))
      : shapes;
    return ordered.map((s) => {
      const fill = fillOf(s);
      const sel = s.key === selKey;
      return (
        <Path
          key={s.key}
          d={s.path}
          fill={fill ?? empty}
          fillRule="evenodd"
          fillOpacity={fill ? 0.92 : 1}
          stroke={sel ? ui.tint.good.ink : ui.mapLine}
          // THE SELECTION MUST SCALE TOO. `border` is divided down by the
          // viewBox above; this was a raw 2.5 beside it, so on a state-cropped
          // map (~60 units wide against 800) the highlight came out roughly 30x
          // the hairline around it — a fat blob that buried the district it was
          // pointing at. Same units trap the comment above describes.
          strokeWidth={sel ? border * 3 : border}
          strokeLinejoin="round"
          onPress={onPress ? () => onPress(s.name) : undefined}
        />
      );
    });
  }, [geo, shapes, selKey, fillOf, empty, border, onPress, ui.tint.good.ink, ui.mapLine]);

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
          viewBox={viewBox ?? geo.viewBox}
          accessibilityLabel={accessibilityLabel ?? 'Map of Nigeria by region'}
        >
          {paths}
        </Svg>
      )}
    </View>
  );
});
