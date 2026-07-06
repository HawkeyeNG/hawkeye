// IReV cross-check — the strongest anti-rig signal: compare each crowd-reported
// count against INEC's OWN uploaded EC8A for that unit (IReV API is public).
// INEC publishes sheet IMAGES, not numbers, so the comparison runs our OCR over
// their image and checks the crowd's counts appear on it. A mismatch is logged as
// a HIGH discrepancy with a link to INEC's sheet so anyone can eyeball both.
// Idle until IREV_ELECTION_ID is set (when INEC opens the election).
import { db } from '../db.js';
import { config } from '../config.js';
import { ocrMatchCounts } from './ocr.js';
import { logDiscrepancy } from './integrity.js';

const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
const H = { 'user-agent': 'Mozilla/5.0' };
const j = (u) => fetch(u, { headers: H }).then((r) => r.json()).catch(() => ({}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;

// Walk one state's wards on IReV and cache every PU's doc URL we encounter —
// one walk covers all future lookups in that state. State id = the first
// segment of the INEC delimitation code (our pu_code and IReV's agree).
async function walkState(electionId, stateId) {
  const ins = db.prepare(`
    INSERT INTO irev_docs (pu_code, election_id, doc_url, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT (pu_code, election_id) DO UPDATE SET doc_url = excluded.doc_url
    WHERE irev_docs.doc_url IS NULL`);
  const lgas = (await j(`${BASE}/elections/${electionId}/lga/state/${stateId}`)).data || [];
  for (const lga of lgas) {
    for (const ward of lga.wards || []) {
      const pus = (await j(`${BASE}/elections/${electionId}/pus?ward=${ward._id}`)).data || [];
      for (const pu of pus) {
        const code = (pu.pu_code || '').replaceAll('/', '-');
        if (code) ins.run(code, electionId, pu.document?.url || null);
      }
      await sleep(300);
    }
  }
}

// Compare INEC's sheet against the crowd result for one unit.
async function checkUnit(row, electionId) {
  const doc = db.prepare('SELECT doc_url FROM irev_docs WHERE pu_code = ? AND election_id = ?')
    .get(row.pu_code, electionId);
  if (!doc?.doc_url) {
    db.prepare(`INSERT INTO irev_docs (pu_code, election_id, status, checked_at) VALUES (?, ?, 'no_doc', ?)
      ON CONFLICT (pu_code, election_id) DO UPDATE SET status = 'no_doc', checked_at = excluded.checked_at`)
      .run(row.pu_code, electionId, Date.now());
    return 'no_doc';
  }
  const img = await fetch(doc.doc_url, { headers: H });
  if (!img.ok) return 'fetch_failed';
  const votes = JSON.parse(row.votes_json).filter((v) => v.count > 0);
  if (!votes.length) return 'no_counts';
  const ocr = await ocrMatchCounts(Buffer.from(await img.arrayBuffer()), votes);
  if (!ocr) return 'ocr_failed';
  // OCR reads ~60-77% of counts on clean sheets: require BOTH zero matches and
  // several counts to call a mismatch — one missed digit must not cry wolf.
  const mismatch = ocr.total >= 3 && ocr.matched === 0;
  const status = mismatch ? 'mismatch' : ocr.matched >= Math.ceil(ocr.total / 2) ? 'consistent' : 'inconclusive';
  db.prepare('UPDATE irev_docs SET ocr_matched = ?, ocr_total = ?, status = ?, checked_at = ? WHERE pu_code = ? AND election_id = ?')
    .run(ocr.matched, ocr.total, status, Date.now(), row.pu_code, electionId);
  if (mismatch) {
    const pu = db.prepare('SELECT state FROM polling_units WHERE pu_code = ?').get(row.pu_code);
    logDiscrepancy({
      type: 'irev_mismatch', severity: 'high', puCode: row.pu_code, contest: row.contest, state: pu?.state,
      detail: { matched: ocr.matched, total: ocr.total, docUrl: doc.doc_url, summary: `none of ${ocr.total} crowd counts found on INEC's sheet` },
    });
  }
  return status;
}

// One scan pass: find unchecked crowd results, walk any states we haven't
// indexed yet, then OCR-compare each unit. Serialized; safe to call repeatedly.
export async function irevScan(maxChecks = 40) {
  if (!config.irevElectionId) return { skipped: 'no_election_id' };
  if (running) return { skipped: 'already_running' };
  running = true;
  try {
    const eid = config.irevElectionId;
    const rows = db.prepare(`
      SELECT r.pu_code, r.contest, r.votes_json FROM results r
      LEFT JOIN irev_docs d ON d.pu_code = r.pu_code AND d.election_id = ?
      WHERE r.contest = ? AND (d.checked_at IS NULL)
      LIMIT ?`).all(eid, config.irevContest, maxChecks);
    if (!rows.length) return { checked: 0 };
    // index the states these units live in (first delimitation segment)
    const needStates = [...new Set(rows
      .filter((r) => !db.prepare('SELECT 1 FROM irev_docs WHERE pu_code = ? AND election_id = ? AND doc_url IS NOT NULL').get(r.pu_code, eid))
      .map((r) => parseInt(r.pu_code.split('-')[0], 10)).filter((n) => n >= 1 && n <= 37))];
    for (const st of needStates) await walkState(eid, st);
    const out = { checked: 0, consistent: 0, mismatch: 0, other: 0 };
    for (const row of rows) {
      const s = await checkUnit(row, eid).catch(() => 'error');
      out.checked++;
      if (s === 'consistent') out.consistent++;
      else if (s === 'mismatch') out.mismatch++;
      else out.other++;
      await sleep(500);
    }
    console.log('[irev] scan', JSON.stringify(out));
    return out;
  } finally {
    running = false;
  }
}

export function irevSummary() {
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS c FROM irev_docs WHERE checked_at IS NOT NULL GROUP BY status')
      .all().map((r) => [r.status, r.c]),
  );
  return { electionId: config.irevElectionId || null, contest: config.irevContest, counts };
}
