/**
 * Everything the SERVER sends an observer, in their language.
 *
 * Three things are worth testing here and one of them is not obvious:
 *
 *  1. The bundles agree with English — same keys, same placeholders. A
 *     placeholder dropped in translation produces a sentence with a hole in it
 *     that only that language's readers ever see.
 *  2. t() resolves, falls back and interpolates.
 *  3. THE FAN-OUT RESOLVES PER RECIPIENT. One event writes one notification row
 *     per saver, and those people do not share a language. This is the part a
 *     unit test of t() would miss entirely, so it runs against a real database
 *     with observers in three languages and reads the rows back.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';

/**
 * DB_PATH IS SET HERE, BEFORE ANY OTHER IMPORT, AND IT MATTERS.
 *
 * services/i18n.js imports db.js. Setting DB_PATH further down — after the
 * first `await import()` of anything that reaches it — opens the DEV database
 * instead, and this file then writes observers, saved units and notifications
 * into it. That is exactly what happened the first time it ran: four observers
 * and a fake polling unit landed in backend/storage/hawkeye.db and had to be
 * deleted by hand.
 *
 * The assertion below is the guard, not the comment: if db.js ever resolves to
 * anything but the temp file, this exits before writing a single row.
 */
process.env.DB_PATH = '/tmp/hawkeye_i18n_test.db';
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
const { config } = await import(path.join(ROOT, 'backend/src/config.js'));
if (config.dbPath !== process.env.DB_PATH) {
  console.log('FAIL  refusing to run: db path is ' + config.dbPath + ', not the temp file');
  process.exit(1);
}
const DIR = path.join(ROOT, 'backend/src/i18n');
const LANGS = ['ha', 'ig', 'yo'];

let fail = 0;
const check = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) { console.log('        got  ' + JSON.stringify(got)); fail++; }
};
const control = (name, wouldFail) => {
  console.log((wouldFail ? 'PASS  ' : 'FAIL  ') + 'CONTROL ' + name);
  if (!wouldFail) fail++;
};

// ------------------------------------------------------------ the bundles ---
console.log('=== bundles agree with English ===');
const load = (c) => { const j = JSON.parse(fs.readFileSync(path.join(DIR, c + '.json'), 'utf8')); delete j._meta; return j; };
const en = load('en');
const enKeys = Object.keys(en).sort();
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

for (const code of LANGS) {
  const b = load(code);
  check(code + ': same key set', Object.keys(b).sort(), enKeys);
  const mismatched = enKeys.filter((k) => JSON.stringify(holes(b[k])) !== JSON.stringify(holes(en[k])));
  check(code + ': every placeholder survives translation', mismatched, []);
  /* Legitimately identical: a string made only of placeholders and punctuation
     has no words to translate. Listed rather than pattern-matched, so adding a
     real English sentence to a bundle by mistake still fails. */
  const SAME_OK = ['note.case.resolved.body'];
  const same = enKeys.filter((k) => b[k] === en[k] && !SAME_OK.includes(k));
  check(code + ': nothing left as the English string', same, []);
  check(code + ': and the allowlisted ones really are wordless',
    SAME_OK.every((k) => !/[A-Za-z]{2}/.test(String(b[k]).replace(/\{\w+\}/g, ''))), true);
}
control('a bundle missing a placeholder must be caught',
  JSON.stringify(holes('Code: {code} in {mins} min')) !== JSON.stringify(holes('Code: {code}')));

// ------------------------------------------------------------------- t() ---
console.log('\n=== t() ===');
const { t, normalise, smsSegments } = await import(path.join(ROOT, 'backend/src/services/i18n.js'));
check('translates', t('ha', 'word.everywhere'), (s) => s && s !== 'everywhere');
check('interpolates', t('en', 'otp.code', { code: '123456', mins: 10 }),
  'Hawkeye code: 123456. Expires in 10 min. Never share it.');
check('falls back to English for an unknown language', t('zz', 'word.everywhere'), 'everywhere');
check('falls back to English for a key a bundle lacks', t('ha', 'no.such.key'), 'no.such.key');
check('a missing param leaves the braces visible, not a hole',
  t('en', 'otp.code', { code: '1' }), (s) => s.includes('{mins}'));
