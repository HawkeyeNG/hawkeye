// Download party logos from the parties' OWN websites (better provenance than
// Wikipedia, whose major-party logo files are non-free and API-inaccessible).
// For each party: try candidate official domains, extract the best logo candidate
// (og:image -> apple-touch-icon -> <img> with "logo" in src/alt/class), download,
// and record provenance in app/logos/sources.json. Existing manifest entries are
// only overwritten on success.
//
//   node scripts/fetch_party_logos_official.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const logosDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'logos');
fs.mkdirSync(logosDir, { recursive: true });
const manifestPath = path.join(logosDir, 'manifest.json');
const sourcesPath = path.join(logosDir, 'sources.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const sources = fs.existsSync(sourcesPath) ? JSON.parse(fs.readFileSync(sourcesPath, 'utf8')) : {};

const CANDIDATES = {
  APC: ['https://officialapcng.com', 'https://apc.com.ng'],
  PDP: ['https://officialpdpnig.com', 'https://pdp.org.ng', 'https://peoplesdemocraticparty.com.ng'],
  LP: ['https://labourpartynigeria.org', 'https://labourparty.com.ng'],
  NNPP: ['https://nnpp.org.ng', 'https://thennpp.com'],
  APGA: ['https://apga.org.ng', 'https://apgaonline.org'],
  ADC: ['https://adcnigeria.org', 'https://adcparty.org'],
  SDP: ['https://sdp.org.ng', 'https://socialdemocraticparty.org.ng'],
  AAC: ['https://aacparty.org', 'https://takeitback.org'],
  YPP: ['https://ypp.org.ng', 'https://youngprogressivesparty.org'],
  ADP: ['https://adp.org.ng', 'https://actiondemocraticparty.com.ng'],
  A: ['https://accordparty.org.ng', 'https://accordparty.org'],
  PRP: ['https://prpnigeria.org', 'https://peoplesredemptionparty.org.ng'],
  APM: ['https://apm.org.ng'],
  APP: ['https://actionpeoplesparty.org'],
  AA: ['https://actionalliance.org.ng'],
  BP: ['https://bootparty.org.ng'],
  NRM: ['https://nrm.org.ng'],
  ZLP: ['https://zenithlabourparty.org'],
};

const UA = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};

function extractLogoUrl(html, base) {
  const pats = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']*logo[^"']*)["']/i,
    /<img[^>]+class=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i,
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+\.(?:png|jpg|jpeg|webp))["']/i,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (m) {
      try {
        return new URL(m[1], base).href;
      } catch {
        /* malformed url — try next pattern */
      }
    }
  }
  return null;
}

async function tryFetch(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    return await fetch(url, { headers: UA, redirect: 'follow', signal: ctl.signal, ...opts });
  } finally {
    clearTimeout(timer);
  }
}

for (const [code, urls] of Object.entries(CANDIDATES)) {
  let done = false;
  for (const site of urls) {
    if (done) break;
    try {
      const res = await tryFetch(site);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const logoUrl = extractLogoUrl(html, res.url);
      if (!logoUrl) throw new Error('no logo candidate in HTML');
      const img = await tryFetch(logoUrl);
      const type = img.headers.get('content-type') || '';
      if (!img.ok || !type.startsWith('image/')) throw new Error(`logo fetch: ${img.status} ${type}`);
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length < 1500) throw new Error(`too small (${buf.length}B — likely a favicon)`);
      const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').split(';')[0];
      const file = `${code}.${ext}`;
      fs.writeFileSync(path.join(logosDir, file), buf);
      manifest[code] = `logos/${file}`;
      sources[code] = { site: res.url, image: logoUrl, bytes: buf.length, fetched: new Date().toISOString().slice(0, 10) };
      console.log(`OK  ${code}: ${file} (${(buf.length / 1024).toFixed(0)} KiB) from ${res.url}`);
      done = true;
    } catch (err) {
      console.log(`--  ${code} @ ${site}: ${err.message}`);
    }
  }
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 1));
console.log(`\nmanifest now covers ${Object.keys(manifest).length}/18 parties`);
