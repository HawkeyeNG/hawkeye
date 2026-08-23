import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { bboxViewBox, loadMapGeo, matchRegion } from '@/components/results-map';
import { api, type National, type NationalRegion } from '@/lib/api';
import { partyColor, type RaceJoin } from '@/lib/political';
import { useUi } from '@/lib/theme';

/**
 * The seat's own map, on a race screen. Native twin of app/race.js:raceMapHtml.
 *
 * Cut from the layers the site already ships rather than drawn from new
 * geometry: every senatorial district and federal constituency is a union of
 * WHOLE LGAs (measured — zero LGAs are shared between seats at either level),
 * and a governorship's seat is a whole state, so all three levels are a filter
 * over lga_geo.json.
 *
 * FALLS BACK TO THE SEAT'S OUTLINE where LGAs cannot represent it: the numbered
 * federal constituencies that split one LGA between them (Lagos Island I/II,
 * Mushin I/II, Surulere I/II) and single-LGA seats have nothing to subdivide.
 * DRAWS NOTHING on a partial cut — a seat missing pieces of itself is worse than
 * no map at all.
 */
type Shape = { key: string; name: string; path: string };

const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function shapesFor(join: RaceJoin): Promise<{ shapes: Shape[]; caption: string } | null> {
  if (!join?.value) return null;

  // A governorship: the state, cut into its LGAs. Membership is read from
  // lga_geo's own keys, so all 36 states work with nothing written down per
  // state — a hand-listed membership could only go stale or disagree with the
  // map it describes.
  if (join.level === 'state') {
    const geo = await loadMapGeo('lga');
    const want = norm(join.value);
    const shapes = geo.shapes.filter((s) => norm(String(s.key).split('|')[0]) === want);
    if (shapes.length > 1) {
      return {
        shapes: shapes.map((s) => ({ key: s.key, name: s.name, path: s.path })),
        caption: `${join.value} State — ${shapes.length} local government areas`,
      };
    }
    const states = await loadMapGeo('state');
    const hit = states.shapes.find((s) => norm(s.name) === want);
    return hit
      ? { shapes: [{ key: hit.key, name: hit.name, path: hit.path }], caption: `${join.value} State` }
      : null;
  }

  // A SEAT, cut into its member LGAs.
  //
  // `> 1` used to guard this: a single-LGA seat had nothing to subdivide and
  // took the outline path instead. That is right for SEN and REP, whose
  // outlines exist — and wrong for a STATE-ASSEMBLY seat, which has no outline
  // file at all, so the guard left it with no map whatsoever. A one-LGA cut is
  // allowed when nothing else could be drawn.
  const minParts = join.level === 'lga' ? 1 : 2;
  if (join.lgas && join.lgas.length >= minParts && join.state) {
    const geo = await loadMapGeo('lga');
    // RESOLVED, not compared raw. The register and lga_geo.json disagree by a
    // letter or two on names that are plainly the same LGA — "Ayedaade" vs
    // "Ayedade", "Somolu" vs "Shomolu" — so an exact key match silently drops
    // them and the seat containing one falls back to a featureless outline.
    // matchRegion is the board's own matcher, uniqueness-guarded at every loose
    // tier: it would rather find nothing than paint the neighbouring LGA.
    const state = join.state;
    const pool = geo.shapes.filter((s) => norm(String(s.key).split('|')[0]) === norm(state));
    const shapes: Shape[] = [];
    for (const l of join.lgas) {
      const hit = matchRegion('lga', l, pool, (s) => String(s.key).split('|')[1] ?? '');
      if (!hit) break;
      shapes.push({ key: hit.key, name: hit.name, path: hit.path });
    }
    // Only use the cut if it found EVERY member; a partial cut would draw a seat
    // missing pieces of itself, which is worse than an outline.
    if (shapes.length === join.lgas.length) {
      return {
        shapes,
        caption: `${join.value} — ${shapes.length} local government area${shapes.length === 1 ? '' : 's'}`,
      };
    }
  }

  // THERE IS NO OUTLINE FOR A STATE CONSTITUENCY, and there cannot be: they are
  // not in the register and no boundary file ships them. Falling through to
  // constituency_geo.json would look up an assembly seat's name among the 360
  // FEDERAL ones — a lookup that can only miss, or worse, hit a same-named
  // federal seat and draw the wrong shape.
  if (join.level === 'lga') return null;

  const geo = await loadMapGeo(join.level === 'senatorial' ? 'senatorial' : 'federal');
  const hit = geo.shapes.find((s) => norm(s.name) === norm(join.value));
  return hit ? { shapes: [{ key: hit.key, name: hit.name, path: hit.path }], caption: join.value } : null;
}

