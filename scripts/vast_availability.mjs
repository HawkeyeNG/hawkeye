// Sample how many GPUs Vast.ai has free right now, and at what price, and append
// one JSON line to the file given (default data/vast.jsonl). Run on a schedule
// for 2026-10 → 2026-11 to learn when cards are plentiful, so the election-night
// grab (planned ~24 h before polls open) starts at the right time.
//
// Public, no-auth search API. It returns at most 64 offers a query, so each GPU
// model is enumerated by slicing machine_id and splitting any slice that fills.
import fs from 'node:fs';

const OUT = process.argv[2] || 'data/vast.jsonl';
const GPUS = ['RTX 4090', 'RTX 5090', 'RTX 3090'];
const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE GB NO CH IS'.split(' '));
const CUDA_MIN = 13.0;       // our vLLM image
const REL_MIN = 0.98;
const CHEAP = 0.45;          // $/GPU-h ceiling used in the plan

async function search(gpu, lo, hi) {
  const q = { q: { gpu_name: { eq: gpu }, rentable: { eq: true }, rented: { eq: false }, external: { eq: false },
    type: 'on-demand', machine_id: { gte: lo, lt: hi } } };
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch('https://console.vast.ai/api/v0/search/asks/', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q),
        signal: AbortSignal.timeout(120_000) });
      const j = await r.json();
      if (Array.isArray(j.offers)) return j.offers;
    } catch { /* retry */ }
    await new Promise((s) => setTimeout(s, 5000 * (a + 1)));
  }
  throw new Error(`search failed ${gpu} ${lo}-${hi}`);
}

async function enumerate(gpu) {
  const stack = [[0, 50_000], [50_000, 100_000], [100_000, 150_000], [150_000, 1e9]];
  const offers = new Map();
  while (stack.length) {
    const [lo, hi] = stack.pop();
    const got = await search(gpu, lo, hi);
    if (got.length >= 64 && hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); stack.push([lo, mid], [mid, hi]); continue; }
    for (const o of got) offers.set(o.id, o);
  }
  return [...offers.values()];
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };

function summarise(offers) {
  // One record per machine: its largest free bundle, priced per GPU.
  const mach = new Map();
  for (const o of offers) {
    const m = mach.get(o.machine_id);
    if (!m || o.num_gpus > m.num_gpus) mach.set(o.machine_id, o);
  }
  const rows = [...mach.values()];
  const cc = (o) => String(o.geolocation || '').split(',').pop().trim();
  const usable = rows.filter((o) => o.verification === 'verified' && (o.reliability2 ?? o.reliability ?? 0) >= REL_MIN && (o.cuda_max_good ?? 0) >= CUDA_MIN);
  const sum = (a) => a.reduce((n, o) => n + (o.num_gpus || 0), 0);
  const price = (a) => a.map((o) => o.dph_total / o.num_gpus);
  return {
    machines: rows.length, gpus: sum(rows),
    usable: sum(usable), usableCheap: sum(usable.filter((o) => o.dph_total / o.num_gpus <= CHEAP)),
    usableEU: sum(usable.filter((o) => EU.has(cc(o)))), usableDatacenter: sum(usable.filter((o) => o.hosting_type === 1)),
    price: { p10: pct(price(usable), 0.1), p50: pct(price(usable), 0.5), p90: pct(price(usable), 0.9) },
  };
}

const rec = { t: new Date().toISOString(), wat: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16).replace('T', ' '),
  dow: new Date(Date.now() + 3_600_000).getUTCDay() };
for (const g of GPUS) {
  try { rec[g] = summarise(await enumerate(g)); } catch (e) { rec[g] = { error: e.message }; }
}
fs.mkdirSync(OUT.replace(/\/[^/]*$/, '') || '.', { recursive: true });
fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
console.log(JSON.stringify(rec));
