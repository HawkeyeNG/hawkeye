// Shared helpers: request headers, synthetic client IPs, metrics, load profiles.
import { Counter, Rate, Trend } from 'k6/metrics';
import { BASE_URL, PROD_NAMED } from './guard.js';

export { BASE_URL };

// ---- Synthetic client IPs (staging, direct-to-origin only) --------------------
// The origin keys its limits on CF-Connecting-IP. When k6 hits the staging
// ORIGIN directly (DIRECT_ORIGIN=1, no Cloudflare in front), we set that header
// ourselves to mimic Nigerian CGNAT: a few addresses carry a lot of users.
// Addresses come from 198.18.0.0/15, the range RFC 2544 reserves for
// benchmarking, so nothing here can collide with a real client in the logs.
// Behind Cloudflare the edge overwrites the header, so setting it is harmless.
// NEVER against production (the guard refuses prod writes anyway).
const DIRECT = String(__ENV.DIRECT_ORIGIN || '') === '1' && !PROD_NAMED;
const SIM_IPS = Math.max(1, Number(__ENV.SIM_IPS || 5000));

export function fakeClientIp() {
  // rand^2 skews toward low indices: heavy "CGNAT" addresses plus a long tail.
  const i = Math.floor(SIM_IPS * Math.random() ** 2);
  return `198.${18 + ((i >> 16) & 1)}.${(i >> 8) & 255}.${i & 255}`;
}

export function headers(extra = {}) {
  const h = {
    'User-Agent': 'hawkeye-loadtest/1 (k6)',
    'X-Loadtest': '1',
    ...extra,
  };
  // Staging's own origin-lock secret, if staging arms the lock. Never prod's
  // (guard.js refuses ORIGIN_AUTH against a production host).
  if (__ENV.ORIGIN_AUTH) h['X-Origin-Auth'] = __ENV.ORIGIN_AUTH;
  if (DIRECT) h['CF-Connecting-IP'] = fakeClientIp();
  return h;
}

export const url = (path) => `${BASE_URL}${path}`;
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function weighted(entries) {
  // entries: [[name, weight, fn], ...] with weight 0 = disabled
  const live = entries.filter((e) => e[1] > 0);
  const total = live.reduce((s, e) => s + e[1], 0);
  return () => {
    let r = Math.random() * total;
    for (const e of live) { r -= e[1]; if (r <= 0) return e; }
    return live[live.length - 1];
  };
}

// ---- Metrics --------------------------------------------------------------------
export const edgeHit = new Rate('edge_hit');              // cf-cache-status HIT/STALE/UPDATING
export const serverBusy = new Counter('server_busy_503');
export const rateLimited = new Counter('rate_limited_429');
export const reportOk = new Rate('report_ok');            // 201 from /api/submissions
export const reportLatency = new Trend('report_end_to_end_ms', true);
export const otpOk = new Rate('otp_flow_ok');

export function noteResponse(res) {
  if (res.status === 503) serverBusy.add(1);
  if (res.status === 429) rateLimited.add(1);
  const cs = res.headers['Cf-Cache-Status'] || res.headers['cf-cache-status'];
  if (cs) edgeHit.add(/^(HIT|STALE|UPDATING|REVALIDATED)$/i.test(cs));
}

// ---- Load profiles ------------------------------------------------------------------
// Per-second targets at 100%. "origin" = the post-edge origin rates in
// docs/private/ELECTION-NIGHT-HOSTING.md §1.2 at the design point (1M users),
// hit DIRECTLY with no cache in front, so it is harsher than the real night.
// "edge" = through Cloudflare, cacheable reads only, kept modest on purpose.
export const PROFILES = {
  smoke:  { publicRead: 20,   authedRead: 50,   upload: 5,   auth: 2 },
  origin: { publicRead: 400,  authedRead: 1500, upload: 250, auth: 20 },
  stress: { publicRead: 600,  authedRead: 2250, upload: 375, auth: 30 },
  edge:   { publicRead: 1000, authedRead: 0,    upload: 0,   auth: 0 },
};

export function profile() {
  const name = String(__ENV.PROFILE || 'smoke');
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown PROFILE=${name} (smoke|origin|stress|edge)`);
  const scale = Number(__ENV.SCALE || 1);
  const out = {};
  for (const k of Object.keys(p)) out[k] = Math.round(p[k] * scale);
  return { name, ...out };
}

// Warm, ramp, hold, a push-broadcast herd spike (+50%), recover, drain.
// TIME_SCALE shortens every stage (0.2 turns the ~30 min shape into ~6 min).
export function rampStages(target) {
  const t = Number(__ENV.TIME_SCALE || 1);
  const d = (m) => `${Math.max(10, Math.round(m * 60 * t))}s`;
  return [
    { target: Math.ceil(target * 0.1), duration: d(2) },
    { target: Math.ceil(target * 0.1), duration: d(3) },
    { target, duration: d(10) },
    { target, duration: d(10) },
    { target: Math.ceil(target * 1.5), duration: d(1) },
    { target: Math.ceil(target * 1.5), duration: d(2) },
    { target, duration: d(1) },
    { target: 0, duration: d(2) },
  ];
}

export function arrival(target, execName, vus = { pre: 50, max: 2000 }) {
  return {
    executor: 'ramping-arrival-rate',
    startRate: 0,
    timeUnit: '1s',
    preAllocatedVUs: vus.pre,
    maxVUs: vus.max,
    stages: rampStages(target),
    exec: execName,
  };
}
