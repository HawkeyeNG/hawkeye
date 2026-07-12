// Crowd arbitration — the Public Docket (docs/CROWD-ARBITRATION.md).
// AI/statistics only FLAG; the verified crowd decides, on the public record.
// Flag events, case openings and resolutions go on the docket's own append-only
// hash chain (docket_ledger), whose head is folded into the Rekor anchor — the
// arbitration is as rollback-proof as the results it judges.
import crypto from 'node:crypto';
import { db, contests } from '../db.js';
import { config } from '../config.js';
import { recomputeResult } from './aggregate.js';
import { notifyMaster } from './notify.js';

// Live arbitration is enabled explicitly (DOCKET_AUTO_OPEN_CASES) or implicitly
// whenever the active election is a mock/test run — so a demo/pilot exercises the
// full flag → case → verdict path immediately, while the real general election
// keeps disputes batched until after polls close.
const autoOpenCases = () =>
  config.docketAutoOpenCases || /\b(mock|test)\b/i.test(contests[0]?.election || '');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);

export const QUORUM = 50;          // minimum verdicts before a case can resolve
export const SUPERMAJORITY = 2 / 3; // share the computed verdict must reach
export const WINDOW_DAYS = 14;      // review window per case

export function appendDocket(kind, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const last = db.prepare('SELECT entry_hash FROM docket_ledger ORDER BY id DESC LIMIT 1').get();
  const prevHash = last ? last.entry_hash : GENESIS;
  const entryHash = sha256(prevHash + kind + '|' + payload);
  db.prepare(
    'INSERT INTO docket_ledger (kind, payload, prev_hash, entry_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, payload, prevHash, entryHash, Date.now());
  return entryHash;
}

export function docketHead() {
  const last = db.prepare('SELECT entry_hash FROM docket_ledger ORDER BY id DESC LIMIT 1').get();
  return last ? last.entry_hash : GENESIS;
}

// A high-severity flag lands: put it on the docket chain immediately (the
// tamper-evident "flagged at T"), and refresh the result so the disputed badge
// travels with it everywhere from this moment on.
export function onFlag({ id, type, severity, puCode, contest, detail }) {
  if (severity !== 'high' || !puCode || !contest) return;
  appendDocket('flag', { flagId: id, type, puCode, contest, summary: detail?.summary || '' });
  try { recomputeResult(db, puCode, contest); } catch { /* result may not exist yet */ }
  if (autoOpenCases()) { try { openCaseFor(puCode, contest); } catch { /* best-effort */ } }
}

// Open ONE arbitration case for a (unit, contest) that carries open high flags —
// the single-case path used both by live auto-open (onFlag) and the post-election
// batch (openCases). Idempotent: INSERT OR IGNORE means a second flag on a unit
// that's already in dispute won't open a duplicate case.
export function openCaseFor(puCode, contest, windowDays = WINDOW_DAYS) {
  const flags = db.prepare(
    `SELECT id FROM discrepancies WHERE severity = 'high' AND status = 'open' AND pu_code = ? AND contest = ?`,
  ).all(puCode, contest);
  if (!flags.length) return null;
  const now = Date.now();
  const closes = now + windowDays * 86_400_000;
  const info = db.prepare(
    `INSERT OR IGNORE INTO cases (pu_code, contest, flag_ids, status, opened_at, closes_at) VALUES (?, ?, ?, 'open', ?, ?)`,
  ).run(puCode, contest, JSON.stringify(flags.map((f) => f.id)), now, closes);
  if (!info.changes) return null;
  const caseId = info.lastInsertRowid;
  appendDocket('case_open', { caseId, puCode, contest, flagIds: flags.map((f) => f.id).join(','), closesAt: closes });
  recomputeResult(db, puCode, contest);
  import('./notifications.js').then((n) => n.noteUnitSavers(puCode, {
    kind: 'case', title: 'A result at your unit is in dispute',
    body: `${puCode} · ${contest} — open for crowd review. Judge the evidence.`,
    url: `https://hawkeye.com.ng/case.html?id=${caseId}`,
  })).catch(() => {});
  notifyMaster(`⚖️ docket: case #${caseId} opened for ${puCode} ${contest}`);
  return caseId;
}

// After the election: every (unit, contest) still carrying an open high-severity
// flag becomes a public case with a fixed review window.
export function openCases(windowDays = WINDOW_DAYS) {
  const flagged = db.prepare(`
    SELECT pu_code, contest, GROUP_CONCAT(id) AS ids FROM discrepancies
    WHERE severity = 'high' AND status = 'open' AND pu_code IS NOT NULL AND contest IS NOT NULL
    GROUP BY pu_code, contest`).all();
  const now = Date.now();
  const closes = now + windowDays * 86_400_000;
  let opened = 0;
  for (const f of flagged) {
    const info = db.prepare(`
      INSERT OR IGNORE INTO cases (pu_code, contest, flag_ids, status, opened_at, closes_at)
      VALUES (?, ?, ?, 'open', ?, ?)`)
      .run(f.pu_code, f.contest, JSON.stringify(f.ids.split(',').map(Number)), now, closes);
    if (info.changes) {
      opened++;
      const id = info.lastInsertRowid;
      appendDocket('case_open', { caseId: id, puCode: f.pu_code, contest: f.contest, flagIds: f.ids, closesAt: closes });
      recomputeResult(db, f.pu_code, f.contest);
      import('./notifications.js').then((n) => n.noteUnitSavers(f.pu_code, {
        kind: 'case', title: 'A result at your unit is in dispute',
        body: `${f.pu_code} · ${f.contest} — open for crowd review. Judge the evidence.`,
        url: `https://hawkeye.com.ng/case.html?id=${id}`,
      })).catch(() => {});
    }
  }
  if (opened) notifyMaster(`⚖️ docket: ${opened} case(s) opened for public review`);
  return { opened, total: flagged.length };
}

// Published verdict rule — computed from the structured answers, never chosen.
// `flags` = one yes/no/unsure PER flag on the case (each may be wrong differently):
//   sheet not authentic OR figures don't match          -> fraudulent
//   authentic AND figures match AND EVERY flag rejected -> legit
//   anything else                                       -> inconclusive
export function computeVerdict(a) {
  if (a.sheet === 'no' || a.counts === 'no') return 'fraudulent';
  const flagAnswers = Object.values(a.flags || {});
  if (a.sheet === 'yes' && a.counts === 'yes'
      && flagAnswers.length && flagAnswers.every((v) => v === 'no')) return 'legit';
  return 'inconclusive';
}

export function verdictTally(caseId) {
  const rows = db.prepare(
    'SELECT verdict, COUNT(*) AS c FROM verdicts WHERE case_id = ? GROUP BY verdict').all(caseId);
  const t = { legit: 0, fraudulent: 0, inconclusive: 0, total: 0 };
  for (const r of rows) { t[r.verdict] = r.c; t.total += r.c; }
  return t;
}

// On resolution, notify everyone who judged the case (distinct jurors) plus the
// unit's savers, deduped so nobody gets it twice.
function noteVoters(n, caseId, puCode, note) {
  const seen = new Set();
  for (const { observer_id } of db.prepare('SELECT DISTINCT observer_id FROM verdicts WHERE case_id = ?').all(caseId)) {
    if (!seen.has(observer_id)) { seen.add(observer_id); n.pushNote(observer_id, note); }
  }
  for (const { observer_id } of db.prepare("SELECT DISTINCT s.observer_id FROM saved_units s JOIN observers o ON o.id = s.observer_id AND o.status = 'active' WHERE s.pu_code = ?").all(puCode)) {
    if (!seen.has(observer_id)) { seen.add(observer_id); n.pushNote(observer_id, note); }
  }
}

// Mechanical resolution, run on an interval. Quorum + supermajority on a
// decisive verdict resolves the case; anything else past its window stays
// unresolved (still disputed, revisitable). Resolutions are chained + notified.
export function resolveDueCases() {
  const due = db.prepare("SELECT * FROM cases WHERE status = 'open' AND closes_at <= ?").all(Date.now());
  let resolved = 0;
  for (const c of due) {
    const t = verdictTally(c.id);
    let outcome = 'unresolved';
    if (t.total >= QUORUM) {
      if (t.fraudulent / t.total >= SUPERMAJORITY) outcome = 'upheld';
      else if (t.legit / t.total >= SUPERMAJORITY) outcome = 'cleared';
    }
    db.prepare('UPDATE cases SET status = ?, resolved_at = ? WHERE id = ?').run(outcome, Date.now(), c.id);
    if (outcome === 'cleared') {
      // the crowd cleared it: resolve the flags so the badge lifts — the false
      // flag itself stays on the public record (and on the docket chain).
      db.prepare("UPDATE discrepancies SET status = 'resolved_cleared' WHERE id IN ("
        + JSON.parse(c.flag_ids).map(() => '?').join(',') + ')').run(...JSON.parse(c.flag_ids));
    } else if (outcome === 'upheld') {
      db.prepare("UPDATE discrepancies SET status = 'resolved_upheld' WHERE id IN ("
        + JSON.parse(c.flag_ids).map(() => '?').join(',') + ')').run(...JSON.parse(c.flag_ids));
    }
    appendDocket('resolution', { caseId: c.id, puCode: c.pu_code, contest: c.contest, outcome, tally: t });
    recomputeResult(db, c.pu_code, c.contest);
    notifyMaster(`⚖️ case #${c.id} ${c.pu_code} ${c.contest}: ${outcome} (${t.fraudulent}F/${t.legit}L/${t.inconclusive}I of ${t.total})`);
    const say = { upheld: 'struck by the crowd (fraud upheld)', cleared: 'cleared by the crowd', unresolved: 'left unresolved (no quorum)' }[outcome] || outcome;
    import('./notifications.js').then((n) => noteVoters(n, c.id, c.pu_code, {
      kind: 'case', title: 'A case you judged is resolved',
      body: `${c.pu_code} · ${c.contest} — ${say}.`,
      url: `https://hawkeye.com.ng/case.html?id=${c.id}`,
    })).catch(() => {});
    resolved++;
  }
  return { resolved };
}
