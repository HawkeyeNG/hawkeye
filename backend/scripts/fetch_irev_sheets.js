// Download filled EC8A sheet images from INEC IReV into storage/training/.
// The IReV API is publicly readable — no account needed.
//   node scripts/fetch_irev_sheets.js <electionId> <stateId 1-37> [maxDocs=40]
// List elections: curl https://dolphin-app-sleqh.ondigitalocean.app/api/v1/elections
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electionId = process.argv[2];
const stateId = process.argv[3];
const MAX = Number(process.argv[4] || 40);
if (!electionId || !stateId) { console.error('usage: node scripts/fetch_irev_sheets.js <electionId> <stateId> [max]'); process.exit(1); }

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'training');
fs.mkdirSync(dir, { recursive: true });
const H = { 'user-agent': 'Mozilla/5.0' };
const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
const j = (u) => fetch(u, { headers: H }).then((r) => r.json());

const lgas = await j(`${BASE}/elections/${electionId}/lga/state/${stateId}`);
let saved = 0;
outer: for (const lga of lgas.data || []) {
  for (const ward of lga.wards || []) {
    const pus = await j(`${BASE}/elections/${electionId}/pus?ward=${ward._id}`);
    for (const pu of pus.data || []) {
      const url = pu.document?.url;
      if (!url) continue;
      try {
        const img = await fetch(url, { headers: H });
        if (!img.ok) continue;
        const ext = (url.split('.').pop() || 'jpg').split('?')[0].slice(0, 4);
        fs.writeFileSync(path.join(dir, `${(pu.pu_code || pu._id).replaceAll('/', '-')}.${ext}`), Buffer.from(await img.arrayBuffer()));
        saved++;
        process.stdout.write(`\r  saved ${saved}`);
        if (saved >= MAX) break outer;
      } catch { /* skip */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
console.log(`\ndone: ${saved} sheets -> storage/training/`);
