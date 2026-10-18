// THE DEVICE ID NEVER THROWS (pre-election review).
//
// app.js api() awaits getDeviceId() before EVERY request — sign-in, the near-me
// unit lookup, the report itself. device.js called crypto.randomUUID(), which
// arrived in Chrome 92, and read localStorage unguarded. Lite runs on Android 7
// phones whose system WebView can be older than 92, and storage can be blocked
// in a browser; either way every API call rejected before it was made.
//
// The SHIPPED app/device.js runs here in a vm realm with the old engine's
// crypto (no randomUUID) and with a localStorage that throws. CONTROL: a modern
// engine gives the same 64-hex id, and keeps it.
//
//   node tests/device_id_fallback_test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const H = '/home/elrio/hawkeye';
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

function load({ randomUUID = true, storage = 'ok' } = {}) {
  const mem = new Map();
  const localStorage = storage === 'throws'
    ? { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } }
    : { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const crypto = {
    subtle: webcrypto.subtle,
    getRandomValues: (a) => webcrypto.getRandomValues(a),
    ...(randomUUID ? { randomUUID: () => webcrypto.randomUUID() } : {}),
  };
  const window = {};
  const sandbox = {
    window, localStorage, crypto, TextEncoder, Uint8Array, Intl, console,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 7.0) Chrome/83.0 Mobile', platform: 'Linux armv8l', hardwareConcurrency: 4, maxTouchPoints: 5 },
    screen: { width: 360, height: 640 },
    document: { createElement: () => ({ getContext: () => null }) },
  };
  sandbox.window = Object.assign(window, { devicePixelRatio: 2 });
  vm.runInNewContext(fs.readFileSync(`${H}/app/device.js`, 'utf8'), sandbox);
  return { get: window.getDeviceId, mem };
}
const settle = (f) => f().then((v) => v, (e) => `threw: ${e && e.message}`);
const HEX64 = (v) => /^[0-9a-f]{64}$/.test(v);

{
  const d = load({ randomUUID: false });
  const id = await settle(d.get);
  check('Android 7 WebView (no crypto.randomUUID): a device id, not a throw', id, HEX64);
  check('...and its seed is kept for the next page', d.mem.has('hk_device_seed'), true);
}
{
  const d = load({ storage: 'throws' });
  check('storage blocked: a device id, not a throw', await settle(d.get), HEX64);
}
{
  const d = load();
  const a = await settle(d.get);
  check('CONTROL: a modern engine gives a 64-hex id', a, HEX64);
  const again = load();
  again.mem.set('hk_device_seed', d.mem.get('hk_device_seed'));
  check('CONTROL: the same seed gives the same id on the next page', await settle(again.get), a);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
