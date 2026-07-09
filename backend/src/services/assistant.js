// Hawkeye results assistant — a non-partisan, read-only natural-language layer over
// the public data. Claude answers questions by calling a small set of read-only
// Hawkeye API tools; it never sees write endpoints and never declares winners.
// Off entirely unless ANTHROPIC_API_KEY is set (config.anthropicApiKey).
import { config } from '../config.js';

const API = 'https://api.anthropic.com/v1/messages';

// Internal read-only calls (the origin lock also guards localhost, so stamp it).
function ownApi(p) {
  const headers = config.originAuthSecret ? { 'x-origin-auth': config.originAuthSecret } : {};
  return fetch(`http://127.0.0.1:${config.port}${p}`, { headers }).then((r) => r.json());
}

const TOOLS = [
  {
    name: 'national_results',
    description: 'Crowd-reported (UNOFFICIAL) national tally for a contest. contest is one of PRES, SEN, REP, GOV, SHA.',
    input_schema: { type: 'object', properties: { contest: { type: 'string' } }, required: ['contest'] },
  },
  {
    name: 'coverage',
    description: 'How many of Nigeria\'s 176,846 polling units have GPS locations, and overall reporting coverage so far.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'polling_unit',
    description: 'Look up one polling unit by its code, e.g. 25-01-05-012 (state-LGA-ward-unit).',
    input_schema: { type: 'object', properties: { pu_code: { type: 'string' } }, required: ['pu_code'] },
  },
];

async function runTool(name, input) {
  try {
    if (name === 'national_results') return await ownApi('/api/national/' + encodeURIComponent(String(input.contest || 'PRES').toUpperCase()));
    if (name === 'coverage') return await ownApi('/api/coverage');
    if (name === 'polling_unit') return await ownApi('/api/register/unit?pu_code=' + encodeURIComponent(String(input.pu_code || '')));
  } catch { return { error: 'lookup_failed' }; }
  return { error: 'unknown_tool' };
}

const SYSTEM = [
  'You are the Hawkeye assistant. Hawkeye is an independent, NON-PARTISAN election-results',
  'transparency tool for Nigeria: it publishes crowd-verified EVIDENCE of what was announced at',
  'polling units — it does NOT declare winners; only INEC declares official results.',
  'Rules: answer ONLY from the tool data; if the data is not available, say so plainly.',
  'Always make clear that figures are crowd-reported and unofficial. Never predict or declare a',
  'winner, never give partisan or campaign commentary, never speculate beyond the numbers.',
  'Be concise and factual. If asked something outside election results/coverage, briefly redirect.',
].join(' ');

export async function askAssistant(question) {
  if (!config.anthropicApiKey) return { error: 'assistant_unconfigured' };
  const messages = [{ role: 'user', content: String(question || '').slice(0, 500) }];
  for (let step = 0; step < 4; step++) {
    let data;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.assistantModel, max_tokens: 700, system: SYSTEM, tools: TOOLS, messages }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { error: 'assistant_error' };
      data = await res.json();
    } catch { return { error: 'assistant_error' }; }
    messages.push({ role: 'assistant', content: data.content });
    if (data.stop_reason === 'tool_use') {
      const results = [];
      for (const b of data.content || []) {
        if (b.type === 'tool_use') {
          const out = await runTool(b.name, b.input || {});
          results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 4000) });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { answer: text || 'No answer available.' };
  }
  return { answer: 'That needed too many steps — try a more specific question.' };
}

export const assistantEnabled = () => Boolean(config.anthropicApiKey);
