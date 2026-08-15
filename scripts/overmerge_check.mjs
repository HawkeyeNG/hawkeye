// Did any fix collapse two seats the MAP keeps apart?
// A fix A -> B is an over-merge if the map holds A and B as distinct regions:
// the dissolve saw two different sets of wards, so they are two seats.
import fs from 'node:fs';
const fixes = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/register_name_fixes.json', 'utf8')).fixes;
const regions = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/app/constituency_geo.json', 'utf8')).regions.map((r) => r.name);
const districts = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/app/district_geo.json', 'utf8')).regions.map((r) => r.name);

const norm = (s) => String(s || '').toUpperCase().replace(/['’]/g, '')
  .replace(/[^A-Z0-9/]+/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).split('/').map((p) => p.trim()).filter(Boolean).sort().join('/');

const setFor = (col) => new Set((col === 'senatorial' ? districts : regions).map(key));
const bad = [];
for (const f of fixes) {
  const S = setFor(f.col);
  if (S.has(key(f.from)) && S.has(key(f.to)) && key(f.from) !== key(f.to)) bad.push(f);
}
console.log(`fixes: ${fixes.length}`);
console.log(`OVER-MERGES (map keeps both apart): ${bad.length}`);
for (const f of bad) console.log(`  ${f.col}: ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
