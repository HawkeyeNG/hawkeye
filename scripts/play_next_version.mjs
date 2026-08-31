/**
 * Ask Play what the highest versionCode is, and set the next one.
 *
 *   node scripts/play_next_version.mjs --app lite            # report only
 *   node scripts/play_next_version.mjs --app lite --write    # write it in
 *
 * WHY THIS EXISTS. Every build must carry a versionCode above anything already
 * uploaded, and Play only says otherwise by rejecting the upload — after the
 * build has run. Guessing has gone wrong in both directions here: a number
 * reused, and numbers skipped for no reason.
 *
 * The honest source of truth is Play itself, and now that the publisher API is
 * reachable there is no reason to maintain that number by hand. This reads every
 * bundle Play holds — across ALL tracks, not just the one being published to,
 * because a code consumed on internal is consumed everywhere — and takes max + 1.
 *
 * WHERE IT WRITES. Native's versionCode lives in native/app.json (Expo, which
 * prebuild copies into gradle); Lite's lives directly in
 * mobile/android/app/build.gradle. Two apps, two files, two formats — hence the
 * read/write pair per app, exported so tests can exercise them without a token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPS = {
  native: {
    pkg: 'ng.com.hawkeye.observer',
    file: 'native/app.json',
    read: (s) => JSON.parse(s).expo.android.versionCode,
    write: (s, n) => s.replace(/("versionCode":\s*)\d+/, `$1${n}`),
  },
  lite: {
    pkg: 'ng.com.hawkeye.lite',
    file: 'mobile/android/app/build.gradle',
    read: (s) => Number(/^\s*versionCode\s+(\d+)/m.exec(s)?.[1]),
    write: (s, n) => s.replace(/^(\s*versionCode\s+)\d+/m, `$1${n}`),
  },
};

const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

async function main() {
  const argv = process.argv.slice(2);
  const appKey = argv[argv.indexOf('--app') + 1];
  const doWrite = argv.includes('--write');
  if (!APPS[appKey]) die(`--app must be one of: ${Object.keys(APPS).join(', ')}`);
  const app = APPS[appKey];

  const token = process.env.PLAY_ACCESS_TOKEN;
  if (!token) die('PLAY_ACCESS_TOKEN is not set — run this after the auth step');

  const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
  const call = async (method, url) => {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
    const t = await r.text();
    if (!r.ok) {
      // A bare "403 PERMISSION_DENIED" sends you looking in the wrong place. By
      // the time this runs the OIDC exchange has already succeeded — a token
      // exists — so the denial is Play's, not Google Cloud's, and it has exactly
      // three causes. Name them here rather than leaving it to be rediscovered.
      //
      // Note which error this is NOT: a disabled API answers with "has not been
      // used in project N before or it is disabled" plus an enable link. A plain
      // permission denial means the API is on and the grant is the problem.
      if (r.status === 403) {
        console.error('');
        console.error('Play refused this request, though authentication SUCCEEDED —');
        console.error('a token was minted, so Workload Identity Federation is fine.');
        console.error('The service account is not authorised in the PLAY CONSOLE.');
        console.error('');
        console.error(`  package        ${app.pkg}`);
        console.error('  service acct   hawkeye-play-publisher@hawkeye-503910.iam.gserviceaccount.com');
        console.error('');
        console.error('  Three things must all be true. Check in this order:');
        console.error('  1. Play Console -> Setup -> API access: the Google Cloud project');
        console.error('     hawkeye-503910 must be LINKED, and the service account listed there.');
        console.error('  2. Users and permissions: the service account email invited AND given');
        console.error('     "Release to testing tracks" — view-only permission cannot open an edit.');
        console.error('  3. The grant must cover THIS app. An account-level grant covers both;');
        console.error('     a per-app grant on one app leaves the other returning exactly this.');
        console.error('');
        console.error('  A fresh grant can take a few minutes to propagate.');
        console.error('');
      }
      die(`${method} ${url.replace(API, '')} -> ${r.status}\n       ${t.slice(0, 300)}`);
    }
    return t ? JSON.parse(t) : null;
  };

  // An edit is needed even to READ the bundle list. It is never committed, so
  // it expires on its own and changes nothing.
  const edit = await call('POST', `${API}/${app.pkg}/edits`);
  const list = await call('GET', `${API}/${app.pkg}/edits/${edit.id}/bundles`);
  const codes = (list?.bundles ?? []).map((b) => Number(b.versionCode)).filter(Number.isFinite);

  // An empty list is far more likely to mean "wrong package" or "permission
  // scoped to another app" than "nothing has ever been uploaded". Bumping from
  // an assumed zero would then collide with whatever is really there.
  if (!codes.length) die(`Play returned no bundles for ${app.pkg} — refusing to guess a version code`);

  const highest = Math.max(...codes);
  const next = highest + 1;
  const filePath = path.resolve(app.file);
  const src = fs.readFileSync(filePath, 'utf8');
  const current = app.read(src);

  console.log(`  app     : ${appKey} (${app.pkg})`);
  console.log(`  on Play : ${codes.slice().sort((a, b) => a - b).join(', ')}`);
  console.log(`  highest : ${highest}`);
  console.log(`  in file : ${current}   (${app.file})`);

  if (current > highest) {
    console.log(`\n  already above Play (${current} > ${highest}) — leaving it alone.`);
    console.log(`::notice::building versionCode ${current}`);
    return;
  }
  if (!doWrite) {
    console.log(`\n  would set it to ${next}  (pass --write to do it)`);
    return;
  }

  const out = app.write(src, next);
  if (out === src) die(`could not find a versionCode to replace in ${app.file}`);
  fs.writeFileSync(filePath, out);
  // Read it back rather than trust the replace — a regex that matched the wrong
  // thing, or nothing, would otherwise look exactly like success.
  const after = app.read(fs.readFileSync(filePath, 'utf8'));
  if (after !== next) die(`wrote ${app.file} but it reads back as ${after}, expected ${next}`);
  console.log(`\n  ${app.file} set to ${next}, and verified by reading it back.`);
  console.log(`::notice::versionCode bumped to ${next}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
