/**
 * Drop NOT NULL from image_dhash / venue_image_dhash. Prerequisite for
 * UPLOAD_MODE=direct.
 *
 *   node scripts/migrate_dhash_nullable.mjs           # report only
 *   node scripts/migrate_dhash_nullable.mjs --apply
 *
 * The rebuild itself lives in src/db.js as migrateDhashNullable(), because the
 * production host has no shell and this script can never run there — boot has to
 * be able to do it too, guarded by UPLOAD_MODE=direct. One copy, two callers; a
 * duplicated table rebuild would drift.
 *
 * WHY THE COLUMNS MUST BE NULLABLE. In direct mode the origin never receives the
 * pixels, so it cannot compute a perceptual hash at submission time;
 * services/analysis-queue.js fills them in from the bucket moments later. A
 * client-supplied value was measured and cannot work: browser canvas vs sharp
 * over 24 real sheets gave zero exact matches, a median Hamming distance of 10
 * bits and a max of 16, against a near-duplicate threshold of 4.
 */
import { db, migrateDhashNullable, dhashColumnsNullable } from '../src/db.js';

const APPLY = process.argv.includes('--apply');

const state = db.prepare("SELECT name, `notnull` FROM pragma_table_info('submissions')").all()
  .filter((c) => ['image_dhash', 'venue_image_dhash'].includes(c.name));
console.log('current:', Object.fromEntries(state.map((c) => [c.name, c.notnull ? 'NOT NULL' : 'nullable'])));

if (dhashColumnsNullable()) {
  console.log('Already nullable. Nothing to do.');
  process.exit(0);
}

const rows = db.prepare('SELECT COUNT(*) c FROM submissions').get().c;
const indexes = db.prepare(
  "SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND tbl_name='submissions' AND sql IS NOT NULL").get().c;
console.log(`rows: ${rows}   indexes to recreate: ${indexes}`);

if (!APPLY) {
  console.log('\nDRY RUN. Re-run with --apply.');
  process.exit(0);
}

const verdict = migrateDhashNullable();
console.log('\nverdict:', JSON.stringify(verdict, null, 1));

// CONTROL: a column that was NOT part of this migration must still reject NULL.
// Without it, "NULL is now accepted" could mean the rebuild dropped every
// constraint rather than the two intended.
let controlHeld = false;
try { db.prepare('INSERT INTO submissions (pu_code) VALUES (NULL)').run(); } catch { controlHeld = true; }
console.log(`control (other NOT NULL columns still enforced): ${controlHeld ? 'ok' : 'FAILED'}`);

const ok = verdict.ok && controlHeld && dhashColumnsNullable();
console.log(`\n${ok ? 'PASS — direct mode can now be enabled' : 'FAIL — inspect before proceeding'}`);
process.exit(ok ? 0 : 1);
