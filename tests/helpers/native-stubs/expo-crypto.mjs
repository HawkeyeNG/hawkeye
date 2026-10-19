import { randomBytes } from 'node:crypto';
export const getRandomBytes = (n) => new Uint8Array(randomBytes(n));
