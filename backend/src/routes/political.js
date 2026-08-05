import { Router } from 'express';

import { upstream } from '../services/political.js';

export const politicalRouter = Router();

/**
 * The refreshed upstream snapshot ONLY — deliberately not merged with the
 * curated app/political_data.json.
 *
 * The client already ships that file, so merging here would mean the backend
 * reaching across into the web root to read it, coupling two deploy units for
 * no gain. The page holds the curated figures as authoritative and uses this
 * for state assemblies (which have no curated equivalent) and to cross-check
 * the chambers.
 *
 * 200 with `{ ok: false }` rather than a 5xx when the pull fails: this is
 * enrichment, and the page must render from its own JSON regardless.
 */
politicalRouter.get('/political', async (_req, res) => {
  const data = await upstream();
  res.set('cache-control', 'public, max-age=1800');
  if (!data) return res.json({ ok: false, reason: 'upstream_unavailable' });
  return res.json({ ok: true, ...data });
});
