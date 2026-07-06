// Build app/states_geo.json — simplified SVG paths + label centroids for Nigeria's
// 36 states + FCT, from GRID3 state boundaries. Self-made map: no licensing strings.
//
//   node scripts/fetch_states_geo.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const URL_BASE =
  'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/NGA_State_Boundaries_V2/FeatureServer/0';

// simple equirectangular projection onto an ~800x660 viewBox
const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];

const canonState = (s) => {
  const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
};

const res = await fetch(
  `${URL_BASE}/query?where=1%3D1&outFields=*&returnGeometry=true&maxAllowableOffset=0.03&f=json`,
);
const d = await res.json();
if (d.error) throw new Error(JSON.stringify(d.error));

const states = [];
for (const f of d.features || []) {
  const a = f.attributes || {};
  const name = a.statename || a.state || a.name || a.admin1Name;
  if (!name || !f.geometry?.rings) continue;
  let dPath = '';
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const ring of f.geometry.rings) {
    dPath += ring
      .map(([lng, lat], i) => {
        const [x, y] = project(lng, lat);
        if (i === 0) return `M${x} ${y}`;
        return `L${x} ${y}`;
      })
      .join('') + 'Z';
    for (const [lng, lat] of ring) {
      const [x, y] = project(lng, lat);
      cx += Number(x);
      cy += Number(y);
      n++;
    }
  }
  states.push({
    name,
    key: canonState(name),
    path: dPath,
    cx: Math.round(cx / n),
    cy: Math.round(cy / n),
  });
}

fs.writeFileSync(path.join(appDir, 'states_geo.json'), JSON.stringify({ viewBox: '0 0 800 660', states }));
console.log(`saved ${states.length} states -> app/states_geo.json`);
