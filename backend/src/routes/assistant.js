import { Router } from 'express';
import { askAssistant, assistantEnabled } from '../services/assistant.js';

export const assistantRouter = Router();

// Lets the web widget mount only when the feature is switched on (key present).
assistantRouter.get('/assistant/health', (_req, res) => res.json({ enabled: assistantEnabled() }));

// Always answer 200 with either {answer} or {error} — origin 5xx here gets
// replaced by Cloudflare's own error page, which hides the JSON from the widget.
assistantRouter.post('/assistant', async (req, res) => {
  const q = String(req.body?.question || '').trim();
  if (!q) return res.status(400).json({ error: 'empty_question' });
  const r = await askAssistant(q, { debug: req.body?.debug === true });
  res.json(r.error ? { error: r.error, ...(r.detail ? { detail: r.detail } : {}) } : { answer: r.answer });
});
