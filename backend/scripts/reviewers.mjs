#!/usr/bin/env node
/**
 * Who may review flagged audit sheets.
 *
 *   node backend/scripts/reviewers.mjs list
 *   node backend/scripts/reviewers.mjs add 42
 *   node backend/scripts/reviewers.mjs remove 42
 *   node backend/scripts/reviewers.mjs whoami          (recently active observers)
 *
 * The review endpoints admit only these observer ids. `requireObserver` alone is
 * not an audit credential — it admits anyone who has passed a phone OTP, the
 * same credential used to file an ordinary field report — and these endpoints
 * write the evidence base immutably, with no delete route.
 *
 * The list is read per request, so a change here takes effect immediately. No
 * restart, no redeploy.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FILE = path.join(ROOT, 'backend/storage/audit_review/reviewers.json');
const DB = path.join(ROOT, 'backend/storage/hawkeye.db');

const read = () => {
  if (!fs.existsSync(FILE)) return [];
  const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return (Array.isArray(d) ? d : d.observers || []).map(String);
};
const write = (ids) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(
    { note: 'Observer ids allowed to review flagged audit sheets. Read per request.', observers: ids },
    null, 1,
  ));
};

const [cmd, arg] = process.argv.slice(2);
const db = fs.existsSync(DB) ? new Database(DB, { readonly: true }) : null;

const describe = (id) => {
  if (!db) return '';
  const o = db.prepare('SELECT status FROM observers WHERE id = ?').get(Number(id));
  if (!o) return '  (NO SUCH OBSERVER)';
  return o.status === 'active' ? '  (active)' : `  (status: ${o.status})`;
};

if (cmd === 'list' || !cmd) {
  const ids = read();
  const env = String(process.env.REVIEW_OBSERVER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`reviewers.json: ${path.relative(ROOT, FILE)}`);
  if (!ids.length) console.log('  (empty — nobody can review; the endpoints fail closed)');
  for (const id of ids) console.log(`  ${id}${describe(id)}`);
  if (env.length) console.log(`\nalso allowed via REVIEW_OBSERVER_IDS: ${env.join(', ')}`);
} else if (cmd === 'add') {
  if (!/^\d+$/.test(String(arg || ''))) { console.error('usage: reviewers.mjs add <observerId>'); process.exit(1); }
  if (db) {
    const o = db.prepare('SELECT id, status FROM observers WHERE id = ?').get(Number(arg));
    // Refuse silently-useless additions: an id that does not exist, or one whose
    // observer is deleted, would sit in the file looking like access.
    if (!o) { console.error(`observer ${arg} does not exist`); process.exit(1); }
    if (o.status !== 'active') { console.error(`observer ${arg} is "${o.status}", not active`); process.exit(1); }
  }
  const ids = read();
  if (ids.includes(String(arg))) { console.log(`observer ${arg} is already a reviewer`); process.exit(0); }
  ids.push(String(arg));
  write(ids);
  console.log(`added observer ${arg} — effective immediately, no restart needed`);
  console.log(`reviewers now: ${ids.join(', ')}`);
} else if (cmd === 'remove') {
  const ids = read().filter((i) => i !== String(arg));
  write(ids);
  console.log(`removed observer ${arg}`);
  console.log(ids.length ? `reviewers now: ${ids.join(', ')}` : 'no reviewers left — the endpoints now fail closed');
} else if (cmd === 'whoami') {
  // You cannot tell which observer you are from the database alone — rows hold a
  // phone HASH, never a number. What you can do is find the ones that have been
  // active, which is usually enough to recognise yourself; failing that, open
  // the Review tab and the refusal names your id.
  if (!db) { console.error('no database'); process.exit(1); }
  const rows = db.prepare(`
    SELECT o.id, o.status, o.created_at,
           (SELECT COUNT(*) FROM submissions s WHERE s.observer_id = o.id) AS reports
      FROM observers o WHERE o.status = 'active'
     ORDER BY reports DESC, o.id DESC LIMIT 15`).all();
  console.log('most active observers (the database stores a phone HASH, never a number):');
  for (const r of rows) {
    console.log(`  id ${String(r.id).padStart(4)}  reports ${String(r.reports).padStart(4)}  `
      + `created ${new Date(r.created_at).toISOString().slice(0, 10)}`);
  }
  console.log('\nIf none of these is obviously you: open the Review tab on train.html —');
  console.log('the refusal tells you your own observer id.');
} else {
  console.error('usage: reviewers.mjs list | add <id> | remove <id> | whoami');
  process.exit(1);
}
