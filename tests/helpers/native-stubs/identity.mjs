export const getIdentity = async () => ({
  deviceId: 'd'.repeat(64),
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  sign: (p) => 'sig:' + p.length,
});
