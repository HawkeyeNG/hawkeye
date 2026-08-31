/**
 * Upload an .aab to a Google Play track, without the manual Console dance.
 *
 *   node scripts/play_upload.mjs --app native --track internal --notes-file tmp/notes.txt
 *   node scripts/play_upload.mjs --app lite   --track internal --dry-run
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
 * WHAT IT WILL NOT DO. It only ever writes to the track you name, and it
 * refuses `production` outright. Promoting a build to production stays a human
 * decision made in the Console, where the rollout percentage and the staged
 * store-listing changes are visible.
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
const ALLOWED_TRACKS = ['internal', 'alpha', 'beta'];

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
if (track === 'production') {
  die('this tool refuses production. Promote in the Console, where the rollout '
    + 'percentage and any staged listing changes are visible.');
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

async function api(token, method, url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* upload returns no body sometimes */ }
  if (!res.ok) {
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
      status: 'completed',
      ...(notes ? { releaseNotes: [{ language: app.lang, text: notes }] } : {}),
    }],
  }),
  { 'Content-Type': 'application/json' },
);
console.log(`  track   : ${track} set to versionCode ${up.versionCode}`);

const done = await api(token, 'POST', `${API}/${app.pkg}/edits/${edit.id}:commit`);
console.log(`\n\x1b[32m  committed. edit ${done.id} is live on ${track}.\x1b[0m`);
console.log('  Nothing was promoted beyond that track.');
