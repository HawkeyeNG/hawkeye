// Continuous learning from INEC IReV: walks every published election, downloads
// EC8A sheets not yet in storage/training/, runs the production OCR over each and
// logs digit-extraction stats to storage/training/learning_log.json. Human labels
// (train.html -> truth.json) turn those sheets into scored calibration data.
//
//   node scripts/learn_inec.js [maxNewSheets=50]          # one pass
//   node scripts/learn_inec.js 50 --loop                  # repeat every 6h
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocrMatchCounts } from '../src/services/ocr.js';

const MAX = Number(process.argv[2] || 50);
const LOOP = process.argv.includes('--loop');
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'training');
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, 'learning_log.json');
const H = { 'user-agent': 'Mozilla/5.0' };
const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
const j = (u) => fetch(u, { headers: H }).then((r) => r.json()).catch(() => ({}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onePass() {
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : { sheets: {}, runs: [] };
  const have = new Set(fs.readdirSync(dir).map((f) => f.replace(/\.[^.]+$/, '')));
  let saved = 0;
  const elections = (await j(`${BASE}/elections`)).data || [];
  outer: for (const e of elections) {
    for (let st = 1; st <= 37; st++) {
      const lgas = (await j(`${BASE}/elections/${e._id}/lga/state/${st}`)).data || [];
      if (!lgas.length) continue;
      for (const lga of lgas) for (const ward of lga.wards || []) {
        const pus = (await j(`${BASE}/elections/${e._id}/pus?ward=${ward._id}`)).data || [];
        for (const pu of pus) {
          const url = pu.document?.url;
          const key = (pu.pu_code || pu._id).replaceAll('/', '-');
          if (!url || have.has(key)) continue;
          try {
            const img = await fetch(url, { headers: H });
            if (!img.ok) continue;
            const buf = Buffer.from(await img.arrayBuffer());
            const ext = (url.split('.').pop() || 'jpg').split('?')[0].slice(0, 4);
            fs.writeFileSync(path.join(dir, `${key}.${ext}`), buf);
            have.add(key);
            const r = await ocrMatchCounts(buf, [{ party: 'X', count: 1 }]);
            log.sheets[key] = { election: e.full_name, tokens: r ? r.tokens.length : 0, at: Date.now() };
            saved++;
            process.stdout.write(`\r  new sheets: ${saved}`);
            if (saved >= MAX) break outer;
          } catch { /* skip */ }
          await sleep(400);
        }
      }
    }
  }
  log.runs.push({ at: Date.now(), saved });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 1));
  console.log(`\npass done: ${saved} new sheets · ${Object.keys(log.sheets).length} total tracked`);
}

do {
  await onePass();
  if (LOOP) { console.log('sleeping 6h…'); await sleep(6 * 3600 * 1000); }
} while (LOOP);
process.exit(0);
