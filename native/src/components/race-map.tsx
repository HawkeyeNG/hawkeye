import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { bboxViewBox, loadMapGeo } from '@/components/results-map';
import type { RaceJoin } from '@/lib/political';
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

  if (join.lgas && join.lgas.length > 1 && join.state) {
    const geo = await loadMapGeo('lga');
    const want = new Set(join.lgas.map((l) => norm(`${join.state}|${l}`)));
    const shapes = geo.shapes.filter((s) => want.has(norm(s.key)));
    // Only use the cut if it found every member.
    if (shapes.length === join.lgas.length) {
      return {
        shapes: shapes.map((s) => ({ key: s.key, name: s.name, path: s.path })),
        caption: `${join.value} — ${shapes.length} local government areas`,
      };
    }
  }

  const geo = await loadMapGeo(join.level === 'senatorial' ? 'senatorial' : 'federal');
  const hit = geo.shapes.find((s) => norm(s.name) === norm(join.value));
  return hit ? { shapes: [{ key: hit.key, name: hit.name, path: hit.path }], caption: join.value } : null;
}

export function RaceMap({ join }: { join?: RaceJoin }) {
  const ui = useUi();
  const [data, setData] = useState<{ shapes: Shape[]; caption: string } | null>(null);

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

  return (
    <View className="pt-4">
      <View style={{ aspectRatio: AR }}>
        <Svg width="100%" height="100%" viewBox={box}>
          {data.shapes.map((s) => (
            // The internal borders ARE the information — a seat drawn as one
            // silhouette says nothing its title did not, so the stroke carries
            // more weight than the fill.
            <Path
              key={s.key}
              d={s.path}
              fill={ui.ink}
              fillOpacity={0.1}
              stroke={ui.ink}
              strokeOpacity={0.7}
              strokeWidth={border}
              strokeLinejoin="round"
            />
          ))}
        </Svg>
      </View>
      <Text className="pt-1 text-center text-xs text-muted">{data.caption}</Text>
    </View>
  );
}
