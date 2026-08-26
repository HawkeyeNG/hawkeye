/**
 * CLOSING A RACE — the follows it drops and the one alert it sends.
 *
 * A declared race is finished. Nothing more will be reported into it, so it
 * should stop being something anyone follows, and the people who followed it
 * should be told the result rather than left to notice the silence. Neither was
 * happening: an observer who followed Osun in August still had it in their
 * follow list nine days after INEC declared it, because a subscription row has
 * never had anything to expire against.
 *
 * WHY THIS IS SERVER-SIDE AND NOT THREE CLIENT FIXES. The follow list is one
 * table read through /api/observers/me, so deleting the row is the whole fix on
 * the website, in Lite and in the app at once. A client-side filter would have
 * been three implementations of the same rule, three chances to disagree, and
 * would have left the row in the database still collecting notifications.
 *
 * WHAT COUNTS AS CLOSED. backend/src/data/declarations.json — written by hand
 * from the returning officer's announcement, the same way the declared card on
 * a race page is (app/race.js). There is nothing to derive it from: IReV
 * publishes sheet images, never figures.
 *
 * EXACTLY ONCE. The closure is recorded in `race_closures`, so a restart
 * re-reads the same file and does nothing. That table is the reason this can be
 * safe to run on every boot.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { contestLabel, contests, db, scopeIsState } from '../db.js';
import { noteOnly } from './notifications.js';
import { sendToObserver } from './push.js';

// ---------------------------------------------------------------- the file ---

/**
 * Parsed declarations, or [] if the file is missing or malformed.
 *
 * FAILS EMPTY, DELIBERATELY. Every consumer of this list treats an entry as
 * "delete these subscriptions", so a half-parsed file must produce no entries
 * rather than partial ones. An empty list closes nothing, which is the safe
 * direction for a destructive operation.
 */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'declarations.json'), 'utf8'));
    const list = Array.isArray(raw?.declarations) ? raw.declarations : [];
    return list.filter((d) => d && typeof d.contest === 'string' && d.contest);
  } catch (e) {
    console.error('[declarations] not loaded —', e.message);
    return [];
  }
}

export const declarations = load();

/** `contest|scope` — the key `race_closures` and every lookup here agree on. */
const keyOf = (contest, scope) => `${contest}|${scope || ''}`;

/** How a declared race is named to people. Falls back to the contest catalogue. */
export const declarationLabel = (d) => d.label || contestLabel(d.contest);

/**
 * Does this declaration close the subscription (contest, state)?
 *
 * An entry with no scope closes the whole contest — right for a by-election,
 * which is one seat and is over when it is over. An entry WITH a scope takes
 * only rows naming that region, and leaves a whole-election row (state '')
 * alone: following all 36 governorships does not end because one of the 36 has
 * been declared.
 */
function covers(d, contest, state) {
  if (d.contest !== contest) return false;
  const scope = d.scope || '';
  return scope === '' ? true : (state || '') === scope;
}

/** Is this race finished? Used to stop offering Follow on it. */
export function isRaceClosed(contest, scope = '') {
  return declarations.some((d) => covers(d, contest, scope));
}

/**
 * The declarations as the clients read them (GET /api/declarations).
 *
 * The internal-only fields — `announce` and the note explaining it — are not
 * here: they are about how we ran the closure, not about the race.
 */
export function publicDeclarations() {
  return declarations.map((d) => ({
    contest: d.contest,
    scope: d.scope || '',
    label: declarationLabel(d),
    url: d.url || null,
    declaredOn: d.declaredOn || null,
    by: d.by || 'INEC',
    winner: d.winner || null,
    results: Array.isArray(d.results) ? d.results.slice(0, 3) : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
  }));
}

// ----------------------------------------------------------- the wording -----

