// Daily SQLite snapshots (in-process — no cron on the shared host). Uses the
// SQLite online-backup API (safe while serving traffic), gzips, keeps the last 7.
// Off-host copies: run scripts/pull_backup.sh from any machine to download the
// latest snapshot via the DirectAdmin API.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db } from '../db.js';
import { config } from '../config.js';

const backupDir = path.join(path.dirname(config.dbPath), 'backups');
const KEEP = 7;

export async function runBackup() {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const raw = path.join(backupDir, `hawkeye-${stamp}.db`);
  const gz = raw + '.gz';
  if (fs.existsSync(gz)) return gz; // one per day
  await db.backup(raw);
  await new Promise((resolve, reject) => {
    fs.createReadStream(raw)
      .pipe(zlib.createGzip({ level: 6 }))
      .pipe(fs.createWriteStream(gz))
      .on('finish', resolve)
      .on('error', reject);
  });
  fs.rmSync(raw, { force: true });
  const old = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db.gz')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) {
    fs.rmSync(path.join(backupDir, f), { force: true });
  }
  console.log('[backup] wrote', gz);
  return gz;
}
