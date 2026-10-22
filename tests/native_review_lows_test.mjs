// THE NATIVE REVIEW'S TWO LOWS (docs/private/native-review-2026-10-19.md,
// "Not fixed"), pinned at the call sites with a mutated-copy CONTROL per rule:
//
//   (a) "Open settings" where location or photo access is off:
//       - report/result.tsx review step: a submit fix that failed for a reason
//         only the OS settings app fixes (describeFixFailure().settings) now
//         shows the same Open phone settings button the unit step has;
//       - report/incident.tsx: a refused photo library shows its message
//         beside Upload with an Open phone settings button (the old setLine
//         went to a footer line that is not on that step).
//   (b) report-screen English keyed: none of the old literals is left, and
//       every key those screens call exists in en/ha/ig/yo, translated. Also
//       the same copy on practice / map-unit, the result status word, the
//       picker's "rehearsal" tag, and the incident photo step's own status
//       line (shown under the tray now, not in a footer that step never draws).
//   (c) lib/outbox.ts — the native twin of web L5: dropReason() builds a
//       set-aside report's reason when shown (our line for the code, then the
//       server's hint, then outbox.refused); old stored reasons still show.
//   (d) ...and where it is SEEN: the report sheet (under "waiting to send")
//       lists set-aside reports with that reason until OK, the web's one
//       action on its drop alert. OK marks them seen and keeps the record.
//
//   node tests/native_review_lows_test.mjs
import fs from 'node:fs';
import { H, tally } from './helpers/harness.mjs';
import { fastTimers, loadNative } from './helpers/native-loader.mjs';

