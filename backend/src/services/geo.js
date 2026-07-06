import crypto from 'node:crypto';
import { config } from '../config.js';

const EARTH_RADIUS_M = 6371000;

export function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Crowd location consensus for units without verified coordinates: the median
// center is robust to a minority of liars (unlike a mean, a few wild fixes cannot
// drag it), and only reports within radiusM of it count toward the cluster.
export function locationCluster(points, radiusM) {
  const mid = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const centerLat = mid(points.map((p) => p.lat));
  const centerLng = mid(points.map((p) => p.lng));
  const inCluster = points.filter(
    (p) => haversineM(p.lat, p.lng, centerLat, centerLng) <= radiusM,
  ).length;
  return { centerLat, centerLng, inCluster, share: points.length ? inCluster / points.length : 0 };
}

// Location attestation ("oracle proof"): binds observer, unit, coordinates and time.
// HMAC is enough while the backend is the only verifier; swap to an ECDSA signature
// (same payload) when HawkeyeLedger.sol needs to verify it on-chain via ecrecover.
export function makeLocationProof({ observerId, puCode, lat, lng, accuracy, distanceM }) {
  const payload = { observerId, puCode, lat, lng, accuracy, distanceM, ts: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.oracleSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyLocationProof(proof) {
  try {
    const [body, mac] = String(proof).split('.');
    if (!body || !mac) return null;
    const expected = crypto
      .createHmac('sha256', config.oracleSecret)
      .update(body)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
