// Reduce SVG-path coordinate precision in the pre-baked *_geo.json maps.
// viewBox is ~800px wide, so integer coords are sub-pixel-accurate on screen
// but roughly halve the file. Format (viewBox + regions[].path) is preserved.
import fs from 'node:fs';
const files = ['lga_geo.json', 'district_geo.json', 'constituency_geo.json'];
for (const f of files) {
  const p = `../app/${f}`;
  const before = fs.statSync(p).size;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const round = (s) => s.replace(/-?\d+\.\d+/g, (n) => String(Math.round(parseFloat(n))));
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) {
      if (k === 'path' && typeof o[k] === 'string') o[k] = round(o[k]);
      else walk(o[k]);
    }
  };
  walk(j);
  fs.writeFileSync(p, JSON.stringify(j));
  const after = fs.statSync(p).size;
  console.log(`${f}: ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB`);
}
