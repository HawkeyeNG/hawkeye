// BUILD THE PAIRS: one row per polling unit we reported from, carrying our
// account and INEC's side by side.
//
// Only units WE reported from, by definition — there is nothing to compare at a
// unit nobody covered. That is also the honest scope of this check: Osun drew 12
// observers against 3,763 units, so the pair set is small and the units INEC
// published that nobody watched are a separate question (the standalone audit,
// scripts/audit_irev.mjs, which needs no observers at all).
import crypto from 'node:crypto';
import { db } from '../db.js';

const H = { 'user-agent': 'Mozilla/5.0' };

/**
 * PRESENCE IS A FINDING, NOT A GAP.
 *
 *   both       — we reported, INEC published. The comparable case.
 *   ours_only  — we reported, INEC has published nothing for that unit YET.
 *                On election night that is ordinary; days later it is the
 *                single most interesting row on the board.
 *
 * "theirs_only" and "neither" cannot appear here because the set starts from our
 * reports; they belong to the standalone audit.
 */
export function buildPairs({ irevId, contest, limit = 500 }) {
  const now = Date.now();
  const rows = db.prepare(`
    /* results is an AGGREGATE per (unit, contest) — no submission_id, no
       created_at. The pair points at the unit, and the individual submissions
       behind it stay reachable through the ledger. */
    SELECT r.pu_code, r.votes_json
      FROM results r
     WHERE r.contest = ?
       AND NOT EXISTS (SELECT 1 FROM result_pairs p
                        WHERE p.irev_id = ? AND p.pu_code = r.pu_code AND p.contest = r.contest)
     LIMIT ?`).all(contest, irevId, limit);
  const put = db.prepare(`
    INSERT OR IGNORE INTO result_pairs
      (irev_id, contest, pu_code, submission_id, ours_json, presence, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ours_only', 'open', ?, ?)`);
  const run = db.transaction(() => {
    for (const r of rows) put.run(irevId, contest, r.pu_code, null, r.votes_json, now, now);
  });
  run();
  return rows.length;
}

/**
 * Attach INEC's side where irev_docs already knows the sheet URL.
 *
 * The sha256 is of the bytes INEC served — that hash is what makes the sheet
 * evidence rather than a claim, and it is taken before anything resizes or
 * re-encodes the image. doc_seen_at is kept because a sheet timestamped before
 * polls closed is worth a look whatever its figures say.
 */
export async function attachSheets({ irevId, limit = 50, fetchImpl = fetch }) {
  const todo = db.prepare(`
    SELECT p.id, p.pu_code, d.doc_url
      FROM result_pairs p
      JOIN irev_docs d ON d.pu_code = p.pu_code AND d.election_id = p.irev_id
     WHERE p.doc_url IS NULL AND d.doc_url IS NOT NULL
     LIMIT ?`).all(limit);
  let done = 0;
  for (const t of todo) {
    try {
      const res = await fetchImpl(t.doc_url, { headers: H });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      db.prepare(`UPDATE result_pairs
         SET doc_url = ?, doc_sha256 = ?, doc_seen_at = ?, presence = 'both', updated_at = ?
       WHERE id = ?`).run(t.doc_url, sha, Date.now(), Date.now(), t.id);
      done += 1;
    } catch { /* leave it for the next pass */ }
  }
  return done;
}

export const pairSummary = (irevId) => ({
  total: db.prepare('SELECT COUNT(*) n FROM result_pairs WHERE irev_id = ?').get(irevId).n,
  byPresence: db.prepare('SELECT presence, COUNT(*) n FROM result_pairs WHERE irev_id = ? GROUP BY presence').all(irevId),
  byState: db.prepare('SELECT state, COUNT(*) n FROM result_pairs WHERE irev_id = ? GROUP BY state').all(irevId),
});
