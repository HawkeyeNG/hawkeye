/* Pull a ward layer's ATTRIBUTES (no geometry) from an ArcGIS Feature Service
   and write it as a GeoJSON-shaped file the test in find_ward_boundaries.mjs
   can read.

   Attributes only, on purpose: the question at this stage is "does this file
   agree with INEC about how many wards each LGA has", and that is answered by
   three text columns. The geometry is tens of megabytes and only worth
   fetching once a layer has passed.

     node scripts/wards/arcgis_wards.mjs <arcgisItemId> <out.geojson>
*/
import { writeFileSync } from 'node:fs';

const [item, out] = process.argv.slice(2);
if (!item || !out) { console.log('usage: arcgis_wards.mjs <itemId> <out.geojson>'); process.exit(1); }

const meta = await (await fetch(`https://www.arcgis.com/sharing/rest/content/items/${item}?f=json`)).json();
const layer = meta.url + '/0';
const info = await (await fetch(layer + '?f=json')).json();
const fields = (info.fields || []).map((f) => f.name);
/* Publishers spell these three differently — state / statename / State_Name —
   so the columns are matched, not assumed. */
const find = (re) => fields.find((f) => re.test(f));
const want = [find(/^(state|statename|state_name)$/i), find(/^(lga|lganame|lga_name)$/i),
  find(/^(ward|wardname|ward_name)$/i)].filter(Boolean);
if (want.length < 3) { console.log('layer has no state/lga/ward columns: ' + fields.join(',')); process.exit(1); }

const feats = [];
let offset = 0;
for (;;) {
  const u = layer + '/query?where=1%3D1&outFields=' + want.join(',')
    + '&returnGeometry=false&f=json&resultOffset=' + offset + '&resultRecordCount=2000';
  const b = await (await fetch(u)).json();
  const got = b.features || [];
  feats.push(...got.map((f) => ({ type: 'Feature', properties: f.attributes, geometry: null })));
  if (got.length < 2000 || !b.exceededTransferLimit) break;
  offset += got.length;
}
writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features: feats }));
console.log(meta.title + ': ' + feats.length + ' features -> ' + out);
