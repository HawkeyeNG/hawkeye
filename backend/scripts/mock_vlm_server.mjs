/**
 * Stand-in for the vLLM server, so vlm_worker.mjs and the schema can be changed
 * and proven without a GPU:
 *
 *   node scripts/mock_vlm_server.mjs &
 *   VISION_API_BASE=http://127.0.0.1:8799/v1 node scripts/vlm_worker.mjs --dir <sheets> --out /tmp/run.jsonl
 *
 * It serves /v1/models and /v1/chat/completions with canned EC8A transcriptions
 * chosen to hit every verdict — clean, figures-vs-words conflict, over-voting,
 * fully unreadable, and one wrapped in a code fence. It also ASSERTS what the
 * worker sent (an image part, a json_schema response_format, temperature 0) and answers 400 if any
 * of it is missing, so a request-shape regression fails here rather than after
 * the pod is already running and billing.
 */
import http from 'node:http';

let seen = 0;
let boxSeen = 0;
const SHEETS = [
  // clean, self-verifying
  { authentic: 'yes', reason: null, state: 'OSUN', puCode: '29-01-01-001',
    registered: 500, accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
    parties: [
      { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
      { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY' },
      { party: 'LP', figures: 0, words: 'ZERO' },
    ] },
  // figures and words disagree on one row -> must NOT be publishable
  { authentic: 'yes', reason: null, state: 'OSUN', puCode: '29-01-01-002',
    registered: 500, accredited: 300, spoiled: 0, rejected: 0, totalValid: 280, usedBallots: 280,
    parties: [
      { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
      { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY ONE' },
    ] },
  // over-voting -> flagged
  { authentic: 'yes', reason: null, state: 'OSUN', puCode: '29-01-01-003',
    registered: 500, accredited: 200, spoiled: 0, rejected: 0, totalValid: 260, usedBallots: 260,
    parties: [{ party: 'APC', figures: 260, words: 'TWO HUNDRED AND SIXTY' }] },
  // unreadable sheet -> nulls everywhere, no invented figures
  { authentic: 'unclear', reason: 'photo too dark', state: null, puCode: null,
    registered: null, accredited: null, spoiled: null, rejected: null, totalValid: null, usedBallots: null,
    parties: [{ party: 'APC', figures: null, words: null }] },
  // prose-wrapped reply -> exercises parseModelJson's fenced path
  '```json\n{"authentic":"yes","state":"OSUN","puCode":"29-01-01-005","registered":400,'
    + '"accredited":250,"spoiled":1,"rejected":1,"totalValid":248,"usedBallots":250,'
    + '"parties":[{"party":"APC","figures":248,"words":"TWO HUNDRED AND FORTY EIGHT"}]}\n```',
];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) {
      return res.end(JSON.stringify({ data: [{ id: 'Qwen/Qwen2.5-VL-7B-Instruct' }] }));
    }
    const req_ = JSON.parse(body || '{}');
    // The worker's structured-output probe: no image, schema named 'probe'.
    // A real constrained server answers with exactly the schema; answering it
    // here is what lets the mock exercise the refuse-to-run path both ways.
    const rf = req_.response_format;
    // The box pass: schema named 'ec8a_boxes'. Canned replies exercise the
    // merge paths - clean text, zero-padding, dashes, NIL, and a null.
    if (rf && rf.json_schema && rf.json_schema.name === 'ec8a_boxes') {
      const canned = [
        { registered: '949', accredited: '217', ballotsIssued: '949', unusedBallots: '732', spoiled: '-0-', rejected: '04', totalValid: '213', usedBallots: '217' },
        { registered: '775', accredited: '255', ballotsIssued: '775', unusedBallots: '514', spoiled: '06', rejected: '03', totalValid: '252', usedBallots: '261' },
        { registered: null, accredited: 'NIL', ballotsIssued: null, unusedBallots: null, spoiled: null, rejected: null, totalValid: '112', usedBallots: '113' },
      ];
      const pick = canned[boxSeen++ % canned.length];
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(pick) } }] }));
    }
    if (rf && rf.json_schema && rf.json_schema.name === 'probe') {
      if (process.env.MOCK_NO_STRUCTURED) {
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello! How can I help?' } }] }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] }));
    }
    // Assert the worker actually sent what it claims to send.
    const parts = req_.messages?.[0]?.content || [];
    const hasImage = parts.some((p) => p.type === 'image_url' && /^data:image\/jpeg;base64,/.test(p.image_url?.url || ''));
    const hasGuided = Boolean(req_.response_format && req_.response_format.type === "json_schema");
    if (!hasImage) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'no image part' })); }
    if (!hasGuided) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'guided_json missing' })); }
    if (req_.temperature !== 0) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'temperature not 0' })); }
    const pick = SHEETS[seen++ % SHEETS.length];
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: typeof pick === 'string' ? pick : JSON.stringify(pick) } }],
    }));
  });
}).listen(8799, () => console.log('mock vlm on :8799'));
