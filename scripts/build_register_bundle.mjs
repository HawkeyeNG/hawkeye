/**
 * Bake the Osun register into a static file the site can serve.
 *
 * WHY. The browse cascade is four sequential round trips (states -> LGAs ->
 * wards -> units) and each one measured ~1-2.5s against production on a good
 * link. On election-day mobile that is where observers get stuck, and it is the
 * one path that must not depend on the network: the register does not change,
 * so there is no reason to ask a server for it at all.
 *
 * Rows are stored EXACTLY as /api/register/units returns them, so the client can
 * substitute this for the network response without any shape translation — the
 * locationTier badge, the coordinates and the geofence all keep working.
 *
 * Run:  node scripts/build_register_bundle.mjs [state]   (default Osun)
 * Out:  app/register-<state>.json
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BASE = process.env.HAWKEYE_BASE || 'https://hawkeye.com.ng';
const STATE = process.argv[2] || 'Osun';
const UA = { 'User-Agent': 'Mozilla/5.0 hawkeye-build' }; // Cloudflare 403s the default agent

const get = async (path) => {
  const res = await fetch(BASE + path, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
};

const states = await get('/api/register/states');
const lgas = await get(`/api/register/lgas?state=${encodeURIComponent(STATE)}`);

const tree = {};
let wardCount = 0;
let unitCount = 0;
for (const lga of lgas) {
  const wards = await get(`/api/register/wards?state=${encodeURIComponent(STATE)}&lga=${encodeURIComponent(lga)}`);
  tree[lga] = {};
  wardCount += wards.length;
  for (const ward of wards) {
    const { units } = await get(
      `/api/register/units?state=${encodeURIComponent(STATE)}&lga=${encodeURIComponent(lga)}&ward=${encodeURIComponent(ward)}`,
    );
    tree[lga][ward] = units;
    unitCount += units.length;
  }
}

const out = { generated: new Date().toISOString().slice(0, 10), states, [STATE]: tree };
const json = JSON.stringify(out);
const path = new URL(`../app/register-${STATE.toLowerCase()}.json`, import.meta.url);
writeFileSync(path, json);
console.log(`${STATE}: ${lgas.length} LGAs, ${wardCount} wards, ${unitCount} units`);
console.log(`wrote ${path.pathname} — ${json.length} bytes (${gzipSync(json).length} gzipped)`);
