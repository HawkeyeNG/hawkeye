// Daily ledger anchoring. Records the hash-chain heads (PU + collation) locally,
// Telegrams the owner a timestamped snapshot, AND publishes the head to the
// public Sigstore Rekor transparency log — an append-only Merkle log we do NOT
// control. That external anchor is what makes a full-database rollback
// detectable: a restored DB cannot reproduce a Rekor entry that already exists
// at a fixed log index and integrated time. A broken chain raises an alert.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { verifyChain, raceSubchains } from './ledger.js';
import { merkleRoot, merkleProof, raceLeaf } from './merkle.js';
import { notifyMaster } from './notify.js';

const REKOR = 'https://rekor.sigstore.dev';

// Persistent ECDSA P-256 anchor key (stored beside the DB, gitignored). The
// public key is published via /api/anchors so anyone can verify the signature.
function anchorKey() {
  const p = path.join(path.dirname(config.dbPath), 'anchor_key.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* generate below */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kp = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  fs.writeFileSync(p, JSON.stringify(kp), { mode: 0o600 });
  return kp;
}
export function anchorPublicKey() { return anchorKey().publicPem; }

// Publish one anchor artifact to Rekor. Best-effort: returns the receipt or null.
async function publishToRekor(artifact) {
  try {
    const kp = anchorKey();
    const sig = crypto.sign('sha256', Buffer.from(artifact), crypto.createPrivateKey(kp.privatePem));
    const sha = crypto.createHash('sha256').update(artifact).digest('hex');
    const body = {
      apiVersion: '0.0.1', kind: 'hashedrekord',
      spec: {
        signature: { content: sig.toString('base64'), publicKey: { content: Buffer.from(kp.publicPem).toString('base64') } },
        data: { hash: { algorithm: 'sha256', value: sha } },
      },
    };
    const res = await fetch(`${REKOR}/api/v1/log/entries`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 201) return null;
    const obj = await res.json();
    const uuid = Object.keys(obj)[0];
    return { uuid, logIndex: obj[uuid]?.logIndex ?? null, integratedTime: obj[uuid]?.integratedTime ?? null };
  } catch { return null; }
}

export async function runAnchor(force = false) {
  const chain = verifyChain(db);
  if (!chain.ok) {
    notifyMaster(`🚨 LEDGER CHAIN VERIFICATION FAILED at entry id ${chain.brokenAtId} — investigate immediately.`);
    return { error: 'chain_broken', brokenAtId: chain.brokenAtId };
  }
  const collLast = db.prepare('SELECT entry_hash FROM collation_reports ORDER BY id DESC LIMIT 1').get();
  const collHead = collLast?.entry_hash || '0'.repeat(64);
  const collCount = db.prepare('SELECT COUNT(*) AS c FROM collation_reports').get().c;

  // Per-race subchains → one Merkle root batching every race this cycle. A single
  // Rekor entry thus timestamps all ~1,500 races at once, while each race keeps a
  // compact inclusion proof (stored below) that verifies against this root alone.
  const races = raceSubchains(db);
  const leaves = races.map(raceLeaf);
  const racesRoot = merkleRoot(leaves);

  const last = db.prepare('SELECT head_hash, collation_head, races_root FROM anchors ORDER BY id DESC LIMIT 1').get();
  if (!force && last && last.head_hash === chain.head && last.collation_head === collHead
      && last.races_root === racesRoot) {
    return { skipped: 'unchanged' };
  }

  const day = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO anchors (day, head_hash, collation_head, entries, collation_entries, tweet, races_root, races_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(day, chain.head, collHead, chain.entries, collCount, null, racesRoot, races.length, now);
  const anchorId = info.lastInsertRowid;

  // Persist each race's subchain head + its Merkle inclusion proof so a single
  // disputed race can be verified in isolation (GET /api/anchors/:id/races/:key).
  const insRace = db.prepare(`
    INSERT INTO anchor_races (anchor_id, race_key, race_head, entries, leaf_index, leaf_hash, proof_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    races.forEach((r, i) => {
      insRace.run(anchorId, r.raceKey, r.head, r.entries, i, leaves[i],
        JSON.stringify(merkleProof(leaves, i)));
    });
  })();

  // Canonical artifact the verifier reconstructs from /api/anchors and re-hashes.
  // racesRoot binds the whole per-race batch into the one signed, Rekor-logged line.
  const artifact = `hawkeye-ledger-anchor|v1|day=${day}|head=${chain.head}|entries=${chain.entries}`
    + `|collationHead=${collHead}|collationEntries=${collCount}`
    + `|racesRoot=${racesRoot}|races=${races.length}|at=${new Date(now).toISOString()}`;
  const receipt = await publishToRekor(artifact);
  if (receipt) {
    db.prepare('UPDATE anchors SET rekor_uuid = ?, rekor_log_index = ?, rekor_time = ?, rekor_artifact = ? WHERE id = ?')
      .run(receipt.uuid, receipt.logIndex, receipt.integratedTime, artifact, anchorId);
  }

  notifyMaster(`⚓ ledger anchor — ${chain.entries} PU / ${collCount} collation entries · ${races.length} races · head ${chain.head.slice(0, 12)}…`
    + (receipt ? ` · Rekor #${receipt.logIndex}` : ' · Rekor publish pending'));
  return { anchored: true, entries: chain.entries, head: chain.head, races: races.length, racesRoot, rekor: receipt };
}