/** 511067 -> "511,067", without depending on the runtime's ICU data. */
const group = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-08-16" -> "16 August 2026". Anything else comes back as given. */
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * THE DECLARED-RESULT ALERT. One template, so every race that is ever closed is
 * announced in the same words.
 *
 * The title names the race AND the winner, because this row sits in a feed of
 * "New <race> report" lines and has to be distinguishable at a glance — and
 * because a lock screen may show nothing else. It says "INEC declares", not
 * "wins": Hawkeye records a declaration, it does not certify a result, and the
 * one place that distinction can be lost is a headline written in our voice.
 *
 * The body leads with the numbers rather than a sentence about them. A push
 * body is truncated after a line or two on most phones, so the first line has
 * to be worth the space — the winner and their votes, not "INEC has announced
 * the result of the...". The top three are the ranking as declared; there is no
 * fourth, because a notification is not a results table and the race page is one
 * tap away.
 *
 * The last line explains the disappearance. Without it the follow list silently
 * loses a race and the reader is left to wonder whether something broke.
 *
 * Exported for tests/declarations_test.mjs and for the admin dry run, which
 * prints exactly what would be sent before anything is.
 */
export function declarationNote(d) {
  const label = declarationLabel(d);
  const w = d.winner || {};
  const by = d.by || 'INEC';
  const top = (Array.isArray(d.results) ? d.results : []).slice(0, 3);

  const lines = [];
  if (top.length) {
    top.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.name}${r.party ? ` (${r.party})` : ''} — ${group(r.votes)}`);
    });
  } else if (w.name) {
    lines.push(`${w.name}${w.party ? ` (${w.party})` : ''}${w.votes ? ` — ${group(w.votes)} votes` : ''}`);
  }
  lines.push(
    `Declared by ${by}${d.declaredOn ? ` on ${longDate(d.declaredOn)}` : ''}.`
    + ' This race is closed, so it has left your follow list.',
  );

  return {
    kind: 'declared',
    title: `${label}: ${by} declares ${w.name || 'the result'}`,
    body: lines.join('\n'),
    url: d.url || null,
  };
}

// ------------------------------------------------------------- the closing ---

/**
 * Apply every declaration that has not been applied yet.
 *
 * @param {object}  o
 * @param {boolean} o.dryRun  count and compose, change nothing, send nothing.
 * @param {Array}   o.entries the declarations to apply. Defaults to the file,
 *                  which is what every caller in the app passes. It is a
 *                  parameter so tests can exercise the ANNOUNCING path — every
 *                  entry in the file today is retrospective and announces
 *                  nothing, so without this the branch that actually reaches a
 *                  phone in September would never be run by anything.
 * @returns {Promise<Array>}  one report per entry, applied or not.
 *
 * Runs on boot and from POST /api/admin/close-races. Safe to call repeatedly:
 * an entry already in `race_closures` is skipped, which is what makes "on every
 * boot" a reasonable schedule for something that deletes rows and pushes to
 * phones.
 */
export async function applyDeclarations({ dryRun = false, entries = declarations } = {}) {
  const out = [];
  for (const d of entries) {
    const contest = d.contest;
    const scope = d.scope || '';
    const key = keyOf(contest, scope);
    const already = db.prepare('SELECT closed_at FROM race_closures WHERE key = ?').get(key);

    // The followers, read BEFORE the delete — after it there is nobody left to
    // tell. Active observers only: a suspended account is not pushed to, the
    // same rule notifySubscribers follows.
    const rows = scope
      ? db.prepare(`SELECT DISTINCT s.observer_id AS id FROM subscriptions s
           JOIN observers o ON o.id = s.observer_id AND o.status = 'active'
           WHERE s.contest = ? AND s.state = ?`).all(contest, scope)
      : db.prepare(`SELECT DISTINCT s.observer_id AS id FROM subscriptions s
           JOIN observers o ON o.id = s.observer_id AND o.status = 'active'
           WHERE s.contest = ?`).all(contest);
    const followers = rows.map((r) => r.id);
    const announce = d.announce !== false;
    const note = declarationNote(d);

    const report = {
      key,
      label: declarationLabel(d),
      followers: followers.length,
      announce,
      note,
      applied: false,
      skipped: already ? 'already closed' : dryRun ? 'dry run' : null,
    };
    out.push(report);
    if (already || dryRun) continue;

    // Delete and record together: a closure marked done whose subscriptions
    // survived would never be retried, and the follows would stay forever.
    const drop = db.transaction(() => {
      const del = scope
        ? db.prepare('DELETE FROM subscriptions WHERE contest = ? AND state = ?').run(contest, scope)
        : db.prepare('DELETE FROM subscriptions WHERE contest = ?').run(contest);
      db.prepare(`INSERT OR REPLACE INTO race_closures (key, contest, scope, closed_at, dropped, announced)
         VALUES (?, ?, ?, ?, ?, ?)`)
        .run(key, contest, scope, Date.now(), del.changes, announce ? followers.length : 0);
      return del.changes;
    });
    report.dropped = drop();
    report.applied = true;

    // The rows first — they are the durable half, and they land even if every
    // push fails. Then the phones, one at a time and never fatally: a device
    // that has uninstalled must not stop the next observer being told.
    if (announce) {
      for (const id of followers) {
        try { noteOnly(id, note); } catch { /* one bad row must not stop the fan-out */ }
      }
      for (const id of followers) {
        // eslint-disable-next-line no-await-in-loop
        await sendToObserver(id, { title: note.title, body: note.body, data: note.url ? { url: note.url } : {} })
          .catch(() => {});
      }
    }
    console.log(`[declarations] closed ${key} — ${report.dropped} follow(s) dropped, `
      + `${announce ? followers.length : 0} alert(s) sent`);
  }
  return out;
}

/**
 * Delete subscriptions naming a race that is not on the ballot any more.
 *
 * The safety net under applyDeclarations, for races that leave the catalogue
 * without a declaration ever being written — which is what actually happened to
 * Osun: contests.json was swapped for the 2027 set, GOV survived as a contest
 * and "Osun" quietly stopped being one of its states, so the row stayed valid
 * enough to keep appearing in a follow list for a race that no longer exists.
 *
 * SILENT ON PURPOSE. There is nothing to announce — no declaration was
 * recorded, so there is no result to carry — and a notification saying only
 * "this is gone" is worse than the row disappearing from a list nobody was
 * watching. The count is logged so it is visible in the boot output.
 *
 * NARROW ON PURPOSE. Only two rows are ever removed:
 *   - the contest code is not in the catalogue at all, or
 *   - the contest scopes by STATE (everything but SEN and REP, whose regions are
 *     districts and constituencies that contests.json does not list) and names a
 *     state that contest does not run in.
 * Anything it cannot be sure about it leaves, because a wrongly deleted follow
 * is invisible to the person who set it.
 */
export function pruneOrphanSubscriptions({ dryRun = false } = {}) {
  // A catalogue that failed to load would make every row look orphaned.
  if (!Array.isArray(contests) || !contests.length) return 0;
  const byCode = new Map(contests.map((c) => [c.code, c]));
  const rows = db.prepare('SELECT id, contest, state FROM subscriptions').all();
  const doomed = [];
  for (const r of rows) {
    const c = byCode.get(r.contest);
    if (!c) { doomed.push(r); continue; }
    if (!r.state || !scopeIsState(r.contest)) continue;
    if (!Array.isArray(c.states) || !c.states.length) continue;
    if (!c.states.includes(r.state)) doomed.push(r);
  }
  if (!doomed.length || dryRun) return doomed.length;
  const del = db.prepare('DELETE FROM subscriptions WHERE id = ?');
  db.transaction(() => doomed.forEach((r) => del.run(r.id)))();
  console.log(`[declarations] pruned ${doomed.length} follow(s) for races no longer on the ballot: `
    + [...new Set(doomed.map((r) => keyOf(r.contest, r.state)))].join(', '));
  return doomed.length;
}

/**
 * Both passes, in the order that matters: declared races announce, then the
 * leftovers go quietly. Never throws into the boot sequence.
 *
 * The dry run counts the prune as well as the declarations. It deletes rows,
 * even if it deletes them silently, and a preview that reported only half of
 * what a run would do would be a preview you learn not to trust.
 */
export async function closeFinishedRaces({ dryRun = false } = {}) {
  const applied = await applyDeclarations({ dryRun });
  const pruned = pruneOrphanSubscriptions({ dryRun });
  return { applied, pruned };
}
