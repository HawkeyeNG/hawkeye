import crypto from 'node:crypto';
import { raceKey } from './scope.js';

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

// Derived per-race subchains for Merkle-batched anchoring. Each race =
// (contest, resolved scope). Its head folds that race's global entry_hashes in
// insertion order, so the subchain is pinned to the SAME entries as the global
// chain — the two cannot disagree, and no extra columns are written on the hot
// submission path (this is computed only at anchor time). Returns races sorted
// by key so the Merkle leaf order is deterministic and reproducible by anyone.
export function raceSubchains(db) {
  const rows = db.prepare(`
    SELECT s.contest, s.entry_hash,
           p.state, p.senatorial, p.federal_constituency, p.lga
    FROM submissions s JOIN polling_units p ON p.pu_code = s.pu_code
    ORDER BY s.id`).all();
  const byRace = new Map();
  for (const r of rows) {
    const key = raceKey(r, r.contest);
    if (!key) continue; // contest not applicable at this unit
    const cur = byRace.get(key) || { head: GENESIS_HASH, entries: 0 };
    cur.head = sha256(cur.head + r.entry_hash);
    cur.entries += 1;
    byRace.set(key, cur);
  }
  return [...byRace.entries()]
    .map(([k, v]) => ({ raceKey: k, head: v.head, entries: v.entries }))
    .sort((a, b) => (a.raceKey < b.raceKey ? -1 : a.raceKey > b.raceKey ? 1 : 0));
}

// ---- Chain verification that does not stop the server ------------------------
//
// WHY. verifyChain() above reads EVERY row and re-hashes the whole chain in one
// synchronous pass. That is correct, and it is what makes the ledger checkable —
// but better-sqlite3 is synchronous and this process has one event loop, so at
// election-night volume (up to ~1.59M entries) a single call freezes every other
// request for seconds. `GET /api/ledger/verify` was unauthenticated, so any
// anonymous caller could hold the server down in a loop, on the one night it
// matters, against the endpoint the whole project's credibility rests on.
//
// This is the same computation, walked in batches with a yield between them, so
// submissions keep being accepted while it runs. It is deliberately NOT
// incremental: an incremental check that trusts its own earlier result cannot
// detect tampering with an OLD row, which is the exact thing the chain exists to
// detect. Every sweep re-reads from the genesis hash.
export async function verifyChainAsync(db, batch = 2000) {
  const stmt = db.prepare(
    'SELECT id, ledger_payload, prev_hash, entry_hash FROM submissions WHERE id > ? ORDER BY id LIMIT ?',
  );
  let prev = GENESIS_HASH;
  let lastId = 0;
  let entries = 0;
  for (;;) {
    const rows = stmt.all(lastId, batch);
    if (!rows.length) break;
    for (const row of rows) {
      if (row.prev_hash !== prev || sha256(prev + row.ledger_payload) !== row.entry_hash) {
        return { ok: false, brokenAtId: row.id, entries };
      }
      prev = row.entry_hash;
      entries += 1;
      lastId = row.id;
    }
    // Hand the loop back between batches. Without this the batching is cosmetic
    // and the stall is exactly as long as before.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { ok: true, entries, head: prev };
}
