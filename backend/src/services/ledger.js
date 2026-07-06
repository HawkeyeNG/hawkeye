import crypto from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Tamper-evident append-only chain: each accepted submission's entry_hash commits to
// everything before it. The head hash is what gets anchored on-chain
// (HawkeyeLedger.anchorLedger) so not even the server operator can rewrite history
// without the anchor exposing it.
export function nextEntry(db, ledgerPayload) {
  const last = db.prepare('SELECT entry_hash FROM submissions ORDER BY id DESC LIMIT 1').get();
  const prevHash = last ? last.entry_hash : GENESIS_HASH;
  return { prevHash, entryHash: sha256(prevHash + ledgerPayload) };
}

export function verifyChain(db) {
  const rows = db
    .prepare('SELECT id, ledger_payload, prev_hash, entry_hash FROM submissions ORDER BY id')
    .all();
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev || sha256(prev + row.ledger_payload) !== row.entry_hash) {
      return { ok: false, brokenAtId: row.id, entries: rows.length };
    }
    prev = row.entry_hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}