const { check, finish } = tally();
const read = (f) => fs.readFileSync(`${H}/native/src/${f}`, 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RULES = [
  ['app/report/result.tsx', 'a settings-only submit failure raises the flag',
    (s) => /const got = await trySubmitFix\(\);[\s\S]{0,300}setSubmitGpsSettings\(d\.settings\)/.test(code(s)),
    (s) => s.replace('setSubmitGpsSettings(d.settings)', 'void d.settings')],
  ['app/report/result.tsx', 'the review footer offers Open phone settings on that flag',
    (s) => /\{submitGpsSettings && !busy \? \(\s*<Pressable\s*onPress=\{\(\) => Linking\.openSettings\(\)\}[\s\S]{0,400}n\.app\.map-unit\.open-phone-settings/.test(code(s)),
    (s) => s.replace('{submitGpsSettings && !busy ? (', '{false ? (')],
  ['app/report/incident.tsx', 'a refused photo library raises the flag',
    (s) => /requestMediaLibraryPermissionsAsync\(\);[\s\S]{0,300}setLibDenied\(!perm\.granted\)/.test(code(s)),
    (s) => s.replace('setLibDenied(!perm.granted)', "setLine(i18nT('n.app.report.incident.allow-photo-access'))")],
  ['app/report/incident.tsx', 'the report step shows the message and Open phone settings on that flag',
    (s) => /\{libDenied && media\.length < MAX_MEDIA \? \([\s\S]{0,200}n\.app\.report\.incident\.allow-photo-access[\s\S]{0,200}Linking\.openSettings\(\)[\s\S]{0,300}n\.app\.map-unit\.open-phone-settings/.test(code(s)),
    (s) => s.replace('{libDenied && media.length < MAX_MEDIA ? (', '{false ? (')],
  ['app/report/incident.tsx', 'the gallery pick\'s status goes to the line drawn under the tray',
    (s) => {
      const c = code(s);
      const pick = c.slice(c.indexOf('const pickFromLibrary = async'), c.indexOf('const onSubmit = async'));
      return /setTrayLine\(res\.assets/.test(pick) && /setTrayLine\(notPrivate/.test(pick) && !/[^y]setLine\(/.test(pick)
        && /\{trayLine \? \(\s*<Text[^>]*>\{trayLine\}<\/Text>/.test(c);
    },
    (s) => s.replace('setTrayLine(res.assets', 'setLine(res.assets')],
  ['app/report/result.tsx', 'the result status is shown through its key, not upper-cased raw',
    (s) => /resultStatusLabel\(receipt\.result\.status\)\.toUpperCase\(\)/.test(code(s))
      && /reported: 'n\.app\.report\.result\.status-reported'[\s\S]{0,200}disputed: 'n\.app\.report\.result\.status-disputed'/.test(code(s)),
    (s) => s.replace('resultStatusLabel(receipt.result.status).toUpperCase()', 'receipt.result.status.toUpperCase()')],
];
for (const [file, label, rule, mutate] of RULES) {
  const s = read(file);
  check(`(a) ${file}: ${label}`, rule(s), true);
  check(`CONTROL: ${file}: the old shape is caught`, rule(mutate(s)), false);
}

// (b) The English that was hard-coded on the report screens.
const OLD = {
  'app/report/result.tsx': ["'Loading election…'", "'Election details unavailable'", 'read from the sheet', "' (one digit corrected)'",
    'Units already placed by observers', 'Submitting takes a GPS fix', "'Tap to copy.'", 'counts matched', 'That area is a ~'],
  'app/report/collation.tsx': ["'Loading election…'", "'Tap to copy.'", "'WAITING TO SEND'", "'NOT FILED'", 'See how collated figures', 'See the integrity checks'],
  'app/report/incident.tsx': ['Units already placed by observers', 'Filed under {unit.name}', 'Filed with the code {unit.pu_code}'],
  'components/capture-camera.tsx': ['does not have camera access', 'Camera access is off for Hawkeye', "setLine('Saving…')", "setLine('Compressing…')",
    'Confirming your location — a few seconds', 'No GPS fix — move near a window', 'Readable — {read', 'Read:{', 'max {VIDEO_MAX_S}s'],
  'components/no-election.tsx': ['No Active Election in {state}', 'No election is currently open'],
  'components/rekor-anchor.tsx': ["'practice chain'", "'This practice chain is in the public log'", 'exact chain head', 'Your run is chained', 'Your entry is on the ${thisChain}', 'No answer from the server'],
  'app/practice.tsx': ['· read from the sheet', "' (one digit corrected)'", 'Units already placed by observers'],
  'app/map-unit.tsx': ['Units already placed by observers'],
  'components/contest-picker.tsx': ["' · rehearsal'"],
  // The reason as one English string, built when the report was dropped.
  'lib/outbox.ts': ['async function refusal(res: Response): Promise<string>'],
};
const left = [];
for (const [file, lits] of Object.entries(OLD)) {
  const s = code(read(file));
  for (const l of lits) if (s.includes(l)) left.push(`${file}: ${l}`);
}
check('(b) no hard-coded English is left on the report screens', left, []);
check('CONTROL: an old literal put back is caught', code(read('app/report/collation.tsx') + "\n{'NOT FILED'}").includes("'NOT FILED'"), true);

const B = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(fs.readFileSync(`${H}/native/src/lib/i18n/${l}.json`, 'utf8'))]));
const called = new Set();
for (const file of Object.keys(OLD)) for (const m of read(file).matchAll(/i18nT\(\s*['"]([a-z0-9._-]+)['"]/g)) called.add(m[1]);
// Keys held in a map or a record rather than written inside i18nT(…).
for (const k of ['reported', 'verified', 'disputed', 'pending']) called.add(`n.app.report.result.status-${k}`);
called.add('n.lib.outbox.photos-gone');
// The report sheet's set-aside card (d).
for (const m of read('components/report-sheet.tsx').matchAll(/i18nT\(\s*['"]([a-z0-9._-]+)['"]/g)) called.add(m[1]);
const bad = [];
for (const k of called) for (const l of ['en', 'ha', 'ig', 'yo']) {
  const v = B[l][k];
  if (typeof v !== 'string' || v !== v.normalize('NFC') || (l !== 'en' && v === B.en[k] && /\p{L}/u.test(v.replace(/\{\w+\}/g, '')))) bad.push(`${l}:${k}`);
}
check(`(b) all ${called.size} keys these screens call are in en/ha/ig/yo, NFC, translated`, bad, []);

// (c) The SHIPPED lib/outbox.ts, run with its app imports stubbed (i18n
// returns the key; submit's errorLine answers only for bad_signature).
{
  fastTimers();
  const N = globalThis.__native;
  const O = await loadNative('lib/outbox.ts', {
    stub: ['@/lib/identity', '@/lib/i18n', '@/lib/evidence', '@/lib/submit', '@/lib/secure-store'],
  });
  N.errorLine = (c) => (c === 'bad_signature' ? '[our line]' : null);
  // Before the fix a drop was shown by its stored English `why`.
  const reason = (d) => (typeof O.dropReason === 'function' ? O.dropReason(d) : d.why);
  const sig = { why: 'Could not verify (bad_signature / HTTP 401)', status: 401, code: 'bad_signature', hint: 'Could not verify' };
  check('(c) a known code is explained by our own (translated) line, not the English hint',
    reason(sig), '[our line] (bad_signature / HTTP 401)');
  check('(c) no line of ours, no hint: outbox.refused, no "no code"',
    reason({ why: 'refused (no code / HTTP 400)', status: 400, code: null, hint: null }), 'outbox.refused (HTTP 400)');
  check('(c) our own reason (photos gone) is its key',
    reason({ why: 'the photos are no longer on this device', reasonKey: 'n.lib.outbox.photos-gone' }), 'n.lib.outbox.photos-gone');
  check('(c) CONTROL a code with no line of ours keeps the server hint',
    reason({ why: 'Too late (late_x / HTTP 400)', status: 400, code: 'late_x', hint: 'Too late' }), 'Too late (late_x / HTTP 400)');
  check('(c) CONTROL a drop stored before this change shows its stored reason',
    reason({ why: 'old reason (x / HTTP 400)' }), 'old reason (x / HTTP 400)');

  // A real flush: the drop is recorded with its parts, and `why` is unchanged.
  N.secure.set('hawkeye.auth.token', 'tok');
  const p = `${N.docs}/lows-B.jpg`;
  fs.writeFileSync(p, 'jpeg');
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'bad_signature', hint: 'Could not verify' }),
    { status: 401, headers: { 'content-type': 'application/json' } }));
  await O.queueJob({ kind: 'incident', body: { puCode: 'B' }, files: [{ field: 'media', uri: 'file://' + p, name: 'a.jpg', type: 'image/jpeg' }], label: 'B' });
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 3600e3;
  await O.flushOutbox();
  Date.now = realNow;
  const [d] = await O.listDropped();
  check('(c) a flush records the parts beside the English why',
    [d?.label, d?.why, d?.status, d?.code, d?.hint], ['B', 'Could not verify (bad_signature / HTTP 401)', 401, 'bad_signature', 'Could not verify']);

  // (d) WHERE IT IS SEEN: the report sheet lists set-aside reports until OK.
  const aside = () => (O.useOutbox().setAside || []).map((x) => x.label);
  const before = aside();
  check('(d) the drop is in the outbox state the report sheet reads', before, ['B']);
  if (typeof O.dismissSetAside === 'function') await O.dismissSetAside();
  check('(d) OK clears the list it showed', [before, aside()], [['B'], []]);
  const kept = await O.listDropped();
  check('(d) ...and keeps the record, marked seen (no delete, no resend)', [kept.length, kept[0]?.label, kept[0]?.seen], [1, 'B', true]);
}

// (d) The report sheet draws that list: one row per set-aside report, its
// reason through dropReason() inside the shared "was dropped" sentence, an
// OK that calls dismissSetAside(), and nothing at all when the list is empty.
{
  const SHEET = [
    ['the card is drawn only when there is something set aside',
      (s) => /\{asideShown\.length \? \(\s*<View className="[^"]*bg-bad/.test(code(s)),
      (s) => s.replace('{asideShown.length ? (', '{false ? (')],
    ['each row says it in the reader\'s language via dropReason()',
      (s) => /asideShown\.map\(\(d\) => \([\s\S]{0,400}i18nT\('n\.lib\.outbox\.a-queued-report-was-dropped', \{ v0: `\$\{d\.label\}: \$\{dropReason\(d\)\}` \}\)/.test(code(s)),
      (s) => s.replace('${dropReason(d)}', '${d.why}')],
    ['OK acknowledges through dismissSetAside()',
      (s) => /onPress=\{\(\) => \{ void dismissSetAside\(\); \}\}[\s\S]{0,200}i18nT\('common\.ok'\)/.test(code(s)),
      (s) => s.replace('void dismissSetAside();', 'void 0;')],
    ['the sheet grows to hold it',
      (s) => /asideShown\.length \? SET_ASIDE_PCT \+ asideShown\.length \* SET_ASIDE_ROW_PCT : 0/.test(code(s)),
      (s) => s.replace('asideShown.length ? SET_ASIDE_PCT', 'false ? SET_ASIDE_PCT')],
  ];
  const s = read('components/report-sheet.tsx');
  for (const [label, rule, mutate] of SHEET) {
    check(`(d) components/report-sheet.tsx: ${label}`, rule(s), true);
    check('CONTROL: the old shape is caught', rule(mutate(s)), false);
  }
}

finish();
