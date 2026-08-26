/**
 * THE STATE MAP MUST TILE, AND IT MUST BE LABELLABLE.
 *
 * app/states_geo.json is drawn by three surfaces — the website's political page,
 * its results board, and the app's NigeriaMap. It came from ArcGIS, per state,
 * with each shape simplified on its own; Douglas-Peucker applied per feature
 * thins a shared border differently on each side, so neighbours stop touching.
 * Measured on the file this replaced: 47.8% of distinct vertices were touched by
 * two or more states, against the >70% bar the repo's other partitions are held
 * to. On the governors map, where 31 of 37 states are the same colour, every one
 * of those tears read as a stray dark line through a solid block.
 *
 * It is now dissolved from ward polygons through ONE topology
 * (backend/scripts/build_states_from_wards.js), which makes both sides of every
 * border the same arc by construction.
 *
 * This test is the regression bar. It runs on the FILE, so re-running the old
 * ArcGIS fetcher — which still exists — fails here rather than in someone's eye
 * three deploys later.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const geo = JSON.parse(fs.readFileSync(`${ROOT}/app/states_geo.json`, 'utf8'));

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

console.log('=== the file still describes Nigeria ===');
check('36 states + the FCT', geo.states.length, 37);
check('the shared projection viewBox', geo.viewBox, '0 0 800 660');
check('FCT is spelled as an acronym', geo.states.some((s) => s.name === 'FCT'));
// Every client keys on the NORMALISED key, so this is the field that must not
// drift — renaming it silently unpaints a state.
check('every state has a key and a path', geo.states.every((s) => s.key && s.path));
check('keys are unique', new Set(geo.states.map((s) => s.key)).size, 37);

console.log('\n=== it tiles: neighbours share their borders ===');
const pointsOf = (d) => {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(`${nums[i]},${nums[i + 1]}`);
  return out;
};
const seen = new Map();
let total = 0;
for (const s of geo.states) {
  const p = pointsOf(s.path);
  total += p.length;
  for (const q of new Set(p)) seen.set(q, (seen.get(q) ?? 0) + 1);
}
let shared = 0;
for (const [, n] of seen) if (n >= 2) shared++;
const ratio = (shared / seen.size) * 100;
console.log(`      ${total.toLocaleString()} vertices, ${seen.size.toLocaleString()} distinct, ${ratio.toFixed(1)}% shared`);
check('shared-vertex ratio clears the repo bar', ratio > 70);
/**
 * THE CONTROL for the line above: a shared-vertex ratio can also be high because
 * the file is so coarse that everything has collapsed onto a handful of points.
 *
 * 4,000, not the 6,000 I first wrote — that was set while the build was at
 * quantile 0.10 (9,899 vertices) and would have failed the deliberate choice to
 * ship 0.02 (5,836) for its 16 KB wire cost. The floor's job is to catch a
 * collapse back towards the old ArcGIS file's 1,810, and 4,000 does that with
 * room for a future re-tune in either direction.
 */
check('and there is enough detail to be Nigeria', total, (n) => n > 4000);

console.log('\n=== every state can hold a party emblem ===');
// The app sizes each badge from `lr` — the radius of the largest circle that
// fits inside the state — so a missing or zero value is not cosmetic: it is a
// state that silently loses its emblem.
check('every state carries a label point', geo.states.every((s) => s.lx != null && s.ly != null && s.lr != null));
check('every label point has real room around it', geo.states.every((s) => s.lr > 0));
// And the point must be INSIDE the viewBox — a pole computed off the wrong ring
// would sit in the sea and take the badge with it.
check('every label point is on the map', geo.states.every((s) => s.lx > 0 && s.lx < 800 && s.ly > 0 && s.ly < 660));

// Three states are too tight for a legible badge at phone width; the component
// skips them by design (BADGE_MIN_ROOM). Pinned so the number cannot creep up
// unnoticed — if a future simplify pass shrinks the interiors, this is where it
// shows.
const MIN_ROOM = 15;
const tight = geo.states.filter((s) => s.lr < MIN_ROOM).map((s) => s.name).sort();
console.log(`      too tight for a badge: ${tight.join(', ') || 'none'}`);
check('at most three states go unbadged', tight.length, (n) => n <= 3);

console.log('\n=== the app and the builder agree on the rule ===');
const comp = fs.readFileSync(`${ROOT}/native/src/components/nigeria-map.tsx`, 'utf8');
check('the component reads lr, not the centroid', /s\.lr/.test(comp));
check('and its floor is the one measured above',
  Number(/const BADGE_MIN_ROOM = (\d+)/.exec(comp)?.[1]), MIN_ROOM);
check('badges are drawn after every path (SVG has no z-index)',
  comp.indexOf('marks.map(') > comp.indexOf('ordered.map('));

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
