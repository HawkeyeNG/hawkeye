// app/lga_geo.json — simplified LGA polygons (774) for the district/constituency
// map views. Same projection/viewBox as fetch_states_geo.js so layers align.
//   node scripts/fetch_lga_geo.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const URL = 'https://services3.arcgis.com/BU6Aadhn6tbBEdyk/arcgis/rest/services/NGA_LGA_Boundaries_2/FeatureServer/0';
const project = (lng, lat) => [((lng - 2.5) * 66).toFixed(1), ((14.1 - lat) * 66).toFixed(1)];
const norm = (s) => {
  const n = String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
};

const lgas = [];
for (let off = 0; ; off += 2000) {
  const p = new URLSearchParams({ where: '1=1', outFields: 'lganame,statename', returnGeometry: 'true', maxAllowableOffset: '0.02', resultOffset: String(off), resultRecordCount: '2000', f: 'json' });
  const d = await (await fetch(`${URL}/query?${p}`)).json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  for (const f of d.features || []) {
    const a = f.attributes || {};
    if (!a.lganame || !f.geometry?.rings) continue;
    let dPath = '', cx = 0, cy = 0, n = 0;
    for (const ring of f.geometry.rings) {
      dPath += ring.map(([lng, lat], i) => { const [x, y] = project(lng, lat); return (i ? 'L' : 'M') + x + ' ' + y; }).join('') + 'Z';
      for (const [lng, lat] of ring) { const [x, y] = project(lng, lat); cx += +x; cy += +y; n++; }
    }
    lgas.push({ key: `${norm(a.statename)}|${norm(a.lganame)}`, path: dPath, cx: Math.round(cx / n), cy: Math.round(cy / n) });
  }
  process.stdout.write(`\r  lgas: ${lgas.length}`);
  if (!d.exceededTransferLimit && (d.features || []).length < 2000) break;
}
console.log();
fs.writeFileSync(path.join(appDir, 'lga_geo.json'), JSON.stringify({ viewBox: '0 0 800 660', lgas }));
console.log(`saved ${lgas.length} LGAs -> app/lga_geo.json`);
