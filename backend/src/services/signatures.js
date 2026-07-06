import crypto from 'node:crypto';

// IMPORTANT: canonicalVotes/canonicalPayload must produce byte-identical output to
// their mirrors in app/app.js — the observer signs the client-side string and the
// server verifies against its own reconstruction. Plain code-unit comparison (not
// localeCompare) so both runtimes sort identically.
export function canonicalVotes(votes) {
  return votes
    .map((v) => ({ party: String(v.party), count: Number(v.count) }))
    .sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
}

export function canonicalPayload({
  puCode, contest, votes, imageSha256, venueImageSha256, capturedAt, venueCapturedAt,
  lat, lng, sheetLat, sheetLng, venueLat, venueLng,
}) {
  return JSON.stringify({
    puCode,
    contest,
    votes: canonicalVotes(votes),
    imageSha256,
    venueImageSha256,
    capturedAt,
    venueCapturedAt,
    lat,
    lng,
    sheetLat,
    sheetLng,
    venueLat,
    venueLng,
  });
}

// Collation-form payload (EC8B/C/D). MIRROR: app/collation.html — keep byte-identical.
export function canonicalCollationPayload({
  level, contest, state, lga, ward, votes, imageSha256, venueImageSha256,
  capturedAt, venueCapturedAt, lat, lng,
}) {
  return JSON.stringify({
    level,
    contest,
    state,
    lga: lga || '',
    ward: ward || '',
    votes: canonicalVotes(votes),
    imageSha256,
    venueImageSha256,
    capturedAt,
    venueCapturedAt,
    lat,
    lng,
  });
}

// WebCrypto ECDSA P-256 signatures arrive raw (IEEE P1363, 64 bytes), base64-encoded.
export function verifyObserverSignature(publicKeyJwkJson, payloadString, signatureB64) {
  try {
    const key = crypto.createPublicKey({ key: JSON.parse(publicKeyJwkJson), format: 'jwk' });
    return crypto.verify(
      'sha256',
      Buffer.from(payloadString, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

export function validatePublicKeyJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return false;
  try {
    crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}
