/**
 * Send ONE party-table request and print the server's actual complaint.
 *
 *   node scripts/debug_party_request.mjs 29-01-01-001.jpg
 *
 * The worker reports "vlm-party 400" and retries, which tells you nothing —
 * a 400 from vLLM carries a specific message about which part of the request
 * it rejected, and that message is what decides whether the fix is the schema,
 * the prompt length, or the image.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { partyTablePrompt, partyTableSchema, OSUN_2026_BALLOT, PARTY_TABLE_CROP } from '../src/services/ec8a_prompt.js';

const file = process.argv[2] || '29-01-01-001.jpg';
const dir = process.argv[3] || 'storage/audit-osun2026/sheets';
const full = path.join(dir, file);

const m = await sharp(full).metadata();
const left = Math.round(m.width * PARTY_TABLE_CROP.left);
const right = Math.round(m.width * PARTY_TABLE_CROP.right);
const top = Math.round(m.height * PARTY_TABLE_CROP.top);
const bottom = Math.round(m.height * PARTY_TABLE_CROP.bottom);
const buf = await sharp(full)
  .extract({ left, top, width: right - left, height: bottom - top })
  .resize({ width: Math.round((right - left) * PARTY_TABLE_CROP.scale), kernel: 'lanczos3' })
  .jpeg({ quality: 88 })
  .toBuffer();

console.log(`crop: ${right - left}x${bottom - top} -> ${PARTY_TABLE_CROP.scale}x = ${Math.round((right - left) * PARTY_TABLE_CROP.scale)}px wide`);
console.log(`jpeg bytes: ${buf.length} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`base64 chars: ${buf.toString('base64').length}`);

const body = {
  model: config.visionModel,
  temperature: 0,
  max_tokens: 1600,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: partyTablePrompt(OSUN_2026_BALLOT) },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
    ],
  }],
  response_format: { type: 'json_schema', json_schema: { name: 'ec8a_party_table', schema: partyTableSchema(OSUN_2026_BALLOT) } },
};

const r = await fetch(`${config.visionApiBase}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${config.visionApiKey || 'dummy'}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180_000),
});

const text = await r.text();
console.log(`\nHTTP ${r.status}`);
// The token count is the number that decides max-model-len, KV-cache sizing and
// therefore how many requests can run at once. Guessing it from image
// dimensions is how the 8k context got overrun in the first place.
try {
  const j = JSON.parse(text);
  if (j.usage) {
    console.log(`prompt_tokens ${j.usage.prompt_tokens} · completion ${j.usage.completion_tokens}`
      + ` · total ${j.usage.total_tokens}`);
  }
  console.log(text.slice(0, 1200));
} catch { console.log(text.slice(0, 1200)); }
