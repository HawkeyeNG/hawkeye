/**
 * Watch the one host limit that can stop the site dead.
 *
 *   node scripts/disk_watch.mjs            # human output
 *   node scripts/disk_watch.mjs --json     # for cron / alerting
 *
 * GO54 confirmed in writing that the 120 GB disk quota is a HARD cap: uploads
 * fail once it is reached, we are already on their highest shared plan, and
 * breaching it throttles or suspends the site until the next billing cycle. On
 * 16 January 2027 that is the worst outcome this project has.
 *
 * WHY THIS AND NOT BANDWIDTH. The DirectAdmin `bandwidth` field is frozen —
 * 25.9 MB of verified traffic moved it 0.0 MB over nine hours while `quota`
 * changed in the same response. So `quota` is the field that works, and disk is
 * the binding constraint anyway now that the cache rules absorb reads.
 *
 * Exit codes are for cron: 0 fine, 1 warn, 2 act now.
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = path.join(HERE, '..', '.env');
const DA = 'https://da32.host-ww.net:2222/CMD_API_SHOW_USER_USAGE';

const CAP_MB = 122880;          // 120 GB, the hard cap
const ACT_MB = 51200;           // 50 GB — activate R2 (docs/DISK-PLAN-B.md)
const WARN_MB = 36864;          // 36 GB — 30%, start watching weekly

const env = (key) => {
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const m = new RegExp(`^${key}=(.*)$`).exec(line.replace(/\r$/, ''));
    if (m) return m[1].replace(/\s*#.*$/, '').trim();
  }
  return null;
};

const user = env('GO54_USERNAME');
const pass = env('GO54_PASSWORD');
if (!user || !pass) {
  console.error('GO54 credentials not readable from backend/.env');
  process.exit(3);
}

const body = await new Promise((resolve, reject) => {
  const req = https.request(`${DA}?user=${encodeURIComponent(user)}`, {
    auth: `${user}:${pass}`,
    rejectUnauthorized: false,          // the host serves a mismatched cert
    timeout: 60_000,
  }, (res) => {
    let out = '';
    res.on('data', (d) => { out += d; });
    res.on('end', () => resolve(out));
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.end();
});

const fields = Object.fromEntries(
  decodeURIComponent(body).split('&').map((kv) => kv.split('=').map((x) => decodeURIComponent(x))),
);
const usedMb = Number(fields.quota);
const inodes = Number(fields.inode);

if (!Number.isFinite(usedMb)) {
  console.error(`could not read quota from DirectAdmin: ${body.slice(0, 200)}`);
  process.exit(3);
}

const pct = (usedMb / CAP_MB) * 100;
// Measured 369 KB per observer (sheet 218 + venue 152); 500 KB is the planning
// figure, since the corpus those came from is already a downscaled derivative.
const headroomObservers = Math.max(0, Math.floor(((CAP_MB - usedMb) * 1024) / 500));

const level = usedMb >= ACT_MB ? 'ACT' : usedMb >= WARN_MB ? 'WARN' : 'OK';
const code = level === 'ACT' ? 2 : level === 'WARN' ? 1 : 0;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    level, usedMb, capMb: CAP_MB, pct: Number(pct.toFixed(2)),
    actAtMb: ACT_MB, headroomObservers, inodes,
  }));
  process.exit(code);
}

console.log(`disk: ${usedMb.toFixed(1)} MB of ${CAP_MB} MB  (${pct.toFixed(2)}%)`);
console.log(`inodes: ${inodes}`);
console.log(`headroom: about ${headroomObservers.toLocaleString()} more observers at 500 KB each`);
console.log(`\nlevel: ${level}`);
if (level === 'ACT') {
  console.log('  >= 50 GB. Activate R2 now — docs/DISK-PLAN-B.md step 1.');
  console.log('  Do not wait for 120 GB: at the cap, uploads FAIL and the site can be suspended.');
} else if (level === 'WARN') {
  console.log('  >= 36 GB. Check this weekly and make sure the R2 path is still verified:');
  console.log('    BLOB_DRIVER=s3 node scripts/r2_roundtrip.mjs');
} else {
  console.log(`  Below ${(WARN_MB / 1024).toFixed(0)} GB. Nothing to do.`);
}
process.exit(code);
