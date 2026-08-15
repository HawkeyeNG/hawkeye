// Reduce SVG-path coordinate precision in the pre-baked *_geo.json maps.
// viewBox is ~800px wide, so integer coords are sub-pixel-accurate on screen
// but roughly halve the file. Format (viewBox + regions[].path) is preserved.
import fs from 'node:fs';
// NO LAYER QUALIFIES ANY MORE — the list is empty on purpose, not by accident.
//
// lga_geo.json came out first, when the state-scoped leaderboard began drawing
// it at ~12x zoom: rounding to whole user units costs up to ±0.5 unit (~6 CSS
// px) of drift, on exactly the borders the ward dissolve exists to make
// watertight. district_geo.json and constituency_geo.json stayed because they
// were "only ever drawn at the national viewBox, where it is invisible".
//
// That premise expired. Senate and House race pages draw ONE district or ONE
// constituency, cropped and zoomed far past the national view, which is the
// case that tears. Both are now rebuilt at the 1 decimal place their builders
// emit (build_reps_from_wards.js, merge_regions.js) and must stay that way.
//
// Anything added here later must be national-viewBox-only for its whole life.
// If it can ever be cropped to one region, leave it out.
const files = [];
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
