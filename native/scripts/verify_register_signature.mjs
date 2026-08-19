#!/usr/bin/env node
/**
 * Prove the NATIVE manifest verifier accepts the real signature and refuses
 * tampering — the same four attacks the web verifier is tested against.
 *
 * A verifier that never rejects anything is worse than no verifier: it looks
 * like protection while providing none. This runs the exact primitives
 * src/lib/register.ts uses (@noble/curves P-256, @noble/hashes SHA-256) against
 * the real app/reg/ files.
 *
 *   node scripts/verify_register_signature.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REG = path.join(REPO, 'app', 'reg');

// Must stay identical to REGISTER_PUBLIC_KEY in src/lib/register.ts and
// app/register-store.js. If they drift, the app rejects its own packs.
const PUB = 'BPEt4J9qwyTe0JI1ykyg7swuUMTsXp0orbcLV9pHr4m7liHXDtr4pzdUaMkfZWX61C+cpdKe+hg4eGnpW3Q3cLU=';

const b64 = (s) => new Uint8Array(Buffer.from(s.trim(), 'base64'));
const hex = (b) => Buffer.from(b).toString('hex');
const verify = (bytes, sig) => {
  try { return p256.verify(b64(sig), bytes, b64(PUB), { prehash: true, lowS: false }); } catch { return false; }
};

const bytes = new Uint8Array(readFileSync(path.join(REG, 'manifest.json')));
const sig = readFileSync(path.join(REG, 'manifest.sig'), 'utf8');
const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));

let failed = 0;
const check = (label, expected, actual) => {
  const ok = expected === actual;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(38)} ${actual ? 'accepted' : 'refused'}`);
  if (!ok) failed++;
};

check('real manifest + real signature', true, verify(bytes, sig));

const flipped = new Uint8Array(bytes); flipped[40] ^= 0x01;
check('manifest byte flipped', false, verify(flipped, sig));

const badSig = sig.trim().split('');
badSig[10] = badSig[10] === 'A' ? 'B' : 'A';
check('signature byte flipped', false, verify(bytes, badSig.join('')));

check('empty signature', false, verify(bytes, ''));

// The signer emits the canonical low-S form. If a regeneration ever emits the
// high form, strict verifiers elsewhere would start refusing it, so assert it.
{
  const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
  const S = BigInt('0x' + Buffer.from(b64(sig).subarray(32)).toString('hex'));
  check('signature is canonical (low-S)', true, S <= N / 2n);
}

// every pack must hash to what the signed manifest says
let packsOk = 0, packsBad = 0;
for (const e of [manifest.index, ...Object.values(manifest.states)]) {
  if (!e.sha256) { packsBad++; continue; }
  const b = new Uint8Array(readFileSync(path.join(REG, e.file)));
  if (hex(sha256(b)) === e.sha256) packsOk++; else packsBad++;
}
console.log(`${packsBad ? 'FAIL' : 'ok  '} ${'every pack matches its manifest sha256'.padEnd(38)} ${packsOk} ok, ${packsBad} bad`);
if (packsBad) failed++;

// and a tampered pack must NOT
const first = Object.values(manifest.states)[0];
const tampered = new Uint8Array(readFileSync(path.join(REG, first.file)));
tampered[tampered.length - 20] ^= 0xff;
check('tampered pack matches its sha256', false, hex(sha256(tampered)) === first.sha256);

process.exit(failed ? 1 : 0);
