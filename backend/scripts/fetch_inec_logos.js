// Download official party logos from INEC's registered-parties page into
// app/logos/ and rebuild the manifest. INEC entries override any previous
// (e.g. Wikipedia) files — one consistent, official set.
//
//   node scripts/fetch_inec_logos.js
//
// NOTE: inecnigeria.org serves an incomplete TLS chain, so certificate
// verification is disabled FOR THIS SCRIPT ONLY (public asset download, no
// credentials involved).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logosDir = path.join(backendRoot, '..', 'app', 'logos');
fs.mkdirSync(logosDir, { recursive: true });

const knownCodes = new Set(
  JSON.parse(fs.readFileSync(path.join(backendRoot, 'src', 'data', 'parties.json'), 'utf8')).map((p) => p.code),
);

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' };
const BASE = 'https://www.inecnigeria.org';

// The list is paginated; walk pages until one 404s or repeats nothing new.
let html = '';
for (let page = 1; page <= 6; page++) {
  const url = page === 1 ? `${BASE}/list-of-political-parties/` : `${BASE}/list-of-political-parties/page/${page}/`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) break;
  html += await res.text();
  console.log(`fetched page ${page}`);
}

// <img ... alt="Party Name (CODE)" src="/wp-content/uploads/....ext" />
const re = /<img[^>]+alt="([^"]+)\(([A-Za-z0-9]+)\)"[^>]+src="([^"]+wp-content\/uploads\/[^"]+\.(?:png|jpe?g|gif|webp))"/g;
const manifestPath = path.join(logosDir, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

let found = 0;
let saved = 0;
const unknown = [];
for (const m of html.matchAll(re)) {
  const code = m[2].toUpperCase();
  const src = m[3].startsWith('http') ? m[3] : BASE + m[3];
  found++;
  if (!knownCodes.has(code)) {
    unknown.push(`${code} (${m[1].trim()})`);
    continue;
  }
  try {
    const img = await fetch(src, { headers: UA });
    if (!img.ok) throw new Error(`HTTP ${img.status}`);
    const ext = src.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
    const file = `${code}.${ext}`;
    fs.writeFileSync(path.join(logosDir, file), Buffer.from(await img.arrayBuffer()));
    manifest[code] = `logos/${file}`;
    saved++;
    console.log(`OK  ${code} <- ${src.split('/').pop()}`);
  } catch (err) {
    console.log(`--  ${code}: ${err.message}`);
  }
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`\nmatched ${found} logos on the page; saved ${saved}; manifest now ${Object.keys(manifest).length} entries`);
if (unknown.length) {
  console.log('on INEC page but not in parties.json (check registrations!):', unknown.join(', '));
}
