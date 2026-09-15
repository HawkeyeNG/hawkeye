/**
 * Upload an .aab to a Google Play track, without the manual Console dance.
 *
 *   node scripts/play_upload.mjs --app native --track internal --notes-file tmp/notes.txt
 *   node scripts/play_upload.mjs --app lite   --track internal --dry-run
 *   node scripts/play_upload.mjs --app lite   --track production --rollout full
 *
 * WHY THIS EXISTS. The browser upload path caps at 10 MB and the native bundle
 * is 113 MB, so every release until now has been a hand upload. This is the
 * supported route: a service-account JWT exchanged for an access token, then
 * the Publisher API's edit flow.
 *
 * NO DEPENDENCIES ON PURPOSE. googleapis pulls a large tree for what is, here,
 * one signed JWT and four HTTPS calls. Node's own crypto signs RS256 fine, and
 * a release tool that cannot run because an install failed is worse than a
 * slightly longer file.
 *
 * THE KEY IS NEVER IN THE REPO. It is read from ~/hawkeye-secrets, which lives
 * outside the working tree exactly like the upload keystores — see
 * scripts/deploy_app.sh for the same rule applied to hosting credentials.
 *
 * WHAT IT WILL NOT DO. It only ever writes to the track you name, and it will
 * not touch production unless the rollout is stated explicitly — see the guard
 * below. The percentage is the one thing the Console shows and the API does
 * not, and it is not recoverable once people have the build.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_PATH = path.join(os.homedir(), 'hawkeye-secrets', 'play-publisher.json');
const APPS = {
  native: {
    pkg: 'ng.com.hawkeye.observer',
    aab: 'native/android/app/build/outputs/bundle/release/app-release.aab',
    lang: 'en-GB',            // native's default listing language
  },
  lite: {
    pkg: 'ng.com.hawkeye.lite',
    aab: 'mobile/android/app/build/outputs/bundle/release/app-release.aab',
    lang: 'en-US',            // Lite's differs — it is en-US, not en-GB.
  },                          // Getting this wrong applies the notes to nothing.
};
const ALLOWED_TRACKS = ['internal', 'alpha', 'beta', 'production'];

// ── args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') === false ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const appKey = args.app;
const track = args.track || 'internal';
const dryRun = !!args['dry-run'];

const die = (m) => { console.error(`\x1b[31mFAIL: ${m}\x1b[0m`); process.exit(1); };

if (!APPS[appKey]) die(`--app must be one of: ${Object.keys(APPS).join(', ')}`);
/**
 * PRODUCTION NEEDS THE ROLLOUT SAID OUT LOUD.
 *
 * This used to refuse production outright, and the reason was sound: the two
 * things the Console shows and the API does not are the rollout percentage and
 * any staged store-listing edits, and a release that silently went to 100% when
 * a staged rollout was intended cannot be taken back from the people who
 * already have it.
 *
 * Refusing did not answer that, it only moved it. So production is allowed when
 * the rollout is STATED — `--rollout full` or a fraction like `--rollout 0.1`
 * — which is the decision the guard existed to force somebody to make. There is
 * no default: omitting it still fails.
 *
 * The staged-listing half is a warning rather than a gate, because a listing
 * edit staged in the Console goes out with the next release whoever makes it,
 * from here or from the Console.
 */
const rollout = args.rollout;
if (track === 'production') {
  if (!rollout) {
    die('production needs --rollout: "full", or a fraction such as 0.1 for a staged '
      + 'release. The Console shows this and the API does not, so it has to be said here.');
  }
  if (rollout !== 'full' && !(Number(rollout) > 0 && Number(rollout) < 1)) {
    die(`--rollout must be "full" or a fraction between 0 and 1, not "${rollout}"`);
  }
  console.log('  NOTE    : any store-listing edit staged in the Console ships with this release.');
}
if (!ALLOWED_TRACKS.includes(track)) die(`--track must be one of: ${ALLOWED_TRACKS.join(', ')}`);

const app = APPS[appKey];
const aabPath = path.resolve(app.aab);
if (!fs.existsSync(aabPath)) die(`no bundle at ${app.aab} — build it first`);

/**
 * TWO WAYS TO AUTHENTICATE, and the keyless one is preferred.
 *
 * In GitHub Actions, google-github-actions/auth has already exchanged the
 * runner's OIDC token for a short-lived access token via Workload Identity
 * Federation, and hands it over in PLAY_ACCESS_TOKEN. Nothing long-lived
 * exists. That is the supported path here, because the organisation enforces
 * iam.disableServiceAccountKeyCreation and a downloadable key cannot be made.
 *
 * The key-file branch remains for a local run if that policy is ever relaxed.
 * It is the fallback, not the default, and it is deliberately second.
 */
const ENV_TOKEN = process.env.PLAY_ACCESS_TOKEN || '';
if (!ENV_TOKEN && !fs.existsSync(KEY_PATH)) {
  die('no credentials.\n'
    + '       In CI: the auth step should have set PLAY_ACCESS_TOKEN — check that\n'
    + '       the job has `permissions: id-token: write`, without which the OIDC\n'
    + '       token is never minted and auth fails with a misleading 403.\n'
    + `       Locally: a service-account key at ${KEY_PATH}, if org policy allows one.`);
}

const notes = args['notes-file'] ? fs.readFileSync(args['notes-file'], 'utf8').trim() : null;