/**
 * Register spellings and geo-file spellings disagree for a handful of LGAs per
 * state ("Atakumosa" vs "atakunmosa"), so an exact match silently drops them and
 * the map shows blanks where reports exist. Same two-tier fallback the board
 * uses: exact normalised, then a first-four-letters-per-word stem, with
 * ambiguous stems dropped rather than guessed at.
 */
function regionLookup(regions: NationalRegion[] | undefined) {
  const stemOf = (s: string) => norm(s).replace(/([a-z0-9]{4})[a-z0-9]*/g, '$1');
  const exact = new Map<string, NationalRegion>();
  const stem = new Map<string, NationalRegion | null>();
  for (const r of regions ?? []) {
    exact.set(norm(r.region), r);
    const k = stemOf(r.region);
    stem.set(k, stem.has(k) ? null : r);
  }
  return (name: string) => exact.get(norm(name)) ?? stem.get(stemOf(name)) ?? null;
}

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Why an area has no numbers. Three genuinely different states — an election
 * still ahead, one under way, one finished — and a single "no data" for all
 * three would read as a failure on polling day and as a silence months early.
 */
function silenceReason(date?: string): string {
  if (!date) return 'No date has been set for this election yet.';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(`${date}T00:00:00`);
  day.setHours(0, 0, 0, 0);
  if (day > today) return `Polls open on ${fmtDay(date)}.`;
  if (day.getTime() === today.getTime()) return 'Polls are open — no reports from here yet.';
  return 'No reports were filed from here.';
}

/** One line per fact, most important first. Twin of app/race.js:inspectLines. */
function inspectLines(date: string | undefined, name: string, row: NationalRegion | null): string[] {
  if (!row || !row.unitsReporting) return [name, silenceReason(date)];
  const L = row.leaders?.length ? row.leaders : row.leader ? [row.leader] : [];
  const lead =
    L.length > 2
      ? `${L.length}-way tie`
      : L.length === 2
        ? `${L[0]} and ${L[1]} tied`
        : L.length === 1
          ? `${L[0]} leads`
          : 'No votes counted yet';
  // Typed empty fallback: `?? {}` widens the entries to `unknown` and the sort
  // below stops being a number comparison.
  const votes: Record<string, number> = row.votes ?? {};
  const top = Object.entries(votes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, v]) => `${p} ${Number(v).toLocaleString()}`)
    .join(' · ');
  return [
    `${name} — ${lead}`,
    `${row.unitsReporting} unit${row.unitsReporting === 1 ? '' : 's'} reporting, ${row.unitsVerified ?? 0} verified`,
    top,
  ].filter(Boolean);
}

