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
import { verifyChain } from './ledger.js';
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

  const last = db.prepare('SELECT head_hash, collation_head FROM anchors ORDER BY id DESC LIMIT 1').get();
  if (!force && last && last.head_hash === chain.head && last.collation_head === collHead) {
    return { skipped: 'unchanged' };
  }

  const day = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO anchors (day, head_hash, collation_head, entries, collation_entries, tweet, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(day, chain.head, collHead, chain.entries, collCount, null, now);

  // Canonical artifact the verifier reconstructs from /api/anchors and re-hashes.
  const artifact = `hawkeye-ledger-anchor|v1|day=${day}|head=${chain.head}|entries=${chain.entries}`
    + `|collationHead=${collHead}|collationEntries=${collCount}|at=${new Date(now).toISOString()}`;
  const receipt = await publishToRekor(artifact);
  if (receipt) {
    db.prepare('UPDATE anchors SET rekor_uuid = ?, rekor_log_index = ?, rekor_time = ?, rekor_artifact = ? WHERE id = ?')
      .run(receipt.uuid, receipt.logIndex, receipt.integratedTime, artifact, info.lastInsertRowid);
  }

  notifyMaster(`⚓ ledger anchor — ${chain.entries} PU / ${collCount} collation entries · head ${chain.head.slice(0, 12)}…`
    + (receipt ? ` · Rekor #${receipt.logIndex}` : ' · Rekor publish pending'));
  return { anchored: true, entries: chain.entries, head: chain.head, rekor: receipt };
}
