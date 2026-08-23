/**
 * Does every board and coverage figure use the contest's OWN scope as its
 * denominator?
 *
 * Runs against the register directly rather than a live server, so it can be run
 * before deploying anything, and it exercises the SAME function the routes call.
 *
 * IT HAS A CONTROL. Four of my verification scripts in one recent session
 * reported success while measuring nothing, so this one is two-sided: the
 * ungated contests (PRES/SEN/REP) must come back at their FULL register counts,
 * and the gated ones must come back smaller. A gate that did nothing fails the
 * second half; a gate that over-reached fails the first.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contestGate, regionLevelFor } from '../src/services/scope.js';

// Resolved from this file, not the working directory, so it gives the same
// answer wherever it is run from — a check that only works from one directory
// is a check that gets skipped.
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.DB_PATH || path.join(BACKEND, 'storage', 'hawkeye.db');
if (!fs.existsSync(DB)) {
  console.log(`no register at ${DB} — nothing measured, and that is not a pass`);
  process.exit(1);
}
const db = new Database(DB, { readonly: true });
const contests = JSON.parse(fs.readFileSync(path.join(BACKEND, 'src', 'data', 'contests.json'), 'utf8'));

const soleState = (c) => (Array.isArray(c.states) && c.states.length === 1 ? c.states[0] : null);

function subunits(c) {
  const state = soleState(c);
  const { col } = regionLevelFor(c.code, state);
  const gate = contestGate(c, col, { cropped: Boolean(state) });
  const sql = state
    ? `SELECT DISTINCT ${col} AS r FROM polling_units WHERE state = ? AND ${col} IS NOT NULL AND ${col} != ''${gate.sqlBare} ORDER BY r`
    : `SELECT DISTINCT ${col} AS r FROM polling_units WHERE ${col} IS NOT NULL AND ${col} != ''${gate.sqlBare} ORDER BY r`;
  const args = state ? [state, ...gate.params] : gate.params;
  return db.prepare(sql).all(...args).map((x) => x.r);
}

/** Full register counts — the landmark the ungated contests must still hit. */
const REGISTER = {
  state: db.prepare("SELECT COUNT(DISTINCT state) AS n FROM polling_units WHERE state IS NOT NULL AND state != ''").get().n,
  lga: db.prepare("SELECT COUNT(DISTINCT lga) AS n FROM polling_units WHERE lga IS NOT NULL AND lga != ''").get().n,
  senatorial: db.prepare("SELECT COUNT(DISTINCT senatorial) AS n FROM polling_units WHERE senatorial IS NOT NULL AND senatorial != ''").get().n,
  federal_constituency: db.prepare("SELECT COUNT(DISTINCT federal_constituency) AS n FROM polling_units WHERE federal_constituency IS NOT NULL AND federal_constituency != ''").get().n,
};

const EXPECT = {
  PRES: { n: REGISTER.state, why: 'nationwide — every state votes' },
  SEN: { n: REGISTER.senatorial, why: 'nationwide — all 109 districts' },
  REP: { n: REGISTER.federal_constituency, why: 'nationwide — all 362 seats' },
  GOV: { n: 28, why: '28 governorships in the 2027 cycle; 8 off-cycle + FCT excluded' },
  SHA: { n: 762, why: 'every LGA outside the FCT, which has no state assembly' },
  REP_BYE_GOMBE_2026: { n: 1, why: 'one federal constituency' },
  SHA_BYE_DELTA_UDU_2026: { n: 1, why: 'one LGA' },
  SHA_BYE_KANO_DAWAKINKUDU_2026: { n: 1, why: 'one LGA' },
};

let bad = 0;
let gatedShrank = 0;
let ungatedFull = 0;

for (const c of contests) {
  const got = subunits(c);
  const want = EXPECT[c.code];
  const { col } = regionLevelFor(c.code, soleState(c));
  const full = REGISTER[col];
  const ok = want && got.length === want.n;
  if (!ok) bad++;
  if (want && want.n < full) gatedShrank++;
  if (want && want.n === full) ungatedFull++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${c.code.padEnd(30)} ${String(got.length).padStart(4)} / ${String(full).padStart(4)} ${col.padEnd(22)} ${want ? want.why : 'NO EXPECTATION WRITTEN'}`,
  );
  if (!ok && want) console.log(`     expected ${want.n}, got ${got.length}: ${got.slice(0, 6).join(', ')}`);
}

// THE CONTROL. Without both halves this script can pass while measuring nothing.
console.log('');
if (!gatedShrank) { console.log('CONTROL FAILED: no contest is gated below its register total — this script proves nothing.'); bad++; }
else console.log(`control: ${gatedShrank} contests gated below the register total (the gate bites)`);
if (!ungatedFull) { console.log('CONTROL FAILED: no contest reaches its full register total — the gate is over-reaching.'); bad++; }
else console.log(`control: ${ungatedFull} contests still at their full register total (the gate is not over-reaching)`);

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall scopes correct');
process.exit(bad ? 1 : 0);
