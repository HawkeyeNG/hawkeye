// Minimal binary Merkle tree over an ordered list of hex leaf hashes. Used to
// batch every per-race subchain head into ONE root per anchor cycle, so a single
// Rekor entry timestamps all ~1,500 races at once — yet any single race keeps a
// compact inclusion proof, verifiable in isolation during a dispute.
//
// Convention (Bitcoin-style): an odd node at a level is paired with itself.
// Node hash = sha256(left || right), all hex. Deliberately dependency-free and
// byte-simple so a browser verifier can reimplement it exactly.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const EMPTY_ROOT = '0'.repeat(64);

const parentLevel = (level) => {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    const a = level[i];
    const b = i + 1 < level.length ? level[i + 1] : level[i]; // odd → duplicate
    next.push(sha256(a + b));
  }
  return next;
};

export function merkleRoot(leaves) {
  if (!leaves.length) return EMPTY_ROOT;
  let level = leaves.slice();
  while (level.length > 1) level = parentLevel(level);
  return level[0];
}

// Inclusion proof for the leaf at `index`: at each level, the sibling's hash and
// which side it sits on. Fold it back with verifyProof to recover the root.
export function merkleProof(leaves, index) {
  const proof = [];
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : (idx + 1 < level.length ? idx + 1 : idx);
    proof.push({ hash: level[sibIdx], side: isRight ? 'left' : 'right' });
    level = parentLevel(level);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(leafHash, proof, root) {
  let h = leafHash;
  for (const step of proof) {
    h = step.side === 'left' ? sha256(step.hash + h) : sha256(h + step.hash);
  }
  return h === root;
}

// Canonical leaf material for a race subchain — pinned to its key, head and count.
export const raceLeaf = (r) => sha256(`race|v1|${r.raceKey}|${r.head}|${r.entries}`);
