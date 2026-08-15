// Validate the new contest set before it touches production.
import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));

const OFFCYCLE = ['Anambra', 'Bayelsa', 'Edo', 'Ekiti', 'Imo', 'Kogi', 'Ondo', 'Osun'];
const LEVELS = ['PRES', 'GOV', 'SHA', 'SEN', 'REP'];   // routes/national.js LEVEL/SCOPED

let bad = 0;
const fail = (m) => { console.log('  FAIL ' + m); bad++; };

console.log(`contests: ${c.length}`);
const codes = c.map((x) => x.code);
if (new Set(codes).size !== codes.length) fail('duplicate code — contests.find() would silently take the first');
for (const code of codes) if (!LEVELS.includes(code)) fail(`code ${code} has no map level in national.js`);
for (const x of c) {
  if (!x.name || !x.election || !x.date) fail(`${x.code} missing name/election/date`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) fail(`${x.code} bad date ${x.date}`);
  if (new Date(`${x.date}T00:00:00`).toString() === 'Invalid Date') fail(`${x.code} unparseable date`);
}

const gov = c.find((x) => x.code === 'GOV');
const sha = c.find((x) => x.code === 'SHA');
if (gov.states.length !== 28) fail(`GOV should cover 28 states, has ${gov.states.length}`);
for (const s of OFFCYCLE) if (gov.states.includes(s)) fail(`GOV must exclude off-cycle ${s}`);
if (sha.states.length !== 36) fail(`SHA should cover 36 states, has ${sha.states.length}`);
if (sha.states.includes('FCT')) fail('SHA must exclude FCT — it has Area Councils, not an Assembly');

// Cross-check every state name against the register, so a typo cannot silently
// scope a contest to nothing.
import { execSync } from 'node:child_process';
const known = new Set(JSON.parse(execSync(
  `python3 -c "import sqlite3,json; c=sqlite3.connect('file:/home/elrio/hawkeye/backend/storage/hawkeye.db?mode=ro',uri=True); print(json.dumps([r[0] for r in c.execute('SELECT DISTINCT state FROM polling_units')]))"`,
).toString()));
for (const x of [gov, sha]) for (const s of x.states) {
  if (!known.has(s)) fail(`${x.code}: "${s}" is not a state in the register`);
}

for (const x of c) {
  const days = Math.round((new Date(`${x.date}T00:00:00`) - new Date('2026-08-15')) / 86400000);
  console.log(`  ${x.code.padEnd(5)} ${x.date}  (${days} days out)  ${x.states ? x.states.length + ' states' : 'nationwide'}  ${x.election}`);
}
console.log(bad ? `\n${bad} PROBLEM(S)` : '\nvalid');
process.exitCode = bad ? 1 : 0;
