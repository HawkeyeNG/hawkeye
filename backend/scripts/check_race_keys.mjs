/**
 * raceKey fixtures — the property the by-election model depends on.
 *
 * The key partitions per-race subchains and is the Merkle leaf preimage
 * (services/merkle.js), stored in anchor_races.race_key. Two things must hold
 * forever:
 *
 *   1. The five original contests produce BYTE-IDENTICAL keys to what they
 *      always have. Anything else invalidates published anchors.
 *   2. A by-election NEVER shares a key with the general election in the same
 *      seat. Sharing would merge two elections into one subchain inside a
 *      published anchor, permanently and undetectably.
 *
 *   node scripts/check_race_keys.mjs
 */
import { raceKey, contestTier } from '../src/services/scope.js';
import { contests } from '../src/db.js';

let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
};

// A unit inside the Gombe by-election seat, and one elsewhere in the same state.
const inSeat = { state: 'Gombe', lga: 'Gombe', ward: 'Bolari East',
  senatorial: 'Gombe Central', federal_constituency: 'Gombe/Kwami/Funakaye' };
const sameStateOtherSeat = { state: 'Gombe', lga: 'Balanga', ward: 'Talasse',
  senatorial: 'Gombe South', federal_constituency: 'Balanga/Billiri' };
const udu = { state: 'Delta', lga: 'Udu', federal_constituency: 'Ughelli North/Ughelli South/Udu' };
const fct = { state: 'FCT', lga: 'Bwari' };

console.log('the five original contests are unchanged');
check('PRES', raceKey(inSeat, 'PRES'), 'PRES');
check('GOV',  raceKey(inSeat, 'GOV'),  'GOV|Gombe');
check('SEN',  raceKey(inSeat, 'SEN'),  'SEN|Gombe|Gombe Central');
check('REP',  raceKey(inSeat, 'REP'),  'REP|Gombe|Gombe/Kwami/Funakaye');
check('SHA',  raceKey(inSeat, 'SHA'),  'SHA|Gombe|Gombe');
check('FCT has no governorship', raceKey(fct, 'GOV'), null);
check('FCT has no state assembly', raceKey(fct, 'SHA'), null);
check('unknown code files nowhere', raceKey(inSeat, 'NONSENSE'), null);

console.log('\nby-elections are led by their own code');
check('Gombe by-election', raceKey(inSeat, 'REP_BYE_GOMBE_2026'),
  'REP_BYE_GOMBE_2026|Gombe|Gombe/Kwami/Funakaye');
check('Udu by-election', raceKey(udu, 'SHA_BYE_DELTA_UDU_2026'),
  'SHA_BYE_DELTA_UDU_2026|Delta|Udu');

console.log('\nand can never collide with the general election in the same seat');
for (const c of contests.filter((x) => x.tier)) {
  const pu = c.code.startsWith('REP') ? inSeat : udu;
  const bye = raceKey(pu, c.code);
  const general = raceKey(pu, contestTier(c.code));
  const ok = bye && general && bye !== general;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.code} !== ${contestTier(c.code)}`);
  if (!ok) console.log(`          both -> ${JSON.stringify(bye)}`);
}

console.log('\nevery contest in contests.json resolves to a key shape');
for (const c of contests) {
  const k = raceKey(inSeat, c.code);
  const applies = !(inSeat.state === 'FCT');
  if (k === null && applies && c.code !== 'GOV') {
    // GOV/SHA legitimately return null off-allowlist; only a code with NO case
    // in raceKey is a configuration error.
    if (!contestTier(c.code)) { console.log(`  FAIL  ${c.code} has no raceKey shape`); bad++; }
  }
}
console.log('  ok    (a code with no tier case would file nowhere at all)');

console.log(bad ? `\n${bad} failure(s)` : '\nall race-key properties hold');
process.exit(bad ? 1 : 0);
