// Download filled EC8A sheet images from INEC IReV into storage/training/.
// The IReV API is publicly readable — no account needed.
//   node scripts/fetch_irev_sheets.js <electionId> <stateId 1-37> [maxDocs=40]
// List elections: curl https://dolphin-app-sleqh.ondigitalocean.app/api/v1/elections
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const STORE_WIDTH = Number(process.env.SHEET_STORE_WIDTH || 2400);

const electionId = process.argv[2];
const stateId = process.argv[3];
const MAX = Number(process.argv[4] || 40);
if (!electionId || !stateId) { console.error('usage: node scripts/fetch_irev_sheets.js <electionId> <stateId> [max]'); process.exit(1); }

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'training');
fs.mkdirSync(dir, { recursive: true });
const H = { 'user-agent': 'Mozilla/5.0' };
const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
// Retry with backoff, and never hand JSON.parse an HTML error page. Under load
// this host answers with an HTML holding page — sometimes even at HTTP 200 —
// which used to crash the run outright on the first `.json()`.
const j = async (u, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: H });
      const t = await r.text();
      if (r.ok && t.trimStart().startsWith('{')) return JSON.parse(t);
    } catch { /* fall through to the backoff */ }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  return {};
};

const lgas = await j(`${BASE}/elections/${electionId}/lga/state/${stateId}`);
let saved = 0;
let bad = 0; // responses that were not decodable images (see the guard below)
outer: for (const lga of lgas.data || []) {
  for (const ward of lga.wards || []) {
    const pus = await j(`${BASE}/elections/${electionId}/pus?ward=${ward._id}`);
    for (const pu of pus.data || []) {
      const url = pu.document?.url;
      if (!url) continue;
      try {
        const img = await fetch(url, { headers: H });
        if (!img.ok) continue;
        // STORE AT 2400px, NOT 1500. This used to compress to 1500px "same size
        // the viewer serves" — but the viewer and the VLM are not the same
        // consumer, and the VLM is the one that decides what the audit can read.
        //
        // Measured from audit-osun2026.db, which records dimensions BEFORE this
        // line runs: 3,721 of 3,742 Osun sheets arrive at 3072x4096, 99.9% exceed
        // 2000px, and this resize was discarding 91.3% of every sheet's bytes
        // (3.93 MB -> 0.34 MB). The party-table pass then cropped the 1500px
        // result to 1080px and UPSCALED it to 1728 — inventing pixels an hour
        // after the real ones were thrown away.
        //
        // 2400 is not a taste: the party crop takes 0.72 of the width and its
        // output is pinned at 1728px, so 1728 / 0.72 = 2400 is the smallest
        // source that makes that crop a downscale instead of an upscale. Below
        // it the pass is still interpolating; above it costs storage for detail
        // the crop then throws away.
        //
        // Cost: 212 KB -> 379 KB per sheet, so the 2027 corpus goes 107 GB ->
        // 192 GB. That is ~$1.30/month of object storage, against an audit whose
        // GPU bill is ~$150. The 1500px/q76 rule still governs what is SERVED —
        // this is the archive the model reads, which is a different corpus with a
        // different consumer.
        //
        // Both VLM crops now pin their OUTPUT width, so this change costs zero
        // extra vision tokens. Do not raise it without checking that they still do.
        const raw = Buffer.from(await img.arrayBuffer());
        // IT MUST ACTUALLY BE AN IMAGE. The old code kept `raw` when sharp could
        // not decode it ("keep raw on decode failure"), which quietly wrote
        // whatever came back — and under rate limiting this host returns an HTML
        // error page with HTTP 200. That produced 1KB files named <pu_code>.jpg
        // that begin "<!DOCTYPE ht", indistinguishable from real sheets in a
        // directory listing and silently poisoning the training corpus.
        // A file that does not decode is not a sheet: skip it and say so.
        let out;
        try {
          out = await sharp(raw).rotate().resize({ width: STORE_WIDTH, withoutEnlargement: true }).jpeg({ quality: 76, mozjpeg: true }).toBuffer();
        } catch {
          bad++;
          continue;
        }
        fs.writeFileSync(path.join(dir, `${(pu.pu_code || pu._id).replaceAll('/', '-')}.jpg`), out);
        saved++;
        process.stdout.write(`\r  saved ${saved}`);
        if (saved >= MAX) break outer;
      } catch { /* skip */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
console.log(`\ndone: ${saved} sheets -> storage/training/`);
if (bad) console.log(`  ${bad} response(s) skipped — not decodable images (this host serves an HTML error page with HTTP 200 when rate-limited; slow down and retry)`);
