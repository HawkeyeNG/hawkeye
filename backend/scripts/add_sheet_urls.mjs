#!/usr/bin/env node
/**
 * Record each queued sheet's IReV document URL in queue.json.
 *
 * WHY. The 1.3 GB of sheet images are gitignored and live only on the machine
 * that ran the audit, and production is GO54 shared hosting with no SSH — every
 * file goes up one-per-request through the DirectAdmin API, which has previously
 * tripped the host's intrusion prevention when pushed. Uploading 490 JPEGs is
 * the wrong shape.
 *
 * They do not need uploading. The sheets are public INEC documents already on a
 * CDN, so the server can fetch one on demand and compress it through the same
 * 1500px/q76 pipeline the audit used, caching the result. What it needs from
 * here is the URL, because the S3 key ends in a random UUID that cannot be
 * derived from the polling-unit code.
 *
 * The URL is only reachable by walking the election's LGA -> ward -> PU tree, so
 * this does that once for Osun and merges the result in.
 *
 *   node backend/scripts/add_sheet_urls.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const QUEUE = path.join(ROOT, 'backend/storage/audit_review/queue.json');

const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
const OSUN_ELECTION = '6a7f788adcbc755a763f082a'; // Governorship election - 2026-08-15 - OSUN
const OSUN_STATE_ID = 30;
const H = { 'user-agent': 'Mozilla/5.0' };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** This host answers with an HTML holding page — sometimes at HTTP 200 — when it
 *  is being pushed, so never hand JSON.parse whatever came back. */
async function j(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      if (r.ok && t.trimStart().startsWith('{')) return JSON.parse(t);
    } catch { /* fall through to the backoff */ }
    await nap(1500 * (i + 1));
  }
  return null;
}

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const want = new Set(queue.entries.map((e) => e.key));
console.log(`queue: ${queue.entries.length} sheets to locate`);

const lgas = await j(`${BASE}/elections/${OSUN_ELECTION}/lga/state/${OSUN_STATE_ID}`);
if (!lgas?.data?.length) throw new Error('no LGA list for the Osun election');
const wards = lgas.data.flatMap((l) => l.wards || []);
console.log(`walking ${lgas.data.length} LGAs / ${wards.length} wards`);

const found = new Map();
let done = 0;
for (const w of wards) {
  const r = await j(`${BASE}/elections/${OSUN_ELECTION}/pus?ward=${w._id}`);
  for (const pu of r?.data || []) {
    // pu_code arrives slash-separated; the queue key is hyphenated.
    const key = String(pu.pu_code || '').replaceAll('/', '-');
    if (want.has(key) && pu.document?.url) found.set(key, pu.document.url);
  }
  done += 1;
  if (done % 25 === 0) process.stdout.write(`\r  ${done}/${wards.length} wards, ${found.size}/${want.size} located`);
  await nap(350);
}
process.stdout.write('\n');

let merged = 0;
for (const e of queue.entries) {
  const u = found.get(e.key);
  if (u) { e.docUrl = u; merged += 1; }
}
const missing = queue.entries.filter((e) => !e.docUrl).map((e) => e.key);

fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 1));
console.log(`located ${merged}/${queue.entries.length}`);
if (missing.length) {
  // Not fatal: a sheet with no URL still works wherever the local audit tree is
  // present, and the route falls back to it. It simply cannot be served from a
  // host that does not hold the images.
  console.log(`NOT located (${missing.length}): ${missing.slice(0, 10).join(', ')}`);
}
console.log(`-> ${path.relative(ROOT, QUEUE)}`);
