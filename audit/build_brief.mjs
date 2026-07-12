import { chromium } from 'playwright';
import fs from 'node:fs';
const DL = '/mnt/c/Users/HP/Downloads';
const b64 = (p, mime) => `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
let html = fs.readFileSync(new URL('./brief.html', import.meta.url), 'utf8');
html = html
  .replace('SHOT', b64(`${DL}/hawkeye-ledger.png`, 'image/png'))
  .replace('LOGO', b64(new URL('../app/logo.svg', import.meta.url).pathname, 'image/svg+xml'));
const br = await chromium.launch();
const p = await br.newPage();
await p.setContent(html, { waitUntil: 'networkidle' });
await p.pdf({ path: `${DL}/Hawkeye-Brief.pdf`, format: 'A4', printBackground: true,
  margin: { top: '0', bottom: '0', left: '0', right: '0' } });
console.log('wrote Hawkeye-Brief.pdf');
await br.close();
