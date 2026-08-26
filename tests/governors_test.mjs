/**
 * THE GOVERNORS MAP NAMES A PERSON, AND THE DATA BEHIND IT IS SOUND.
 *
 * Until 26 August 2026 political_data.json held state → party and nothing else,
 * and both clients said so in a comment: "Naming a person we do not have is the
 * one thing this page must not do." The names are now researched from each state
 * government site and the Nigeria Governors Forum, cross-checked against
 * Wikipedia rather than taken from it.
 *
 * A wrong name beside a party, on a public election-monitoring product, is the
 * worst failure this page has. So this guards the data's SHAPE — 36 states, no
 * FCT governor, every named state also has a party, every party is a party the
 * app can draw — rather than the names themselves, which no test can verify.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const d = JSON.parse(fs.readFileSync(`${ROOT}/app/political_data.json`, 'utf8'));
const parties = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/parties.json`, 'utf8'));
const emblems = JSON.parse(fs.readFileSync(`${ROOT}/app/logos/manifest.json`, 'utf8'));

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

console.log('=== 36 governors, and no governor of the FCT ===');
const names = d.governorNames || {};
check('every state is named', Object.keys(names).length, 36);
// The FCT is administered by a minister, not governed. A "Governor of the FCT"
// would be a claim about an office that does not exist — app/race.js already
// refuses to generate a page for one.
check('the FCT is not given a governor', 'FCT' in names, false);
check('and its party is null, not blank', d.governors.FCT, null);
check('no name is empty', Object.values(names).every((n) => n && n.trim().length > 2));

console.log('\n=== a named state always has a party the app can draw ===');
const codes = new Set(parties.map((p) => p.code));
const missingParty = Object.keys(names).filter((s) => !d.governors[s]);
check('every named state has a party', missingParty, (m) => m.length === 0);
const unknown = [...new Set(Object.values(d.governors).filter(Boolean))].filter((p) => !codes.has(p));
check('every party is in parties.json', unknown, (u) => u.length === 0);
const noEmblem = [...new Set(Object.values(d.governors).filter(Boolean))].filter((p) => !emblems[p]);
check('and every one has an emblem for the map badge', noEmblem, (n) => n.length === 0);

console.log('\n=== the states match the ones the map can draw ===');
const geo = JSON.parse(fs.readFileSync(`${ROOT}/app/states_geo.json`, 'utf8'));
const norm = (s) => {
  const n = String(s).toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /fct|federal capital|abuja/.test(n) ? 'fct' : n;
};
const geoKeys = new Set(geo.states.map((s) => norm(s.name)));
const unmappable = Object.keys(names).filter((s) => !geoKeys.has(norm(s)));
// A name for a state the map cannot draw would never be reachable by a tap.
check('every named state exists on the map', unmappable, (u) => u.length === 0);

console.log('\n=== provenance is recorded, because this is sourced data ===');
check('there is a note', typeof d.governorsNote, 'string');
check('it names the sources', /Nigeria Governors Forum/i.test(d.governorsNote || ''));
check('it carries an as-at date', /26 August 2026/.test(d.governorsNote || ''));
// Two entries can go stale without anything else changing, and the note is the
// only place that says so. Pinned so a future edit cannot quietly drop them.
check('it flags the Imo resignation risk', /Imo/.test(d.governorsNote || '') && /resign/i.test(d.governorsNote || ''));
check('and the Rivers impeachment', /Rivers/.test(d.governorsNote || '') && /impeach/i.test(d.governorsNote || ''));

console.log('\n=== both clients read it, and neither still claims it is absent ===');
const nat = fs.readFileSync(`${ROOT}/native/src/app/political.tsx`, 'utf8');
const web = fs.readFileSync(`${ROOT}/app/political.html`, 'utf8');
check('native looks up a name', /function governorName/.test(nat) && /governorName\(d, pickedState\)/.test(nat));
check('web reads governorNames', /data\.governorNames/.test(web));
check('web states are tappable, not hover-only', /role="button"[^`]*data-state=/.test(web) || /data-state="\$\{esc\(st\.name\)\}"/.test(web));
// THE STALE CLAIM. Both files used to say the data had no names. If that
// sentence survives, someone will read it and believe it.
check('native no longer says we have no names',
  /political_data\.json holds state → party and no\s*\*?\s*governor names/.test(nat), false);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