export function RaceMap({ join, date }: { join?: RaceJoin; date?: string }) {
  const ui = useUi();
  const [data, setData] = useState<{ shapes: Shape[]; caption: string } | null>(null);
  const [board, setBoard] = useState<National | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!join) return undefined;
    // A failure here must cost nothing: the screen is about the race, the map is
    // context, and a seat with no matching geometry simply shows none.
    shapesFor(join)
      .then((r) => live && setData(r))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [join]);

  useEffect(() => {
    let live = true;
    const state = join?.state || join?.value;
    if (!join?.contest || !state) return undefined;
    // `level=lga` is asked for explicitly: a senatorial contest's own breakdown
    // is by district, and this map draws LGAs. The map is still a map without a
    // board, so a failure is silent by design.
    api
      .national(join.contest, { state, level: 'lga' })
      .then((b) => live && setBoard(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [join]);

  const find = useMemo(() => regionLookup(board?.regions), [board]);
  const lines = useMemo(
    () => (picked ? inspectLines(date, picked, find(picked)) : null),
    [picked, find, date],
  );
  const onPick = useCallback((name: string) => setPicked(name), []);

  const viewBox = useMemo(
    () => (data ? bboxViewBox(data.shapes.map((s) => s.path)) : null),
    [data],
  );
  if (!data || !viewBox) return null;

  // Keep every seat the same shape, so a long thin constituency and a compact
  // one sit at the same aspect rather than one filling the screen.
  const [vx, vy, vw, vh] = viewBox.split(' ').map(Number);
  const AR = 1.35;
  let w = vw;
  let h = vh;
  if (w / h < AR) w = h * AR;
  else h = w / AR;
  const box = `${(vx + vw / 2 - w / 2).toFixed(1)} ${(vy + vh / 2 - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;

  // STROKE WIDTH IS IN USER UNITS, and a cropped map keeps the shared 800-wide
  // projection while showing a fraction of it — so a fixed number is a hairline
  // on Kano and a slab on a single-LGA seat. results-map.tsx hit this first and
  // records why the web's vector-effect:non-scaling-stroke is not the answer
  // here: react-native-svg's support for it is inconsistent. Scale the number
  // instead, against the same 800 baseline.
  const border = 1.1 * Math.min(1, w / 800);

  // A selected shape is drawn LAST. There is no z-index in SVG, so a neighbour
  // painted afterwards covers half the outline meant to pick the selection out —
  // and at 44-to-a-frame that outline is all there is to see.
  const ordered = picked
    ? [...data.shapes].sort((a, b) => Number(a.name === picked) - Number(b.name === picked))
    : data.shapes;

  return (
    <View className="pt-4">
      <View style={{ aspectRatio: AR }}>
        <Svg width="100%" height="100%" viewBox={box}>
          {ordered.map((s) => {
            const row = find(s.name);
            // Tint by the LEADING PARTY — the one thing a results map exists to
            // show. An exact tie is left untinted rather than credited to one side.
            const lead = row?.unitsReporting && row.leaders?.length === 1 ? row.leaders[0] : null;
            const on = s.name === picked;
            return (
              // The internal borders ARE the information — a seat drawn as one
              // silhouette says nothing its title did not, so the stroke carries
              // more weight than the fill.
              <Path
                key={s.key}
                d={s.path}
                fill={lead ? partyColor(lead) : ui.ink}
                fillOpacity={lead ? 0.55 : 0.1}
                stroke={on ? ui.tint.good.ink : ui.ink}
                strokeOpacity={on ? 1 : 0.7}
                strokeWidth={on ? border * 2.8 : border}
                strokeLinejoin="round"
                onPress={() => onPick(s.name)}
              />
            );
          })}
        </Svg>
      </View>
      <Text className="pt-1 text-center text-xs text-muted">{data.caption}</Text>

      {/* Tap-to-inspect. The web shows a tooltip on hover, which a phone cannot
          trigger; this panel is what replaces it. It keeps its height so the
          screen does not jump the first time an area is tapped. */}
      <View className="mt-2 rounded-2xl bg-card px-3.5 py-3" style={{ minHeight: 62 }}>
        {lines ? (
          lines.map((l, i) => (
            <Text
              key={l}
              className={i === 0 ? 'text-sm font-bold text-ink' : 'pt-0.5 text-xs text-muted'}
            >
              {l}
            </Text>
          ))
        ) : (
          <Text className="text-xs text-muted">
            Tap an area of the map for what has been reported from it.
          </Text>
        )}
      </View>
    </View>
  );
}
