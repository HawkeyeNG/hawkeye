/**
 * Promote an ALREADY-UPLOADED, already-tested versionCode to production.
 * No build, no bundle upload: the exact binary testers ran is what ships.
 *
 *   node scripts/play_promote.mjs --app native --version-code 33 --dry-run
 *   node scripts/play_promote.mjs --app lite --version-code 25 --send-for-review
 *
 * Release notes come from NOTES_JSON, an object of { "<lang>": "<text>" }, so
 * no store copy has to live in the (public) tree. Every language must be one
 * the listing already has, the listing's default language is required, and
 * each text must fit Play's silent 500-character cut.
 *
 * WHY NOT play_upload.mjs. That script uploads a bundle it has just built. A
 * rebuild is a different binary from the one that was tested on a device,
 * whatever the commit says, and the versionCode would change with it.
 *
 * WHAT IT REFUSES, before anything is written:
 *  - a versionCode that is not on --from-track (default internal): the point is
 *    to ship the tested build, so it must be the one testers were served;
 *  - a versionCode not above what production already has (Play refuses later);
 *  - a production track holding anything but plain completed releases (a
 *    draft, halted or staged release would be silently replaced by the PUT).
 *
 * THE COMMIT. Exactly as play_upload.mjs: it first asks Play to STAGE the edit
 * (changesNotSentForReview=true), so a person sends it from Publishing
 * overview with every pending change on screen. Only if Play refuses staging
 * ("sent for review automatically") AND --send-for-review was given does it
 * commit plainly, which submits EVERY pending change on the app. Check
 * Publishing overview first; on 2026-09-16 a plain commit sent held, known-bad
 * releases for review.
 *
 * --dry-run reads everything, prints the release it would create, and deletes
 * its edit. Nothing changes on Play.
 */
import { pathToFileURL } from 'node:url';

export const PACKAGES = { native: 'ng.com.hawkeye.observer', lite: 'ng.com.hawkeye.lite' };
export const NOTES_MAX = 500;

/** Pure: check the notes against the listing. Returns { notes, problems }. */
export function checkNotes(raw, listingLangs, defaultLang) {
  const problems = [];
  let obj;
  try { obj = JSON.parse(raw || '{}'); } catch (e) { return { notes: [], problems: [`NOTES_JSON is not JSON: ${e.message}`] }; }
  const notes = [];
  for (const [language, value] of Object.entries(obj)) {
    const text = String(value).replace(/\r\n/g, '\n').trim();
    if (!listingLangs.includes(language)) problems.push(`${language}: the listing has no such language (has ${listingLangs.join(', ')})`);
    if (!text) problems.push(`${language}: empty`);
    if ([...text].length > NOTES_MAX) problems.push(`${language}: ${[...text].length} chars, Play keeps only the first ${NOTES_MAX}`);
    notes.push({ language, text });
  }
  if (!notes.some((n) => n.language === defaultLang)) problems.push(`no notes for the default language ${defaultLang}`);
  return { notes, problems };
}

/** Pure: is this production track safe to replace with one completed release? */
export function checkProduction(track, versionCode) {
  const problems = [];
  const releases = track?.releases || [];
  for (const r of releases) {
    if (r.status !== 'completed') {
      problems.push(`production holds a ${r.status} release (${r.name || '?'}: ${(r.versionCodes || []).join(',')}) that this would replace`);
    }
  }
  const highest = Math.max(0, ...releases.flatMap((r) => (r.versionCodes || []).map(Number)));
  if (versionCode <= highest) problems.push(`versionCode ${versionCode} is not above production's ${highest}`);
  return { problems, highest };
}

