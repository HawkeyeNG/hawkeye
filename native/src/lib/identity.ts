/**
 * Device identity — the native twin of the web app's WebCrypto identity.
 *
 * The backend binds an observer to an EC P-256 keypair (public half stored as
 * a JWK) plus a 64-hex device id. Expo Go has no WebCrypto keygen, so keys
 * come from @noble/curves (pure JS, audited); proven against the backend's
 * exact validator and verifyObserverSignature (sha256 + ieee-p1363):
 * noble sign -> node crypto.verify === VERIFIED.
 *
 * Private key + device id live in expo-secure-store (Android Keystore /
 * iOS Keychain), never in AsyncStorage.
 */
import { p256 } from '@noble/curves/nist.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from '@/lib/secure-store';

const K_PRIV = 'hawkeye.identity.priv';
const K_DEVICE = 'hawkeye.identity.device';

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(u8: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u8.length; i += 3) {
    const [a, b, c] = [u8[i], u8[i + 1], u8[i + 2]];
    out += B64U[a >> 2] + B64U[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64U[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64U[c & 63];
  }
  return out;
}

function b64std(u8: Uint8Array): string {
  return b64url(u8).replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (3 - (u8.length % 3)) % 3);
}

export type Jwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

export type Identity = {
  deviceId: string;
  publicKeyJwk: Jwk;
  /** Sign a payload string the way the backend verifies it: sha256, ieee-p1363, base64. */
  sign: (payload: string) => string;
};

let cached: Identity | null = null;

/** Load (or mint on first run) the device keypair + id. Idempotent, cached. */
export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;

  let privHex = await SecureStore.getItemAsync(K_PRIV);
  if (!privHex) {
    let priv: Uint8Array;
    do {
      priv = Crypto.getRandomBytes(32);
    } while (!p256.utils.isValidSecretKey(priv));
    privHex = toHex(priv);
    await SecureStore.setItemAsync(K_PRIV, privHex);
  }

  let deviceId = await SecureStore.getItemAsync(K_DEVICE);
  if (!deviceId) {
    deviceId = toHex(Crypto.getRandomBytes(32)); // 64 hex chars, matches ^[0-9a-f]{64}$
    await SecureStore.setItemAsync(K_DEVICE, deviceId);
  }

  const priv = fromHex(privHex);
  const pub = p256.getPublicKey(priv, false); // uncompressed: 0x04 || X || Y
  const publicKeyJwk: Jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
  };

  cached = {
    deviceId,
    publicKeyJwk,
    sign: (payload: string) =>
      b64std(p256.sign(new TextEncoder().encode(payload), priv, { prehash: true })),
  };
  return cached;
}
