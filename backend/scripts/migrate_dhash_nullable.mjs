/**
 * Let image_dhash / venue_image_dhash be NULL. Prerequisite for UPLOAD_MODE=direct.
 *
 *   node scripts/migrate_dhash_nullable.mjs           # report only
 *   node scripts/migrate_dhash_nullable.mjs --apply
 *
 * WHY. In direct mode the origin never receives the pixels, so it cannot compute
 * a perceptual hash at submission time; services/analysis-queue.js fills these
 * in moments later from the bucket. The columns are currently NOT NULL, so there
 * is nothing honest to put in them meanwhile.
 *
 * WHY NOT LET THE CLIENT SUPPLY IT. That was the first design, and it was
 * measured and abandoned. A browser canvas cannot reproduce sharp's dhash: over
 * 24 real sheets, comparing canvas against sharp gave ZERO exact matches, a
 * median Hamming distance of 10 bits and a max of 16 — against a near-duplicate
 * threshold of 4. Two variants were tried (direct 9x8 draw, and stepwise
 * halving); both landed in the same place. A client value that far off is not
 * merely useless for duplicate detection, it is further from the truth than two
 * genuinely similar photos are from each other, so every honest submission would
 * have been flagged as tampering.
 *
 * WHY A SCRIPT AND NOT A BOOT MIGRATION. This rebuilds the table the ledger
 * hangs off. A rebuild that runs automatically would run for the first time on
 * whatever day someone restarts the server, and that day might be 16 January.
 * Run it deliberately, read the output, then enable direct mode.
 *
 * SAFE: everything happens in one transaction, the row count is compared before
 * and after, indexes are recreated from sqlite_master, and the whole thing is a
 * no-op if the columns are already nullable.
 */
import { db } from '../src/db.js';

const APPLY = process.argv.includes('--apply');

const info = db.prepare("SELECT name, `notnull` FROM pragma_table_info('submissions')").all();
const targets = ['image_dhash', 'venue_image_dhash'];
const state = Object.fromEntries(info.filter((c) => targets.includes(c.name)).map((c) => [c.name, c.notnull]));
console.log('current:', state);

if (targets.every((t) => state[t] === 0)) {
  console.log('Already nullable. Nothing to do.');
  process.exit(0);
}
if (targets.some((t) => state[t] === undefined)) {
  console.error('FAIL: expected columns not found — refusing to touch this table.');
  process.exit(1);
}

const rowCount = db.prepare('SELECT COUNT(*) c FROM submissions').get().c;
const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='submissions'").get().sql;
const indexes = db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='submissions' AND sql IS NOT NULL",
).all();

// Drop NOT NULL from exactly these two column definitions and nothing else.
let newSql = createSql;
for (const t of targets) {
  const re = new RegExp(`(\\b${t}\\s+TEXT)\\s+NOT\\s+NULL`, 'i');
  if (!re.test(newSql)) {
    console.error(`FAIL: could not find "${t} TEXT NOT NULL" in the schema — refusing to guess.`);
    process.exit(1);
  }
  newSql = newSql.replace(re, '$1');
}
newSql = newSql.replace(/CREATE TABLE\s+"?submissions"?/i, 'CREATE TABLE submissions_new');

console.log(`\nrows: ${rowCount}   indexes to recreate: ${indexes.length}`);
if (!APPLY) {
  console.log('\nDRY RUN. New table definition would be:\n');
  console.log(newSql);
  console.log('\nRe-run with --apply.');
  process.exit(0);
}

const cols = info.map((c) => `"${c.name}"`).join(', ');
db.pragma('foreign_keys = OFF');
try {
  db.transaction(() => {
    db.exec(newSql);
    db.exec(`INSERT INTO submissions_new (${cols}) SELECT ${cols} FROM submissions`);
    db.exec('DROP TABLE submissions');
    db.exec('ALTER TABLE submissions_new RENAME TO submissions');
    for (const ix of indexes) db.exec(ix.sql);
  })();
} finally {
  db.pragma('foreign_keys = ON');
}

// ---- verify, with a control ------------------------------------------------
const after = Object.fromEntries(
  db.prepare("SELECT name, `notnull` FROM pragma_table_info('submissions')").all()
    .filter((c) => targets.includes(c.name)).map((c) => [c.name, c.notnull]),
);
const afterRows = db.prepare('SELECT COUNT(*) c FROM submissions').get().c;
const afterIx = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND tbl_name='submissions' AND sql IS NOT NULL").get().c;

console.log('\nafter:', after);
console.log(`rows: ${rowCount} -> ${afterRows}`);
console.log(`indexes: ${indexes.length} -> ${afterIx}`);

const ok = targets.every((t) => after[t] === 0) && afterRows === rowCount && afterIx === indexes.length;

// CONTROL: a column that was NOT part of this migration must still reject NULL.
// Without it, "NULL is now accepted" could mean the whole table lost its
// constraints rather than the two columns intended.
let controlHeld = false;
try {
  db.prepare('INSERT INTO submissions (pu_code) VALUES (NULL)').run();
} catch {
  controlHeld = true;
}
console.log(`control (other NOT NULL columns still enforced): ${controlHeld ? 'ok' : 'FAILED'}`);

console.log(`\n${ok && controlHeld ? 'PASS — direct mode can now be enabled' : 'FAIL — inspect before proceeding'}`);
process.exit(ok && controlHeld ? 0 : 1);
