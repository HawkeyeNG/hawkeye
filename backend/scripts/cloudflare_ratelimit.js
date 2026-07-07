// Apply the rate-limiting rules from docs/cloudflare-rules.md via the Cloudflare
// Rulesets API. Reads CF_API_TOKEN from backend/.env (token needs Zone WAF:Edit +
// Zone:Read on hawkeye.com.ng). Idempotent: rewrites the http_ratelimit phase
// entrypoint each run. Free plan allows only ONE rule — the script detects the
// rejection and retries with just the highest-value rule (otp-abuse).
//   node scripts/cloudflare_ratelimit.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.readFileSync(path.join(backend, '.env'), 'utf8');
const TOKEN = /^CF_API_TOKEN=(\S+)/m.exec(env)?.[1];
const ZONE_NAME = 'hawkeye.com.ng';
if (!TOKEN) { console.error('CF_API_TOKEN missing from backend/.env'); process.exit(1); }

const cf = async (method, apiPath, body) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

// full rule set (paid). Actions: managed_challenge / block.
const RULES = [
  {
    description: 'otp-abuse',
    expression: '(http.request.uri.path in {"/api/observers/register" "/api/observers/verify" "/api/observers/telegram-verify"})',
    action: 'managed_challenge',
    ratelimit: { characteristics: ['ip.src'], period: 60, requests_per_period: 12, mitigation_timeout: 60 },
  },
  {
    description: 'submit-flood',
    expression: '(starts_with(http.request.uri.path, "/api/submissions") or starts_with(http.request.uri.path, "/api/incidents") or starts_with(http.request.uri.path, "/api/collations"))',
    action: 'block',
    ratelimit: { characteristics: ['ip.src'], period: 60, requests_per_period: 20, mitigation_timeout: 600 },
  },
  {
    description: 'api-firehose',
    expression: '(starts_with(http.request.uri.path, "/api/"))',
    action: 'managed_challenge',
    ratelimit: { characteristics: ['ip.src'], period: 60, requests_per_period: 300, mitigation_timeout: 60 },
  },
  {
    description: 'admin-lockout',
    expression: '(starts_with(http.request.uri.path, "/api/admin"))',
    action: 'block',
    ratelimit: { characteristics: ['ip.src'], period: 300, requests_per_period: 10, mitigation_timeout: 3600 },
  },
];

const zres = await cf('GET', `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
const zone = zres.result?.[0];
if (!zone) { console.error('zone lookup failed:', JSON.stringify(zres.errors || zres)); process.exit(1); }
console.log('zone:', zone.id, '| plan:', zone.plan?.name);

const put = (rules) => cf('PUT', `/zones/${zone.id}/rulesets/phases/http_ratelimit/entrypoint`, {
  rules: rules.map((r) => ({ ...r, enabled: true })),
});

let out = await put(RULES);
if (!out.success) {
  console.log('full set rejected:', JSON.stringify(out.errors));
  console.log('retrying with single rule (otp-abuse) — free-plan limit…');
  out = await put([RULES[0]]);
}
if (out.success) {
  console.log('APPLIED rate-limiting rules:');
  for (const r of out.result.rules || []) console.log(`  • ${r.description} → ${r.action}`);
} else {
  console.error('FAILED:', JSON.stringify(out.errors));
  process.exit(1);
}
