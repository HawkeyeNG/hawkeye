// Download party logos (Wikipedia article lead images) into app/logos/ and write
// a manifest. Parties whose logo can't be fetched fall back to a coloured
// monogram badge in the UI. NOTE: party logos are used for identification only;
// review usage rights before any large-scale production use.
//
//   node scripts/fetch_party_logos.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logosDir = path.join(backendRoot, '..', 'app', 'logos');
fs.mkdirSync(logosDir, { recursive: true });

const ARTICLES = {
  A: 'Accord (Nigeria)',
  AA: 'Action Alliance',
  AAC: 'African Action Congress',
  ADC: 'African Democratic Congress',
  ADP: 'Action Democratic Party',
  APC: 'All Progressives Congress',
  APGA: 'All Progressives Grand Alliance',
  APM: 'Allied Peoples Movement',
  APP: 'Action Peoples Party',
  BP: 'Boot Party',
  LP: 'Labour Party (Nigeria)',
  NNPP: 'New Nigeria Peoples Party',
  NRM: 'National Rescue Movement',
  PDP: 'Peoples Democratic Party',
  PRP: "Peoples Redemption Party",
  SDP: 'Social Democratic Party (Nigeria)',
  YPP: 'Young Progressives Party',
  ZLP: 'Zenith Labour Party',
};

const UA = { 'user-agent': 'Hawkeye-election-monitor/0.1 (civic transparency; contact via hawkeye.com.ng)' };
const manifest = {};

for (const [code, title] of Object.entries(ARTICLES)) {
  try {
    const api = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&pithumbsize=128&redirects=1&titles=${encodeURIComponent(title)}`;
    const d = await (await fetch(api, { headers: UA })).json();
    const page = Object.values(d?.query?.pages || {})[0];
    const src = page?.thumbnail?.source;
    if (!src) {
      console.log(`--  ${code}: no lead image`);
      continue;
    }
    const img = await fetch(src, { headers: UA });
    if (!img.ok) throw new Error(`HTTP ${img.status}`);
    const ext = src.split('.').pop().split('?')[0].toLowerCase().replace('jpeg', 'jpg');
    const file = `${code}.${['png', 'jpg', 'svg', 'gif'].includes(ext) ? ext : 'png'}`;
    fs.writeFileSync(path.join(logosDir, file), Buffer.from(await img.arrayBuffer()));
    manifest[code] = `logos/${file}`;
    console.log(`OK  ${code}: ${file}`);
  } catch (err) {
    console.log(`--  ${code}: ${err.message}`);
  }
}

fs.writeFileSync(path.join(logosDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`manifest: ${Object.keys(manifest).length}/${Object.keys(ARTICLES).length} logos`);