check('normalise rejects junk', [normalise('ha'), normalise('ha-NG'), normalise('fr'), normalise('')],
  ['ha', 'ha', null, null]);
check('GSM-7 detection: English OTP fits 160', smsSegments(t('en', 'otp.code', { code: '123456', mins: 10 })),
  (r) => r.gsm7 === true && r.perSegment === 160);
check('GSM-7 detection: Hausa OTP is UCS-2 at 70', smsSegments(t('ha', 'otp.code', { code: '123456', mins: 10 })),
  (r) => r.gsm7 === false && r.perSegment === 70);
control('the GSM-7 test must reject a hooked letter', smsSegments('ɓ').gsm7 === false);

// ------------------------------------------------- the fan-out, per person ---
console.log('\n=== one event, three languages ===');
const { db } = await import(path.join(ROOT, 'backend/src/db.js'));
check('the database under test is the temp one, not the dev database',
  db.name, process.env.DB_PATH);
const { noteUnitSavers } = await import(path.join(ROOT, 'backend/src/services/notifications.js'));

const PU = 'TEST-PU-0001';
db.prepare("INSERT OR IGNORE INTO polling_units (pu_code, name, ward, lga, state) VALUES (?, 'Test Unit', 'W', 'L', 'S')").run(PU);
const ids = {};
for (const [i, code] of ['en', ...LANGS].entries()) {
  const info = db.prepare("INSERT INTO observers (phone_hash, public_key_jwk, created_at, lang) VALUES (?, '{}', ?, ?)")
    .run('hash-' + code + '-' + i, Date.now(), code === 'en' ? null : code);
  ids[code] = info.lastInsertRowid;
  db.prepare('INSERT INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)').run(ids[code], PU, Date.now());
}
// NULL lang, not 'en' — an observer who signed up before any of this existed
// has not chosen anything, and must still get a readable notification.
check('one observer deliberately has NULL lang',
  db.prepare('SELECT lang FROM observers WHERE id = ?').get(ids.en).lang, null);

noteUnitSavers(PU, {
  kind: 'case',
  titleKey: 'note.case.open.title', bodyKey: 'note.case.open.body',
  params: { code: PU, contest: 'PRES' },
});

const rows = db.prepare('SELECT observer_id, title, body FROM notifications ORDER BY observer_id').all();
check('one row per saver', rows.length, 4);
const titleFor = (c) => rows.find((r) => r.observer_id === ids[c])?.title;
check('the English/NULL reader gets English', titleFor('en'), en['note.case.open.title']);
for (const code of LANGS) {
  const b = load(code);
  check(code + ' reader gets ' + code, titleFor(code), b['note.case.open.title']);
}
check('all four titles differ from each other', new Set(rows.map((r) => r.title)).size, 4);
check('the data in the body survives untranslated',
  rows.every((r) => r.body.includes(PU) && r.body.includes('PRES')), true);
control('the per-recipient check would fail if every row shared a title',
  new Set(rows.map(() => 'same')).size !== 4);

// A translated word nested inside a translated sentence.
db.prepare('DELETE FROM notifications').run();
const { pushNote } = await import(path.join(ROOT, 'backend/src/services/notifications.js'));
pushNote(ids.ha, {
  kind: 'case',
  titleKey: 'note.case.resolved.title', bodyKey: 'note.case.resolved.body',
  params: { code: PU, contest: 'PRES', sayKey: 'case.outcome.cleared' },
});
const nested = db.prepare('SELECT body FROM notifications WHERE observer_id = ?').get(ids.ha);
check('a *Key param is itself translated into the sentence',
  nested.body, (s) => s.includes(load('ha')['case.outcome.cleared']));
control('and it is not left as the key name', !nested.body.includes('case.outcome.cleared'));

db.close();
fs.rmSync(process.env.DB_PATH, { force: true });

console.log(fail ? '\n' + fail + ' FAILED' : '\nAll passed');
process.exitCode = fail ? 1 : 0;
