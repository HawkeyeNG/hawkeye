// Daily ledger anchoring: record the hash-chain heads (PU + collation) in the
// anchors table, and Telegram them to the owner as a timestamped snapshot. This
// is the internal integrity log; external publication (previously an X tweet) was
// removed with the social integration — reintroduce an off-server anchor here if
// funded. A broken chain raises an immediate alert.
import { db } from '../db.js';
import { verifyChain } from './ledger.js';
import { notifyMaster } from './notify.js';

export async function runAnchor(force = false) {
  const chain = verifyChain(db);
  if (!chain.ok) {
    notifyMaster(`🚨 LEDGER CHAIN VERIFICATION FAILED at entry id ${chain.brokenAtId} — investigate immediately.`);
    return { error: 'chain_broken', brokenAtId: chain.brokenAtId };
  }
  const collLast = db.prepare('SELECT entry_hash FROM collation_reports ORDER BY id DESC LIMIT 1').get();
  const collHead = collLast?.entry_hash || '0'.repeat(64);
  const collCount = db.prepare('SELECT COUNT(*) AS c FROM collation_reports').get().c;

  const last = db.prepare('SELECT head_hash, collation_head FROM anchors ORDER BY id DESC LIMIT 1').get();
  if (!force && last && last.head_hash === chain.head && last.collation_head === collHead) {
    return { skipped: 'unchanged' };
  }

  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO anchors (day, head_hash, collation_head, entries, collation_entries, tweet, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(day, chain.head, collHead, chain.entries, collCount, null, Date.now());
  notifyMaster(`⚓ ledger anchor — ${chain.entries} PU / ${collCount} collation entries · head ${chain.head.slice(0, 12)}…`);
  return { anchored: true, entries: chain.entries, head: chain.head };
}
