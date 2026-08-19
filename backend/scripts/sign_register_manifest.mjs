#!/usr/bin/env node
/**
 * Sign the register pack manifest.
 *
 * WHAT THIS DEFENDS AGAINST. The packs are the offline unit list: on a phone
 * with no signal they ARE the register, with no server left to contradict them.
 * The CRC32 in each pack header catches a truncated download; it is not a
 * security check, because anyone who can serve you bytes can recompute it.
 * HTTPS covers the wire, so what is left is a compromised host, or a network
 * that terminates TLS, serving an observer a unit list with units quietly
 * renamed or missing.
 *
 * WHY THE MANIFEST AND NOT EACH PACK. A signature would not fit in the pack
 * header — it is 32 bytes, fully spent except four reserved ones — so per-pack
 * signing means a format version bump, and readHeader() REFUSES a version it
 * does not know. Every already-installed client would reject the new packs
 * until it updated. Signing the manifest instead covers all 38 packs through
 * their sha256, and touches no pack byte.
 *
 * ECDSA P-256 over SHA-256, raw IEEE P1363 — the same primitive the observer
 * signing keys and the anchor already use (backend/src/services/signatures.js),
 * so there is one algorithm in this system rather than two. The web verifies it
 * with WebCrypto, the native app with @noble/curves, both already present.
 *
 *   node scripts/sign_register_manifest.mjs --gen-key   # once, ever
 *   node scripts/sign_register_manifest.mjs             # after generating packs
 *   node scripts/sign_register_manifest.mjs --check     # verify what is on disk
 *
 * The private key lives in ~/hawkeye-secrets and never enters the repo. The
 * public key is PINNED in the clients (app/register-store.js and
 * native/src/lib/register.ts) — a key fetched from the same host it is meant to
 * authenticate would prove nothing.
 */
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REG_DIR = path.join(REPO, 'app', 'reg');
const MANIFEST = path.join(REG_DIR, 'manifest.json');
const SIG_FILE = path.join(REG_DIR, 'manifest.sig');
const KEY_FILE = process.env.REGISTER_SIGNING_KEY
  || path.join(os.homedir(), 'hawkeye-secrets', 'register-signing.key');

const argv = process.argv.slice(2);

/**
 * NORMALISE THE SIGNATURE TO LOW-S.
 *
 * An ECDSA signature (r, s) is equally valid as (r, n - s), so every signature
 * has two forms. OpenSSL — and therefore Node and WebCrypto — emits whichever
 * falls out and accepts both. Strict verifiers reject the high form as
 * malleable, and @noble/curves, which the native app verifies with, is one of
 * them BY DEFAULT.
 *
 * Left alone this is a coin flip: roughly half of all signatures verify
 * everywhere and half are rejected by the native app only. It would pass a test
 * run, then fail on some later regeneration for no visible reason. Emitting the
 * canonical low form means one artefact that every verifier accepts.
 */
const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
function toLowS(sig) {
  const r = sig.subarray(0, 32);
  let s = BigInt('0x' + sig.subarray(32).toString('hex'));
  if (s > P256_N / 2n) {
    s = P256_N - s;
    const hex = s.toString(16).padStart(64, '0');
    return Buffer.concat([r, Buffer.from(hex, 'hex')]);
  }
  return sig;
}

/** Raw uncompressed public point (0x04 ‖ X ‖ Y), base64 — what the clients pin. */
function publicPoint(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64');
}

if (argv.includes('--gen-key')) {
  if (existsSync(KEY_FILE)) {
    console.error(`REFUSING: ${KEY_FILE} already exists.`);
    console.error('Generating a second key would orphan every client pinning the first.');
    process.exit(2);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  chmodSync(KEY_FILE, 0o600);
  console.log(`private key written to ${KEY_FILE} (back this up off-machine)`);
  console.log('\nPIN THIS PUBLIC KEY in app/register-store.js and native/src/lib/register.ts:\n');
  console.log(`  ${publicPoint(publicKey)}\n`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.error(`FATAL: no manifest at ${MANIFEST}. Run build_register_packs.mjs first.`);
  process.exit(2);
}

// Sign the manifest's EXACT BYTES, not a re-serialisation of its contents. A
// canonicalisation step is another thing that can differ between the signer and
// the verifier, and this needs none: both sides hash the file as served.
const bytes = readFileSync(MANIFEST);

if (argv.includes('--check')) {
  if (!existsSync(SIG_FILE)) {
    console.error('FAIL: no manifest.sig — clients will refuse the packs and fall back to the API.');
    process.exit(1);
  }
  const pub = argv[argv.indexOf('--pub') + 1];
  if (!pub || !argv.includes('--pub')) {
    console.error('usage: --check --pub <base64 public point>');
    process.exit(2);
  }
  const pt = Buffer.from(pub, 'base64');
  const key = crypto.createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: pt.subarray(1, 33).toString('base64url'),
      y: pt.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(readFileSync(SIG_FILE, 'utf8').trim(), 'base64'));
  console.log(ok ? 'signature OK' : 'SIGNATURE INVALID');
  process.exit(ok ? 0 : 1);
}

if (!existsSync(KEY_FILE)) {
  console.error(`FATAL: no signing key at ${KEY_FILE}`);
  console.error('Run once:  node scripts/sign_register_manifest.mjs --gen-key');
  process.exit(2);
}

const privateKey = crypto.createPrivateKey(readFileSync(KEY_FILE, 'utf8'));
const sig = toLowS(crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
writeFileSync(SIG_FILE, `${sig.toString('base64')}\n`);

const manifest = JSON.parse(bytes.toString('utf8'));
const missing = [manifest.index, ...Object.values(manifest.states)].filter((e) => !e.sha256).length;

console.log(`signed ${path.relative(REPO, MANIFEST)} (${bytes.length} bytes)`);
console.log(`  -> ${path.relative(REPO, SIG_FILE)}  (${sig.length}-byte P-256 signature)`);
console.log(`  registerVersion ${manifest.registerVersion}, ${Object.keys(manifest.states).length + 1} packs`);
if (missing) {
  console.error(`\nWARNING: ${missing} pack entries have no sha256 — the signature covers the`);
  console.error('manifest but nothing ties those packs to it. Regenerate with the current generator.');
  process.exit(1);
}
console.log(`  public key: ${publicPoint(crypto.createPublicKey(privateKey))}`);
