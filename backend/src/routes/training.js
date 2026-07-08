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
const isImage = (f) => /\.(jpe?g|png)$/i.test(f);
const keyOf = (f) => f.replace(/\.[^.]+$/, '');
const jsonPath = (name) => path.join(dir(), name);
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(jsonPath(name), 'utf8')); } catch { return {}; } };
const writeJson = (name, obj) => fs.writeFileSync(jsonPath(name), JSON.stringify(obj, null, 1));

const readTruth = () => readJson('truth.json');
// sets.json partitions sheets between labelling pages (train.html = set 1,
// train2.html = set 2, …) so parallel labellers never see each other's queue.
// A sheet is "claimed" once it has a set here; unclaimed sheets are the pool a
// labeller draws a fresh batch from via POST /training/generate.
const readSets = () => readJson('sets.json');
// labellers.json maps sheet key -> observer id who labelled it, so each scorer's
// running total is the number of DISTINCT sheets attributed to them (re-saving
// the same sheet never double-counts).
const readLabellers = () => readJson('labellers.json');
const mineCount = (labellers, oid) => Object.values(labellers).filter((v) => v === oid).length;

// Unclaimed + unlabelled sheets — the reservoir a labeller can pull a batch from.
const poolFiles = () => {
  const truth = readTruth();
  const sets = readSets();
  return fs.readdirSync(dir()).filter((f) => isImage(f) && !sets[f] && !truth[keyOf(f)]);
};

trainingRouter.get('/training/items', (req, res) => {
  const truth = readTruth();
  const sets = readSets();
  const want = Number(req.query.set || 0); // 0 = all
  const items = fs.readdirSync(dir()).filter(isImage)
    .map((f) => ({ file: f, key: keyOf(f), set: sets[f] || 0, labelled: Boolean(truth[keyOf(f)]) }))
    .filter((i) => !want || i.set === want);
  res.json({ items, labelled: Object.keys(truth).length, available: poolFiles().length });
});

// A labeller's own running total (distinct sheets they've labelled, all-time).
trainingRouter.get('/training/mine', requireObserver, (req, res) => {
  res.json({ mine: mineCount(readLabellers(), req.observer.id) });
});

// Claim a fresh batch of `count` unclaimed sheets into `set` (this page's queue).
// Over-asking fails with the true number still available, so nothing is claimed.
trainingRouter.post('/training/generate', requireObserver, (req, res) => {
  const set = Math.max(1, Math.floor(Number(req.body?.set) || 1));
  const count = Math.floor(Number(req.body?.count));
  if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'bad_count' });
  const pool = poolFiles();
  if (count > pool.length) return res.status(400).json({ error: 'not_enough', available: pool.length });
  // shuffle so a batch spans states/LGAs rather than one contiguous block
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const claimed = pool.slice(0, count);
  const sets = readSets();
  for (const f of claimed) sets[f] = set;
  writeJson('sets.json', sets);
  res.status(201).json({ claimed: claimed.length, remaining: pool.length - count });
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
  writeJson('truth.json', truth);
  const labellers = readLabellers();
  labellers[key] = req.observer.id;   // attribute this sheet to the scorer
  writeJson('labellers.json', labellers);
  res.status(201).json({ ok: true, labelled: Object.keys(truth).length, mine: mineCount(labellers, req.observer.id) });
});