// ── auth: sign a JWT, swap it for an access token ───────────────────────────
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64url');

async function accessToken() {
  // Federated token from the CI auth step — already scoped to androidpublisher.
  if (ENV_TOKEN) return ENV_TOKEN;
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  if (!key.client_email || !key.private_key) die('that key file is not a service-account JSON');
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = await res.json();
  if (!res.ok) die(`token exchange failed (${res.status}): ${JSON.stringify(j)}`);
  return j.access_token;
}

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

async function api(token, method, url, body, extraHeaders = {}, opts = {}) {
  /* A Node stream body needs duplex:'half'. Undici refuses it outright without
     one, and the message — "duplex option is required when sending a body" —
     names neither the stream nor the call that carried it. The .aab is streamed
     rather than buffered because the native bundle is 113 MB. Added only when
     the body IS a stream; the JSON calls pass strings.
     This is why no release ever went out through this path: it fails on the
     bundle upload, the one call that cannot be tested without a real edit. */
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    body,
    ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* upload returns no body sometimes */ }
  if (!res.ok) {
    /* SOFT MODE: hand the failure back instead of dying, so a caller can
       branch on it. Used by the commit, where one specific 400 is not an
       error but an instruction. Everything else still dies here. */
    if (opts.soft) return { __failed: true, status: res.status, text, json };
    // The commonest failure by far is the service account not yet invited in
    // Play Console, and Google's message for it is unhelpfully generic.
    const hint = res.status === 401 || res.status === 403
      ? '\n       Most likely: the service account has not been invited in Play Console ->'
        + '\n       Users and permissions, or lacks release permission on this app.'
      : '';
    die(`${method} ${url.replace(API, '')} -> ${res.status}\n       ${text.slice(0, 400)}${hint}`);
  }
  return json;
}

// ── the edit flow ───────────────────────────────────────────────────────────
const bytes = fs.statSync(aabPath).size;
console.log(`  app     : ${appKey} (${app.pkg})`);
console.log(`  bundle  : ${app.aab}  ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  track   : ${track}`);
console.log(`  notes   : ${notes ? `${notes.length} chars, ${app.lang}` : 'none'}`);
if (dryRun) { console.log('\n  --dry-run: stopping before any change is made.'); process.exit(0); }

const token = await accessToken();
console.log('  auth    : ok');

const edit = await api(token, 'POST', `${API}/${app.pkg}/edits`);
console.log(`  edit    : ${edit.id}`);

const up = await api(
  token, 'POST',
  `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${app.pkg}/edits/${edit.id}/bundles?uploadType=media`,
  fs.createReadStream(aabPath),
  { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) },
);
console.log(`  uploaded: versionCode ${up.versionCode}  sha1 ${up.sha1?.slice(0, 12)}…`);

await api(
  token, 'PUT',
  `${API}/${app.pkg}/edits/${edit.id}/tracks/${track}`,
  JSON.stringify({
    track,
    releases: [{
      versionCodes: [String(up.versionCode)],
      /* inProgress + userFraction is how Play models a staged rollout;
         completed means everyone. */
      ...(rollout && rollout !== 'full'
        ? { status: 'inProgress', userFraction: Number(rollout) }
        : { status: 'completed' }),
      ...(notes ? { releaseNotes: [{ language: app.lang, text: notes }] } : {}),
    }],
  }),
  { 'Content-Type': 'application/json' },
);
console.log(`  track   : ${track} set to versionCode ${up.versionCode}`);

/* PLAY DOES NOT ALWAYS ACCEPT A REVIEW SUBMISSION FROM THE API.

   A plain :commit can come back 400 INVALID_ARGUMENT with "Changes cannot
   be sent for review automatically. Please set the query parameter
   changesNotSentForReview to true." Play returns this when it will not let
   the API press Send for review for this app - after a policy rejection, for
   one. Lite versionCode 9 hit it on 2026-09-15: the bundle uploaded and the
   track was set, then the commit failed and took the whole edit with it, so
   nothing reached the Console at all.

   Retried WITH the parameter, the edit commits and the release is staged -
   but it is NOT in review until a human presses Send for review. That
   distinction is the whole point, so it is printed rather than glossed.

   Only this one message is retried. Any other failure still dies, or a real
   permission problem would be retried into a silent half-success. */
const COMMIT = `${API}/${app.pkg}/edits/${edit.id}:commit`;
let done = await api(token, 'POST', COMMIT, null, {}, { soft: true });
let inReview = true;
if (done && done.__failed) {
  const body = done.text || '';
  if (!body.includes('changesNotSentForReview')) {
    die(`POST edits:commit -> ${done.status} ${body.slice(0, 400)}`);
  }
  console.log('  commit  : Play refused to send for review automatically; staging instead');
  done = await api(token, 'POST', `${COMMIT}?changesNotSentForReview=true`);
  inReview = false;
}
console.log(`\n\x1b[32m  committed. edit ${done.id} is on ${track}.\x1b[0m`);
if (!inReview) {
  console.log('\x1b[33m  NOT IN REVIEW YET. Open Play Console -> Publishing overview'
    + ' and press "Send for review"; the release is staged and waiting.\x1b[0m');
}
console.log(track === 'production'
  ? `  Rollout: ${rollout === 'full' ? 'everyone' : Number(rollout) * 100 + '% of users'}. Google reviews it from here.`
  : '  Nothing was promoted beyond that track.');
