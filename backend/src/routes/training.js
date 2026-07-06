import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { ocrMatchCounts } from '../services/ocr.js';
import { requireObserver } from './observers.js';

// Human-in-the-loop OCR training: sheets in storage/training/ are shown on
// train.html with the OCR's predicted digit tokens; a verified observer confirms
// or corrects the real counts, which land in truth.json — the calibration set.
export const trainingRouter = Router();
const dir = () => {
  const d = path.join(path.dirname(config.dbPath), 'training');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const truthPath = () => path.join(dir(), 'truth.json');
const readTruth = () => (fs.existsSync(truthPath()) ? JSON.parse(fs.readFileSync(truthPath(), 'utf8')) : {});

trainingRouter.get('/training/items', (_req, res) => {
  const truth = readTruth();
  const items = fs.readdirSync(dir()).filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((f) => ({ file: f, key: f.replace(/\.[^.]+$/, ''), labelled: Boolean(truth[f.replace(/\.[^.]+$/, '')]) }));
  res.json({ items, labelled: Object.keys(truth).length });
});

trainingRouter.get('/training/ocr/:file', requireObserver, async (req, res) => {
  const f = path.join(dir(), path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not_found' });
  const r = await ocrMatchCounts(fs.readFileSync(f), [{ party: 'X', count: 1 }]);
  res.json({ tokens: r?.tokens || [] });
});

trainingRouter.post('/training/label', requireObserver, (req, res) => {
  const key = String(req.body?.key || '').replace(/[^A-Za-z0-9_-]/g, '');
  const counts = req.body?.counts;
  if (!key || typeof counts !== 'object') return res.status(400).json({ error: 'bad_label' });
  const clean = {};
  for (const [p, c] of Object.entries(counts)) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) clean[String(p).toUpperCase().slice(0, 6)] = n;
  }
  const truth = readTruth();
  truth[key] = clean;
  fs.writeFileSync(truthPath(), JSON.stringify(truth, null, 1));
  res.status(201).json({ ok: true, labelled: Object.keys(truth).length });
});