const die = (m) => { console.error(`\x1b[31mFAIL: ${m}\x1b[0m`); process.exit(1); };

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const appKey = arg('app');
  const versionCode = Number(arg('version-code'));
  const fromTrack = arg('from-track') || 'internal';
  const dryRun = argv.includes('--dry-run');
  const sendForReview = argv.includes('--send-for-review');
  const pkg = PACKAGES[appKey];
  if (!pkg) die(`--app must be one of: ${Object.keys(PACKAGES).join(', ')}`);
  if (!Number.isInteger(versionCode) || versionCode < 1) die('--version-code must be a positive integer');
  const token = process.env.PLAY_ACCESS_TOKEN;
  if (!token) die('PLAY_ACCESS_TOKEN is not set (run after the auth step)');

  const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
  const call = async (method, path, body, soft = false) => {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    if (!r.ok && !soft) die(`${method} ${path} -> ${r.status}\n       ${t.slice(0, 500)}`);
    return soft ? { ok: r.ok, status: r.status, text: t } : (t ? JSON.parse(t) : {});
  };
  const showTracks = (tracks) => {
    for (const t of tracks) {
      const rs = (t.releases || []).map((r) => `${r.name || '?'} [${r.status}${r.userFraction ? ` ${r.userFraction}` : ''}] vc ${(r.versionCodes || []).join(',') || '-'}`
        + ` notes:${(r.releaseNotes || []).map((n) => n.language).join(',') || '-'}`);
      console.log(`    ${t.track.padEnd(22)} ${rs.join(' | ') || '(empty)'}`);
    }
  };

  console.log(`  app        : ${appKey} (${pkg})`);
  console.log(`  promote    : versionCode ${versionCode}  ${fromTrack} -> production (full rollout)`);
  const edit = await call('POST', '/edits');
  console.log(`  edit       : ${edit.id}${dryRun ? '  (dry run, will be deleted)' : ''}`);
  const E = `/edits/${edit.id}`;

  const details = await call('GET', `${E}/details`);
  const listings = (await call('GET', `${E}/listings`)).listings || [];
  const langs = listings.map((l) => l.language);
  console.log(`  listing    : default ${details.defaultLanguage}; languages ${langs.join(', ')}`);

  const tracks = (await call('GET', `${E}/tracks`)).tracks || [];
  console.log('  tracks now :');
  showTracks(tracks);

  const problems = [];
  const src = tracks.find((t) => t.track === fromTrack);
  const srcRelease = (src?.releases || []).find((r) => (r.versionCodes || []).map(Number).includes(versionCode));
  if (!srcRelease) problems.push(`versionCode ${versionCode} is not on the ${fromTrack} track — not the tested build`);
  else console.log(`  tested     : ${fromTrack} release "${srcRelease.name}" [${srcRelease.status}]`);

  const bundles = (await call('GET', `${E}/bundles`)).bundles || [];
  if (!bundles.some((b) => Number(b.versionCode) === versionCode)) problems.push(`Play holds no bundle with versionCode ${versionCode}`);

  const prod = tracks.find((t) => t.track === 'production');
  const pc = checkProduction(prod, versionCode);
  problems.push(...pc.problems);
  console.log(`  production : highest versionCode now ${pc.highest}`);

  const { notes, problems: np } = checkNotes(process.env.NOTES_JSON, langs, details.defaultLanguage);
  problems.push(...np);
  for (const n of notes) console.log(`\n  notes ${n.language} (${[...n.text].length}/${NOTES_MAX}):\n${n.text.split('\n').map((l) => `    ${l}`).join('\n')}`);

  const release = {
    ...(srcRelease?.name ? { name: srcRelease.name } : {}),
    versionCodes: [String(versionCode)],
    status: 'completed',
    releaseNotes: notes,
  };
  console.log(`\n  production would become: ${JSON.stringify(release).slice(0, 200)}…`);

  if (problems.length) {
    await call('DELETE', E, null, true);
    die(`refusing:\n       - ${problems.join('\n       - ')}`);
  }
  if (dryRun) {
    await call('DELETE', E, null, true);
    console.log('\n  DRY RUN: edit deleted, nothing changed on Play.');
    return;
  }

  await call('PUT', `${E}/tracks/production`, { track: 'production', releases: [release] });
  console.log('  production track set in the edit');

  const commit = `${E}:commit`;
  const staged = await call('POST', `${commit}?changesNotSentForReview=true`, null, true);
  const autoReview = !staged.ok && staged.status === 400 && /sent for review automatically/i.test(staged.text);
  if (!staged.ok && !autoReview) die(`POST ${commit}?changesNotSentForReview=true -> ${staged.status}\n       ${staged.text.slice(0, 500)}`);
  if (staged.ok) {
    console.log('\n\x1b[33m  STAGED, NOT SENT FOR REVIEW. Play Console -> Publishing overview: check every'
      + ' pending change, then press Send for review.\x1b[0m');
  } else if (!sendForReview) {
    die('Play will not stage this edit (the app sends changes for review automatically).\n'
      + '       Nothing was committed. Check Publishing overview lists NO other pending change,\n'
      + '       then re-run with send_for_review.');
  } else {
    await call('POST', commit);
    console.log('\n\x1b[32m  COMMITTED and SENT FOR REVIEW (production, full rollout).\x1b[0m');
  }

  // Read back from a fresh edit, then throw that edit away.
  const check = await call('POST', '/edits');
  const after = (await call('GET', `/edits/${check.id}/tracks`)).tracks || [];
  console.log('  tracks after:');
  showTracks(after.filter((t) => ['production', fromTrack].includes(t.track)));
  await call('DELETE', `/edits/${check.id}`, null, true);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
