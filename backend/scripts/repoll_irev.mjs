/**
 * Re-check "no sheet published" findings against IReV, now.
 *
 *   node backend/scripts/repoll_irev.mjs <electionId> <findings.csv>
 *
 * WHY. "INEC published no EC8A result sheet for this polling unit" made up 21 of
 * the 23 published Osun findings — by far the project's loudest claim. It is
 * also the only finding class with an expiry date: INEC keeps uploading after
 * the audit ran, so a true statement on the day of publication quietly becomes a
 * false one, and nothing in the pipeline notices.
 *
 * A finding that decays silently is worse than no finding. If a unit's sheet has
 * since appeared, the honest move is to withdraw the finding and read the sheet,
 * BEFORE someone else checks and finds us asserting an absence that is no longer
 * there. This costs one API walk and no GPU.
 *
 * Run it at T+7, T+30 and again immediately before publication — not once at
 * fetch time, which is the only moment it is guaranteed to agree with itself.
 *
 * Reports only. It never edits findings.csv: withdrawing a published claim is a
 * human decision, and this is the evidence for it.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
const electionId = process.argv[2];
const findingsPath = process.argv[3];
if (!electionId || !findingsPath) {
  console.error('usage: node repoll_irev.mjs <electionId> <findings.csv>');
  process.exit(2);
}

const j = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(45_000) });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};

// The findings file writes units as 29/02/09/003; the register and the API use
// 29-02-09-003. Normalise both ways rather than trusting either.
const norm = (s) => String(s || '').trim().replace(/\//g, '-');

const csv = fs.readFileSync(findingsPath, 'utf8').trim().split('\n');
const head = csv[0].split(',');
const iType = head.indexOf('type');
const iUnit = head.indexOf('unit');
const targets = new Map();
for (const line of csv.slice(1)) {
  // Fields are quoted; a naive split is enough here because unit and type carry
  // no commas, and anything richer belongs in a real parser, not this script.
  const cells = line.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/^"|"?,?$/g, ''));
  if (!/no sheet/i.test(cells[iType] || '')) continue;
  targets.set(norm(cells[iUnit]), { unit: cells[iUnit], found: false, url: null });
}
console.log(`[repoll] ${targets.size} "no sheet published" findings to re-check`);
if (!targets.size) process.exit(0);

const election = await j(`${BASE}/elections`).then((d) => {
  const arr = Array.isArray(d) ? d : (d.data || d.elections || []);
  return arr.find((e) => String(e._id) === electionId);
});
if (!election) { console.error(`[repoll] election ${electionId} not found`); process.exit(1); }
console.log(`[repoll] ${election.full_name}`);

const lgas = await j(`${BASE}/elections/${electionId}/lga/state/${election.state_id}`);
const lgaList = Array.isArray(lgas) ? lgas : (lgas.data || []);
let scanned = 0;
for (const lga of lgaList) {
  // WARDS ARE EMBEDDED IN THE LGA RESPONSE. There is no /wards endpoint — the
  // first version guessed one, every request 404'd into a catch, and the script
  // reported "STILL ABSENT: 21/21" having walked nothing. Same shape as
  // fetch_irev_sheets.js, which is the walk known to work.
  for (const ward of (lga.wards || [])) {
    const pus = await j(`${BASE}/elections/${electionId}/pus?ward=${ward._id}`).catch(() => null);
    for (const pu of (Array.isArray(pus) ? pus : (pus?.data || []))) {
      scanned += 1;
      const code = norm(pu.pu_code || pu.puCode || pu.code);
      const t = targets.get(code);
      if (!t) continue;
      // A DOCUMENT MEANS THE FINDING HAS EXPIRED. Record the url so the sheet can
      // be fetched and read rather than merely un-asserted.
      if (pu.document?.url) { t.found = true; t.url = pu.document.url; }
    }
  }
}

// SCANNING NOTHING IS A FAILURE, NOT A RESULT. The first run walked zero polling
// units and announced that all 21 findings still stood — a confident answer from
// no data, about the project's loudest public claim. An absence can only be
// confirmed by a walk that actually happened, so this refuses to report one.
if (scanned === 0) {
  console.error(`[repoll] FAILED: walked 0 polling units across ${lgaList.length} LGA(s).`);
  console.error('[repoll] The API shape has changed, or this election has no units mapped.');
  console.error('[repoll] Reporting nothing rather than an absence it never verified.');
  process.exit(1);
}

const back = [...targets.values()].filter((t) => t.found);
console.log(`\n[repoll] scanned ${scanned} polling units`);
console.log(`[repoll] STILL ABSENT: ${targets.size - back.length}/${targets.size}`);
console.log(`[repoll] NOW PUBLISHED: ${back.length}/${targets.size}  <- these findings have expired`);
for (const t of back) console.log(`   ${t.unit}  ${t.url}`);
if (back.length) {
  console.log('\nWithdraw these before publishing, and fetch the sheets — they are readable now.');
  console.log('This script does not edit findings.csv: retracting a published claim is a human decision.');
}
