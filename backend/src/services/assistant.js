// Hawkeye results assistant — a non-partisan, read-only natural-language layer over
// the public data. Claude answers questions by calling a small set of read-only
// Hawkeye API tools; it never sees write endpoints and never declares winners.
// Off entirely unless ANTHROPIC_API_KEY is set (config.anthropicApiKey).
import { config } from '../config.js';

const API = 'https://api.anthropic.com/v1/messages';

// Read-only lookups for the tools. Try localhost first (fast path), fall back to
// the public URL — under Passenger the app may sit on a unix socket, not a TCP
// port, so 127.0.0.1 isn't guaranteed. All endpoints here are public data.
async function ownApi(p) {
  const headers = config.originAuthSecret ? { 'x-origin-auth': config.originAuthSecret } : {};
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}${p}`, { headers, signal: AbortSignal.timeout(4000) });
    if (r.ok) return await r.json();
    throw new Error('local ' + r.status);
  } catch {
    const r = await fetch(`https://hawkeye.com.ng${p}`, { signal: AbortSignal.timeout(15_000) });
    return await r.json();
  }
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

// Free-tier provider chain: first configured provider answers; a failure or an
// exhausted quota (429/5xx) falls through to the next. All OpenAI-compatible.
export function providerChain() {
  const P = [];
  if (config.assistantApiKey) {
    const models = [...new Set([process.env.ASSISTANT_MODEL || 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'])];
    for (const model of models) P.push({ name: `gemini:${model}`, base: config.assistantApiBase, key: config.assistantApiKey, model });
  }
  if (process.env.GROQ_API_KEY) P.push({ name: 'groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' });
  if (process.env.MISTRAL_API_KEY) P.push({ name: 'mistral', base: 'https://api.mistral.ai/v1', key: process.env.MISTRAL_API_KEY, model: process.env.MISTRAL_MODEL || 'mistral-small-latest' });
  if (process.env.OPENROUTER_API_KEY) P.push({ name: 'openrouter', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free' });
  return P;
}

// One OpenAI-format chat call against a specific provider. Throws on failure so
// the chain can fall through. Exported for other AI features (triage etc.).
export async function chatComplete(provider, messages, { tools = null, maxTokens = 700 } = {}) {
  const body = { model: provider.model, max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${provider.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 500 && attempt === 0) { await new Promise((r) => setTimeout(r, 2500)); continue; }
    if (!res.ok) throw new Error(`${provider.name} ${res.status}`);
    const data = await res.json();
    const m = data.choices?.[0]?.message;
    if (!m) throw new Error(`${provider.name} empty`);
    return m;
  }
}

export async function askAssistant(question, { debug = false } = {}) {
  if (config.anthropicApiKey) return askClaude(question);
  const chain = providerChain();
  if (!chain.length) return { error: 'assistant_unconfigured' };
  const errs = [];
  for (const provider of chain) {
    try { return await askOpenAICompat(provider, question); }
    catch (e) { errs.push(e.message); console.error('[assistant]', e.message); }
  }
  return debug ? { error: 'assistant_error', detail: errs } : { error: 'assistant_error' };
}

async function askOpenAICompat(provider, question) {
  const tools = TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(question || '').slice(0, 500) },
  ];
  for (let step = 0; step < 4; step++) {
    const m = await chatComplete(provider, messages, { tools });
    messages.push(m);
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }
        const out = await runTool(tc.function?.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 4000) });
      }
      continue;
    }
    return { answer: (m.content || '').trim() || 'No answer available.' };
  }
  return { answer: 'That needed too many steps — try a more specific question.' };
}

async function askClaude(question) {
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

export const assistantEnabled = () => Boolean(config.anthropicApiKey || providerChain().length);
