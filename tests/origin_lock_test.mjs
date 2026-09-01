/**
 * The origin lock must accept BOTH edges, and nothing else.
 *
 * Cloudflare stamps X-Origin-Auth (a Transform Rule, so we choose the name).
 * Project Shield stamps Shield-Proxy-Secret — Google fixes that name and it
 * cannot be changed. Until the backend accepted both, cutting over to Shield
 * would have 403'd every request, which is the failure
 * docs/PROJECT-SHIELD-VS-CLOUDFLARE.md exists to prevent.
 *
 * This boots the REAL server rather than re-implementing the middleware, because
 * a test that reimplements the thing it is testing passes when the real one is
 * unwired. Each case is checked against a live HTTP response.
 *
 * What must hold:
 *   - no secrets set        -> lock dormant, requests pass (unchanged behaviour)
 *   - only the CF secret    -> CF header passes, Shield header REJECTED
 *   - only the Shield secret-> Shield header passes, CF header REJECTED
 *   - both set              -> both pass; wrong values and no header rejected
 *
 * The third case is the one that proves configuring one edge does not silently
 * open the other.
 *
 *   node tests/origin_lock_test.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = '/home/elrio/hawkeye/backend';
const CF = 'cf-secret-value-for-test';
const SHIELD = 'shield-secret-value-for-test';

let failed = 0;
const ok = (cond, label) => {
  console.log(`    ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function waitForPort(port, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const up = await new Promise((res) => {
      const c = net.connect(port, '127.0.0.1');
      c.on('connect', () => { c.destroy(); res(true); });
      c.on('error', () => res(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function withServer(env, fn) {
  const port = await freePort();
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    if (!await waitForPort(port)) {
      console.log(`    server did not start. output:\n${log.split('\n').slice(-12).map((l) => '      ' + l).join('\n')}`);
      failed++;
      return;
    }
    await fn(port);
  } finally {
    child.kill('SIGKILL');
  }
}

const status = async (port, headers) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/anchors`, { headers });
    return r.status;
  } catch { return 0; }
};

console.log('\nno secrets set — the lock stays dormant');
await withServer({ ORIGIN_AUTH_SECRET: '', SHIELD_PROXY_SECRET: '' }, async (p) => {
  ok(await status(p, {}) !== 403, 'a plain request is not blocked');
});

console.log('\nonly the Cloudflare secret — Shield must NOT get in');
await withServer({ ORIGIN_AUTH_SECRET: CF, SHIELD_PROXY_SECRET: '' }, async (p) => {
  ok(await status(p, {}) === 403, 'no header -> 403');
  ok(await status(p, { 'x-origin-auth': CF }) !== 403, 'correct X-Origin-Auth -> allowed');
  ok(await status(p, { 'x-origin-auth': 'wrong' }) === 403, 'wrong X-Origin-Auth -> 403');
  ok(await status(p, { 'shield-proxy-secret': SHIELD }) === 403,
    'Shield header alone -> 403 (its secret is unset)');
});

console.log('\nonly the Shield secret — Cloudflare must NOT get in');
await withServer({ ORIGIN_AUTH_SECRET: '', SHIELD_PROXY_SECRET: SHIELD }, async (p) => {
  ok(await status(p, {}) === 403, 'no header -> 403');
  ok(await status(p, { 'shield-proxy-secret': SHIELD }) !== 403, 'correct Shield-Proxy-Secret -> allowed');
  ok(await status(p, { 'shield-proxy-secret': 'wrong' }) === 403, 'wrong Shield-Proxy-Secret -> 403');
  ok(await status(p, { 'x-origin-auth': CF }) === 403, 'CF header alone -> 403 (its secret is unset)');
});

console.log('\nboth set — both edges get in, nothing else does');
await withServer({ ORIGIN_AUTH_SECRET: CF, SHIELD_PROXY_SECRET: SHIELD }, async (p) => {
  ok(await status(p, { 'x-origin-auth': CF }) !== 403, 'Cloudflare -> allowed');
  ok(await status(p, { 'shield-proxy-secret': SHIELD }) !== 403, 'Shield -> allowed');
  ok(await status(p, {}) === 403, 'no header -> 403');
  ok(await status(p, { 'x-origin-auth': SHIELD, 'shield-proxy-secret': CF }) === 403,
    'the two secrets swapped between headers -> 403');
});

console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
