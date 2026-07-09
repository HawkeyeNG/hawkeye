import { Router } from 'express';
import { askAssistant, assistantEnabled } from '../services/assistant.js';

export const assistantRouter = Router();

// Lets the web widget mount only when the feature is switched on (key present).
assistantRouter.get('/assistant/health', (_req, res) => res.json({ enabled: assistantEnabled() }));

assistantRouter.post('/assistant', async (req, res) => {
  const q = String(req.body?.question || '').trim();
  if (!q) return res.status(400).json({ error: 'empty_question' });
  const r = await askAssistant(q);
  if (r.error === 'assistant_unconfigured') return res.status(503).json({ error: 'assistant_unconfigured' });
  if (r.error) return res.status(502).json({ error: 'assistant_error' });
  res.json({ answer: r.answer });
});
