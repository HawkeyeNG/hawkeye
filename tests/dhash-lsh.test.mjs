/**
 * The banded dhash index must return EXACTLY the verdict the old full scan did.
 *
 *   node tests/dhash-lsh.test.mjs
 *
 * The old guard loaded every stored dhash on every submission and Hamming-compared
 * in JS — 3.18M rows per insert at the 2027 ceiling. The replacement looks
 * candidates up by exact band match first. That is only safe because of a
 * pigeonhole argument (<=T differing bits touch at most T of T+1 bands, so one
 * band always matches exactly), and a pigeonhole argument is exactly the kind of
 * thing that is right on paper and off by one in code.
 *
 * So this does not test the argument. It runs BOTH implementations over the same
 * data and asserts they never disagree — including on the same-observer-same-unit
 * exemption, which is the part a reviewer is most likely to drop.
 */
import assert from 'node:assert';
import { hammingDistance, dhashBandTokens, dhashBandCount } from '../backend/src/services/images.js';

const hex = (v) => v.toString(16).padStart(16, '0');
const rnd = () => { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 16n) | BigInt(Math.floor(Math.random() * 65536)); return v; };
const flip = (v, n) => { const seen = new Set(); let out = v;
  while (seen.size < n) { const b = Math.floor(Math.random() * 64); if (seen.has(b)) continue; seen.add(b); out ^= (1n << BigInt(b)); }
  return out; };

// ---- the two implementations, over an identical corpus ----------------------
const oldScan = (rows, a, b, me, pu, T) => rows.some(
  (r) => !(r.observer_id === me && r.pu_code === pu)
      && (hammingDistance(r.h, a) <= T || hammingDistance(r.h, b) <= T));

const newIndexed = (rows, a, b, me, pu, T) => {
  const want = new Set([...dhashBandTokens(a, T), ...dhashBandTokens(b, T)]);
  const seen = new Set(); const cand = [];
  for (const r of rows) {                       // stands in for the indexed IN lookup
    if (seen.has(r.h)) continue;
    if (dhashBandTokens(r.h, T).some((t) => want.has(t))) { seen.add(r.h); cand.push(r); }
  }
  return cand.some((r) => !(r.observer_id === me && r.pu_code === pu)
      && (hammingDistance(r.h, a) <= T || hammingDistance(r.h, b) <= T));
};

let checked = 0, fired = 0, disagreements = 0, candTotal = 0, rowTotal = 0;

for (const T of [0, 1, 2, 3, 4, 5, 8]) {
  // A corpus with plenty of deliberate near-misses at and around the threshold,
  // because uniformly random 64-bit hashes are ~32 apart and would never fire.
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const base = rnd();
    rows.push({ h: hex(base), observer_id: 1 + (i % 7), pu_code: `PU-${i % 11}` });
    if (i % 3 === 0) rows.push({ h: hex(flip(base, (i % 9))), observer_id: 1 + (i % 7), pu_code: `PU-${i % 11}` });
  }
  for (let trial = 0; trial < 400; trial++) {
    const pick = rows[Math.floor(Math.random() * rows.length)];
    const src = BigInt('0x' + pick.h);
    // Probe hashes spanning below, at and above the threshold, plus pure randoms.
    const a = hex(trial % 4 === 0 ? rnd() : flip(src, Math.floor(Math.random() * (T + 3))));
    const b = hex(rnd());
    const me = 1 + (trial % 7);
    const pu = `PU-${trial % 11}`;
    const o = oldScan(rows, a, b, me, pu, T);
    const n = newIndexed(rows, a, b, me, pu, T);
    if (o !== n) { disagreements++; console.log(`DISAGREE T=${T} a=${a} b=${b} old=${o} new=${n}`); }
    if (o) fired++;
    checked++;
    rowTotal += rows.length;
    const want = new Set([...dhashBandTokens(a, T), ...dhashBandTokens(b, T)]);
    candTotal += rows.filter((r) => dhashBandTokens(r.h, T).some((t) => want.has(t))).length;
  }
}

// ---- controls: a test that cannot fail is not a test ------------------------
// 1. the corpus must actually trigger the guard, or "they agree" is vacuous
assert.ok(fired > 100, `CONTROL FAILED: guard fired only ${fired}/${checked} times — corpus too sparse to be testing anything`);
// 2. the index must actually be narrowing, or it is just the old scan in disguise
const ratio = candTotal / rowTotal;
assert.ok(ratio < 0.5, `CONTROL FAILED: band lookup returned ${(ratio * 100).toFixed(1)}% of rows — not narrowing`);
// 3. a DELIBERATELY BROKEN index (too few bands) must be caught by this harness
const broken = (rows, a, b, me, pu, T) => {
  const want = new Set(dhashBandTokens(a, 0).concat(dhashBandTokens(b, 0)));  // 1 band = exact match only
  return rows.filter((r) => dhashBandTokens(r.h, 0).some((t) => want.has(t)))
    .some((r) => !(r.observer_id === me && r.pu_code === pu)
      && (hammingDistance(r.h, a) <= T || hammingDistance(r.h, b) <= T));
};
let brokenCaught = 0;
{
  const T = 4; const rows = [];
  for (let i = 0; i < 200; i++) { const base = rnd();
    rows.push({ h: hex(base), observer_id: 2, pu_code: 'PU-X' });
    rows.push({ h: hex(flip(base, 3)), observer_id: 2, pu_code: 'PU-X' }); }
  for (let t = 0; t < 300; t++) {
    const pick = rows[Math.floor(Math.random() * rows.length)];
    const a = hex(flip(BigInt('0x' + pick.h), 3)); const b = hex(rnd());
    if (oldScan(rows, a, b, 9, 'PU-Z', T) !== broken(rows, a, b, 9, 'PU-Z', T)) brokenCaught++;
  }
}
assert.ok(brokenCaught > 0, 'CONTROL FAILED: harness did not notice an under-banded index — it cannot detect false negatives');

console.log(`bands: T=4 -> ${dhashBandCount(4)} bands`);
console.log(`${checked} probes across 7 thresholds; guard fired ${fired}x; ZERO disagreements`);
console.log(`band lookup examined ${(ratio * 100).toFixed(1)}% of rows (old scan: 100%)`);
console.log(`control: an under-banded index disagreed ${brokenCaught}x, so this harness does detect false negatives`);
assert.strictEqual(disagreements, 0, `${disagreements} disagreements between old scan and banded index`);
console.log('PASS — the banded index returns the old verdict on every case.');
