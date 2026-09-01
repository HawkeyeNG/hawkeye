/**
 * Rate limits must key on an IP the caller cannot choose.
 *
 * THE BUG. server.js sets `trust proxy: true`, so Express reads the LEFTMOST
 * X-Forwarded-For entry — which is whatever the original client sent. Every
 * limiter, the OTP gate and the abuse-flag hash keyed on that. One header
 * defeated all of them:
 *
 *     curl -H 'X-Forwarded-For: 1.2.3.4' ...   -> counted as a brand-new visitor
 *
 * Two halves have to hold, and the second is the one a naive fix breaks:
 *   1. A forged X-Forwarded-For must NOT create a new bucket.
 *   2. Genuinely different clients must STILL get their own buckets — otherwise
 *      the "fix" is just a global limit that throttles everyone together.
 *
 *   node tests/client_ip_test.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { clientIp } from '../backend/src/services/security.js';

let failed = 0;
const ok = (cond, label) => {
  console.log(`    ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

// ── unit: the helper itself ──────────────────────────────────────────────────
console.log('\nclientIp() ignores what the caller controls');
const mk = (headers, remote = '10.0.0.7') => ({ headers, socket: { remoteAddress: remote } });

ok(clientIp(mk({ 'x-forwarded-for': '1.2.3.4' })) === '10.0.0.7',
  'a forged X-Forwarded-For is ignored, socket used');
ok(clientIp(mk({ 'cf-connecting-ip': '9.9.9.9' })) === '9.9.9.9',
  'CF-Connecting-IP is used when present');
ok(clientIp(mk({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' })) === '9.9.9.9',
  'CF-Connecting-IP wins over a forged X-Forwarded-For');
ok(clientIp(mk({})) === '10.0.0.7', 'no headers -> socket peer');
ok(clientIp(mk({ 'cf-connecting-ip': '  8.8.8.8  ' })) === '8.8.8.8', 'whitespace trimmed');
ok(clientIp(mk({ 'cf-connecting-ip': '' })) === '10.0.0.7', 'an empty CF header falls back');
ok(typeof clientIp({ headers: {}, socket: {} }) === 'string', 'never returns undefined');

// ── integration: the limiter as actually mounted ─────────────────────────────
const ROOT = '/home/elrio/hawkeye/backend';
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const waitForPort = async (port, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const up = await new Promise((r) => {
      const c = net.connect(port, '127.0.0.1');
      c.on('connect', () => { c.destroy(); r(true); });
      c.on('error', () => r(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

const port = await freePort();
const child = spawn('node', ['src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, ORIGIN_AUTH_SECRET: '', SHIELD_PROXY_SECRET: '', PORT: String(port), NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

try {
  if (!await waitForPort(port)) {
    console.log(`\n    server did not start:\n${log.split('\n').slice(-10).map((l) => '      ' + l).join('\n')}`);
    process.exit(1);
  }

  // /api/admin is the tightest limiter mounted: 60 per 10 minutes.
  const hit = async (headers) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/nonexistent`, { headers });
    return r.status;
  };

  console.log('\n70 requests, each with a DIFFERENT forged X-Forwarded-For');
  let limited = false;
  for (let i = 0; i < 70; i++) {
    if (await hit({ 'x-forwarded-for': `203.0.113.${i}` }) === 429) { limited = true; break; }
  }
  ok(limited, 'the limit still bites — forged headers do not buy new buckets');

  console.log('\ncontrol: genuinely different clients must still get their own buckets');
  // A fresh CF-Connecting-IP is what a real distinct visitor looks like. If the
  // fix had collapsed everyone onto the socket peer, this would 429 immediately
  // — the limiter above is already exhausted for that key.
  const fresh = await hit({ 'cf-connecting-ip': '198.51.100.42' });
  ok(fresh !== 429, `a new real client is not caught by another client's limit (got ${fresh})`);
} finally {
  child.kill('SIGKILL');
}

console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
